#!/bin/sh
# Builds the macOS helpers into ../bin (or the folder of $1), ad-hoc signed:
# - friedliver-dictate ($1 if given): the composer mic's speech helper. Info.plist is embedded
#   (__TEXT,__info_plist): Speech checks the usage descriptions in-process.
# - friedliver-fsevents: the project index's change journal (FSEvents history since an event id).
# `build.sh --check` only type-checks (CI on every push).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = "--check" ]; then
	swiftc -swift-version 5 -typecheck "$here/friedliver-dictate.swift"
	exec swiftc -swift-version 5 -typecheck "$here/friedliver-fsevents.swift"
fi
out=${1:-"$here/../bin/friedliver-dictate"}
mkdir -p "$(dirname "$out")"
swiftc -swift-version 5 -O -target "$(uname -m)-apple-macos12" \
	-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$here/Info.plist" \
	-o "$out" "$here/friedliver-dictate.swift"
chmod 755 "$out"
codesign --force --sign - --identifier com.friedliver.dictate "$out"
echo "built $out"
journal="$(dirname "$out")/friedliver-fsevents"
swiftc -swift-version 5 -O -target "$(uname -m)-apple-macos12" -o "$journal" "$here/friedliver-fsevents.swift"
chmod 755 "$journal"
codesign --force --sign - --identifier com.friedliver.fsevents "$journal"
echo "built $journal"
