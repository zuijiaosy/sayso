#!/usr/bin/env bash
# Signs macOS builds with the shared self-signed "Sayso Release" certificate.
#
# macOS ties Microphone, Accessibility and Input Monitoring grants to the app's
# designated requirement. An ad-hoc signature's requirement is its cdhash, which
# changes with every build, so each update looked like a new app and lost its
# permissions. Signing every build with one certificate pins the requirement to
# `identifier "com.sayso.desktop" and certificate leaf = <this cert>`, so an
# update installs over the old copy and keeps its permissions.
#
# tauri-bundler only imports Apple-issued certificates from APPLE_CERTIFICATE,
# so this script imports the .p12 into a throwaway keychain itself and hands
# Tauri the certificate's SHA-1 through APPLE_SIGNING_IDENTITY.
#
#   scripts/macos-signing.sh bun run tauri build      # local: wrap a build
#   scripts/macos-signing.sh --github-env             # CI: export for later steps
#
# The certificate is read from SIGNING_P12 (default ~/.sayso-signing/sayso.p12),
# its password from SIGNING_P12_PASSWORD or p12-password.txt next to it. It is
# never committed; CI gets it from the SAYSO_SIGNING_P12 secret (base64).
set -euo pipefail

P12="${SIGNING_P12:-$HOME/.sayso-signing/sayso.p12}"
[ -f "$P12" ] || { echo "signing certificate not found: $P12" >&2; exit 1; }
P12_PASSWORD="${SIGNING_P12_PASSWORD:-$(cat "$(dirname "$P12")/p12-password.txt" 2>/dev/null || true)}"

KC_DIR="$(mktemp -d)"
KC="$KC_DIR/sayso-signing.keychain-db"
KC_PASSWORD="$(uuidgen)"

OLD_KEYCHAINS=()
while IFS= read -r line; do
  line="${line#"${line%%[![:space:]]*}"}"; line="${line%\"}"; line="${line#\"}"
  [ -n "$line" ] && OLD_KEYCHAINS+=("$line")
done < <(security list-keychains -d user)

restore() {
  security list-keychains -d user -s ${OLD_KEYCHAINS[@]+"${OLD_KEYCHAINS[@]}"}
  security delete-keychain "$KC" 2>/dev/null || true
  rm -rf "$KC_DIR"
}

security create-keychain -p "$KC_PASSWORD" "$KC"
security unlock-keychain -p "$KC_PASSWORD" "$KC"
security set-keychain-settings -lut 21600 "$KC"
security import "$P12" -k "$KC" -P "$P12_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PASSWORD" "$KC" >/dev/null
# codesign only looks at keychains on the search list.
security list-keychains -d user -s "$KC" ${OLD_KEYCHAINS[@]+"${OLD_KEYCHAINS[@]}"}

# The self-signed certificate isn't trusted, so it only shows up without -v;
# sign by hash rather than by name.
IDENTITY="$(security find-identity -p codesigning "$KC" | awk '/"Sayso Release"/ {print $2; exit}')"
if [ -z "$IDENTITY" ]; then
  restore
  echo "no \"Sayso Release\" identity in $P12" >&2
  exit 1
fi
echo "Signing with \"Sayso Release\" ($IDENTITY)"

if [ "${1:-}" = "--github-env" ]; then
  # The runner is discarded after the job, so the keychain stays for the build.
  echo "APPLE_SIGNING_IDENTITY=$IDENTITY" >> "$GITHUB_ENV"
  exit 0
fi

[ $# -gt 0 ] || { restore; echo "usage: $0 <build command…> | --github-env" >&2; exit 2; }
trap restore EXIT
APPLE_SIGNING_IDENTITY="$IDENTITY" "$@"
