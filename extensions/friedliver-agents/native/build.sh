#!/bin/sh
# Builds the macOS dictation helper into ../bin/friedliver-dictate (or $1), ad-hoc signed.
# Info.plist is embedded (__TEXT,__info_plist): Speech checks the usage descriptions in-process.
# `build.sh --check` only type-checks (CI on every push).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ "${1:-}" = "--check" ]; then
	exec swiftc -swift-version 5 -typecheck "$here/friedliver-dictate.swift"
fi
out=${1:-"$here/../bin/friedliver-dictate"}
mkdir -p "$(dirname "$out")"
swiftc -swift-version 5 -O -target "$(uname -m)-apple-macos12" \
	-Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$here/Info.plist" \
	-o "$out" "$here/friedliver-dictate.swift"
chmod 755 "$out"
codesign --force --sign - --identifier com.friedliver.dictate "$out"
echo "built $out"
