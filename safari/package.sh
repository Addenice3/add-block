#!/bin/bash
# Packages the Safari build on a Mac with Xcode installed.
#
#   safari/package.sh [output directory]      default: build/safari
#
# Needs nothing from npm: it only uses dist-safari/, which is committed.
#
# What it does:
#   1. Compiles dist-safari/content-blocker/blockerList.json and every
#      regexFilter of the rulesets with WebKit (safari/check.swift), so that
#      a selector or regex Safari rejects is found here, not after install.
#   2. First run: creates the Xcode project with Apple's
#      safari-web-extension-packager (falls back to the older
#      safari-web-extension-converter) from dist-safari/extension/, as a
#      macOS app named add-block with the placeholder bundle identifier
#      below; the extension files are copied into the project.
#      Later runs: copies the current dist-safari/extension/ files over the
#      project's copy, so a list update needs no new project.
#   3. Wires in the content blocker: if the project has the content blocker
#      target (added once in Xcode, README "Safari" step list), its
#      blockerList.json is replaced by ours. Otherwise the numbered steps to
#      add it are printed.
#
# Nothing here touches Safari itself. Building and installing is Xcode's
# job: README, "Safari".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SAFARI_DIST="$ROOT/dist-safari"
EXTENSION="$SAFARI_DIST/extension"
BLOCKER="$SAFARI_DIST/content-blocker/blockerList.json"
OUT="${1:-$ROOT/build/safari}"
APP_NAME="add-block"
# Placeholder. Replace with an identifier from your developer account before
# signing for distribution; for local testing any reverse-DNS name works.
BUNDLE_ID="${BUNDLE_ID:-com.example.add-block}"
# The content blocker target's name in Xcode (README step list).
BLOCKER_TARGET="add-block Hiding"
PROJECT_DIR="$OUT/$APP_NAME"

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'package.sh: %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = Darwin ] || die "this script needs macOS with Xcode"
[ -f "$EXTENSION/manifest.json" ] || die "missing $EXTENSION/manifest.json (run npm run build, or check out dist-safari/)"
[ -f "$BLOCKER" ] || die "missing $BLOCKER"
command -v xcrun >/dev/null || die "xcrun not found: install Xcode and its command line tools"

say "1/3 Compiling the content blocker and the regex rules with WebKit"
xcrun swift "$ROOT/safari/check.swift" "$SAFARI_DIST"

if [ -d "$PROJECT_DIR" ] && [ -n "$(find "$PROJECT_DIR" -maxdepth 1 -name '*.xcodeproj' -print -quit 2>/dev/null)" ]; then
  say "2/3 Updating the extension files in the existing project $PROJECT_DIR"
  RESOURCES="$(find "$PROJECT_DIR" -path '*/Resources/manifest.json' -print -quit)"
  [ -n "$RESOURCES" ] || die "no Resources/manifest.json under $PROJECT_DIR; delete the project directory to create it again"
  RESOURCES="$(dirname "$RESOURCES")"
  rm -rf "$RESOURCES"
  mkdir -p "$RESOURCES"
  cp -R "$EXTENSION/." "$RESOURCES/"
  echo "copied $EXTENSION -> $RESOURCES"
else
  say "2/3 Creating the Xcode project in $PROJECT_DIR"
  if xcrun --find safari-web-extension-packager >/dev/null 2>&1; then
    TOOL=safari-web-extension-packager
  elif xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
    TOOL=safari-web-extension-converter
  else
    die "neither safari-web-extension-packager nor safari-web-extension-converter found (xcrun --find); is Xcode selected with xcode-select?"
  fi
  mkdir -p "$OUT"
  xcrun "$TOOL" "$EXTENSION" \
    --project-location "$OUT" \
    --app-name "$APP_NAME" \
    --bundle-identifier "$BUNDLE_ID" \
    --swift --macos-only --copy-resources --no-open --no-prompt --force
  echo "The packager lists manifest keys Safari ignores (minimum_chrome_version is expected); nothing else should be listed."
fi

say "3/3 Content blocker"
# The content blocker target's own blockerList.json, not the copy of the
# extension files (which has none) and not ours.
TARGET_JSON="$(find "$PROJECT_DIR" -name blockerList.json -not -path '*/Resources/*' -print -quit 2>/dev/null || true)"
if [ -n "$TARGET_JSON" ]; then
  cp "$BLOCKER" "$TARGET_JSON"
  echo "copied $BLOCKER -> $TARGET_JSON"
  echo "After Product > Build, turn \"$BLOCKER_TARGET\" off and on in Safari > Settings > Extensions so Safari reloads its rules."
else
  cat <<EOF
The project has no content blocker target yet. Add it once in Xcode (this
cannot be scripted), then run this script again to copy blockerList.json in:

  1. open "$PROJECT_DIR/$APP_NAME.xcodeproj"
  2. File > New > Target…, choose macOS > Content Blocker Extension, Next.
  3. Product Name: $BLOCKER_TARGET  (keep the team, language and bundle
     identifier Xcode proposes), Finish. If Xcode asks to activate the new
     scheme, click Cancel: the app scheme builds everything.
  4. In the project navigator the new folder "$BLOCKER_TARGET" holds
     blockerList.json (a sample). Replace its contents with
     $BLOCKER
     or run safari/package.sh again, which copies it over.

Then follow the README, "Safari", from the signing step.
EOF
fi
