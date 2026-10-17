// friedliver-dictate: on-device speech to text for the agents' composer mic (macOS).
//
// The Agents extension spawns this from inside FriedLiver.app, so macOS asks for microphone and
// speech recognition permission once, for FriedLiver. It listens to the default input and writes
// one JSON object per line on stdout:
//   {"partial":"…"}  the whole transcription so far (replaces the previous partial)
//   {"final":"…"}    the finished transcription (may be ""), then it exits 0
//   {"error":"…","code":"mic-denied|speech-denied|unavailable|audio|recognition"}, then it exits 1
// It stops on SIGTERM, SIGINT or stdin closing (the extension asked), after `--silence` seconds
// without new words, or after `--max` seconds.
//
// Args: --locale auto|<BCP-47, e.g. en-IN>   --silence <seconds, 2.5>   --max <seconds, 60>
// Build: native/build.sh (embeds Info.plist for the usage descriptions).

import AVFoundation
import Foundation
import Speech

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: String]) {
	guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
	print(line)
}

func fail(_ message: String, _ code: String) -> Never {
	emit(["error": message, "code": code])
	exit(1)
}

// ---- Arguments ----
var localeArg = "auto"
var silence = 2.5
var maxSeconds = 60.0
do {
	var args = CommandLine.arguments.dropFirst().makeIterator()
	while let flag = args.next() {
		let value = args.next() ?? ""
		switch flag {
		case "--locale": localeArg = value
		case "--silence": silence = min(max(Double(value) ?? 2.5, 0.5), 10)
		case "--max": maxSeconds = min(max(Double(value) ?? 60, 5), 300)
		default: break
		}
	}
}

let locale = localeArg == "auto" ? Locale.current : Locale(identifier: localeArg)
// ponytail: a locale Speech doesn't know falls back to US English rather than failing the click.
guard let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US")) else {
	fail("Speech recognition isn't available for \(locale.identifier).", "unavailable")
}

// ---- Permissions (each asks once; macOS remembers the answer for FriedLiver) ----
func speechAllowed() -> Bool {
	var status = SFSpeechRecognizer.authorizationStatus()
	if status == .notDetermined {
		let done = DispatchSemaphore(value: 0)
		SFSpeechRecognizer.requestAuthorization { status = $0; done.signal() }
		done.wait()
	}
	return status == .authorized
}

func micAllowed() -> Bool {
	var allowed = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
	if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
		let done = DispatchSemaphore(value: 0)
		AVCaptureDevice.requestAccess(for: .audio) { allowed = $0; done.signal() }
		done.wait()
	}
	return allowed
}

guard micAllowed() else { fail("FriedLiver isn't allowed to use the microphone.", "mic-denied") }
guard speechAllowed() else { fail("FriedLiver isn't allowed to use speech recognition.", "speech-denied") }
guard recognizer.isAvailable else { fail("Speech recognition isn't available right now.", "unavailable") }

// ---- Listening ----
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
// Private and offline whenever this Mac has the language on device; otherwise Apple's server does it.
if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
if #available(macOS 13, *) { request.addsPunctuation = true }

let engine = AVAudioEngine()
let input = engine.inputNode
let format = input.outputFormat(forBus: 0)
guard format.sampleRate > 0 else { fail("No microphone found.", "audio") }
input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in request.append(buffer) }
engine.prepare()
do { try engine.start() } catch { fail("The microphone didn't start: \(error.localizedDescription)", "audio") }

var text = ""
var stopping = false
var finished = false
var quietTimer: DispatchWorkItem?

func finish() {
	if finished { return }
	finished = true
	emit(["final": text])
	exit(0)
}

/// Stop listening, let the recognizer finish what it heard, then write the final text.
func stop() {
	if stopping { return }
	stopping = true
	engine.stop()
	input.removeTap(onBus: 0)
	request.endAudio()
	// The final result normally comes within a second; don't hang if it never does.
	DispatchQueue.main.asyncAfter(deadline: .now() + 2) { finish() }
}

/// Silence: no new words for `silence` seconds (a little longer before the first word).
func armQuietTimer(_ seconds: Double) {
	quietTimer?.cancel()
	let item = DispatchWorkItem { stop() }
	quietTimer = item
	DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: item)
}

let task = recognizer.recognitionTask(with: request) { result, error in
	DispatchQueue.main.async {
		if let result {
			let heard = result.bestTranscription.formattedString
			if heard != text {
				text = heard
				if !stopping { armQuietTimer(silence) }
			}
			if result.isFinal { finish() }
			else if !stopping { emit(["partial": text]) }
		}
		if let error, !finished {
			// "No speech detected" and cancellations after a stop end quietly with what was heard.
			if stopping || !text.isEmpty { finish() }
			let code = (error as NSError).code
			if code == 1110 || code == 216 || code == 301 { finish() }
			fail(error.localizedDescription, "recognition")
		}
	}
}
_ = task

armQuietTimer(max(silence + 3, 5))
DispatchQueue.main.asyncAfter(deadline: .now() + maxSeconds) { stop() }

// The extension stops us with SIGTERM or by closing stdin.
signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)
let sources = [SIGTERM, SIGINT].map { sig -> DispatchSourceSignal in
	let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
	source.setEventHandler { stop() }
	source.resume()
	return source
}
_ = sources
FileHandle.standardInput.readabilityHandler = { handle in
	if handle.availableData.isEmpty {
		handle.readabilityHandler = nil
		DispatchQueue.main.async { stop() }
	}
}

dispatchMain()
