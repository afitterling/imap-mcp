#!/usr/bin/env bash
# Builds NotesRelay.app (menu-bar only) into mac/NotesRelay/build/ and signs it ad hoc.
# macOS asks for Notes access (Automation) the first time the app reads a folder.
set -euo pipefail
cd "$(dirname "$0")/.."

swift build -c release --product NotesRelay
app=build/NotesRelay.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$(swift build -c release --show-bin-path)/NotesRelay" "$app/Contents/MacOS/NotesRelay"
cp Resources/Info.plist "$app/Contents/Info.plist"
# Hardened runtime needs the Apple Events entitlement to talk to Notes.
codesign --force --options runtime --entitlements Resources/NotesRelay.entitlements --sign "${SIGN_IDENTITY:--}" "$app"
codesign --verify --strict "$app"
echo "Built $app"
