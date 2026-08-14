#!/usr/bin/env bash
#
# Builds the on-device transcriber.
#
# Anna's owner has a language key and a voice key and nothing that does
# speech-to-text, so hearing has to come from the OS. `SFSpeechRecognizer` is
# Swift-only, which is why there is a compile step in a project that otherwise
# has none. See native/transcribe.swift for why it is a separate executable
# rather than a native Node addon.
#
# This runs from `npm run build`, so it has to stay quiet and non-fatal on a
# machine that cannot do the job — a contributor on Linux should still be able
# to build and test everything else. `--required` flips that: `dist:mac` must
# never produce a DMG with the helper silently missing, because the failure then
# lands on a user's Mac as "she cannot hear me" with no way to tell why.

set -euo pipefail

REQUIRED=0
[ "${1:-}" = "--required" ] && REQUIRED=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/native/transcribe.swift"
PLIST="$ROOT/native/Info.plist"
OUT_DIR="$ROOT/native/build"
OUT="$OUT_DIR/anna-transcribe"

skip() {
  if [ "$REQUIRED" = "1" ]; then
    echo "[native] $1" >&2
    exit 1
  fi
  echo "[native] skipped: $1"
  exit 0
}

[ "$(uname -s)" = "Darwin" ] || skip "on-device transcription is macOS only"
command -v swiftc >/dev/null 2>&1 || skip "swiftc not found (install the Xcode command line tools)"

mkdir -p "$OUT_DIR"

# macOS 13 is the floor: `supportsOnDeviceRecognition` and `addsPunctuation`
# both arrive there, and without the first one there is no way to tell "the
# offline model is missing" from "recognition failed", which is the difference
# between an instruction the user can act on and a shrug.
DEPLOYMENT_TARGET="13.0"

# Both architectures, because build.mac in package.json ships an arm64 *and* an
# x64 DMG. A helper built only for the host arch turns the other DMG into an app
# that launches, looks fine, and cannot hear — the worst kind of packaging bug,
# since it never reproduces on the machine that built it.
SLICES=()
for ARCH in arm64 x86_64; do
  SLICE="$OUT_DIR/anna-transcribe-$ARCH"
  # The Info.plist is *also* linked into __TEXT,__info_plist, not only copied
  # into the bundle below. TCC kills a process that touches speech recognition
  # with no usage description it can find, and the section is what keeps the
  # binary runnable when it is invoked directly rather than through the wrapper.
  swiftc -O \
    -target "$ARCH-apple-macos$DEPLOYMENT_TARGET" \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$PLIST" \
    -o "$SLICE" "$SRC"
  SLICES+=("$SLICE")
done

lipo -create -output "$OUT" "${SLICES[@]}"
rm -f "${SLICES[@]}"

# Wrap it in a real .app bundle.
#
# An embedded __info_plist section is documented as enough for a bare
# executable, and it is not: macOS still aborts the process with
#
#   "attempted to access privacy-sensitive data without a usage description"
#
# even with the section present (verified 1501 bytes at the right offset) and
# even signed with a real Developer identity. TCC attributes permissions to a
# bundle, so the helper ships as one. The binary inside is the same file; only
# the wrapper changes, and it costs two directories.
APP="$OUT_DIR/anna-transcribe.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$PLIST" "$APP/Contents/Info.plist"
mv "$OUT" "$APP/Contents/MacOS/anna-transcribe"
OUT="$APP/Contents/MacOS/anna-transcribe"

# Sign the *bundle*, not the executable inside it.
#
# Signing the inner Mach-O leaves the bundle unsigned, so nothing covers
# Contents/Info.plist and its usage descriptions can be edited after the fact —
# which is exactly the tampering TCC checks the signature to rule out.
# electron-builder re-signs everything later with the real identity; this ad-hoc
# signature is what makes a development build work.
codesign --force --sign - --identifier dev.anna.companion.transcribe "$APP"

# A bundle that macOS will not load is worth catching here, at the point the
# mistake was made, rather than as a mute companion on somebody's Mac.
codesign --verify --deep --strict "$APP"

echo "[native] built $APP ($(lipo -archs "$OUT"))"
