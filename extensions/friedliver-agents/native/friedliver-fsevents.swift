// The project index's change journal on macOS: what FSEvents recorded under a folder since an
// event id, so a reopened index re-checks only those paths instead of every file.
//
//   friedliver-fsevents <real folder path> now          the volume's journal id and the current event id
//   friedliver-fsevents <real folder path> since <id>   the same, then every event since <id>, then END
//
// Output is NUL-separated records: `uuid=<volume journal UUID>`, `now=<event id>`, then
// `E<flags hex> <absolute path>` per event, then `END` once FSEvents says its history is done.
// `now` is read before the history, so it is a safe place to start next time. No END (timeout,
// error) means the history is incomplete: the caller checks every file instead.
import CoreServices
import Foundation

func record(_ s: String) {
  FileHandle.standardOutput.write(Data((s + "\u{0}").utf8))
}

let args = CommandLine.arguments
guard args.count >= 3, args[2] == "now" || (args[2] == "since" && args.count == 4) else {
  FileHandle.standardError.write(Data("usage: friedliver-fsevents <folder> now | since <event id>\n".utf8))
  exit(2)
}
let root = args[1]
var st = stat()
guard stat(root, &st) == 0 else { exit(3) }
// No UUID: the volume keeps no event history (network, read-only, or journaling off).
guard let uuidRef = FSEventsCopyUUIDForDevice(st.st_dev) else { exit(4) }
let uuid = CFUUIDCreateString(nil, uuidRef) as String
record("uuid=\(uuid)")
record("now=\(FSEventsGetCurrentEventId())")
if args[2] == "now" { exit(0) }
guard let since = UInt64(args[3]) else { exit(2) }

let callback: FSEventStreamCallback = { _, _, count, paths, flags, _ in
  let list = unsafeBitCast(paths, to: NSArray.self)
  for i in 0..<count {
    let f = flags[i]
    if f & UInt32(kFSEventStreamEventFlagHistoryDone) != 0 {
      record("END")
      exit(0)
    }
    if let p = list[i] as? String { record("E\(String(f, radix: 16)) \(p)") }
  }
}
let flags = UInt32(kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)
guard let stream = FSEventStreamCreate(nil, callback, nil, [root] as CFArray, since, 0, flags) else { exit(5) }
FSEventStreamSetDispatchQueue(stream, DispatchQueue.main)
guard FSEventStreamStart(stream) else { exit(6) }
// A history that never finishes is no history.
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { exit(7) }
dispatchMain()
