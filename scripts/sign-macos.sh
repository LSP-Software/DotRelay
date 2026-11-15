#!/usr/bin/env bash
# Signs and notarizes the compiled macOS CLI binary in place.
#
# Required environment (GitHub secrets):
#   APPLE_DEVELOPER_ID_P12_BASE64   Developer ID Application certificate + key (.p12, base64)
#   APPLE_DEVELOPER_ID_P12_PASSWORD password for that .p12
#   APPLE_NOTARY_KEY_P8_BASE64      App Store Connect API key (.p8, base64)
#   APPLE_NOTARY_KEY_ID             its key ID
#   APPLE_NOTARY_ISSUER_ID          its issuer ID
#
# A bare Mach-O binary cannot carry a stapled ticket; Gatekeeper checks the
# notarization online the first time a quarantined copy runs.
set -euo pipefail

binary="${1:?usage: sign-macos.sh <binary>}"
work="$(mktemp -d)"
keychain="$work/signing.keychain-db"
keychain_password="$(uuidgen)"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

printf '%s' "$APPLE_DEVELOPER_ID_P12_BASE64" | base64 --decode >"$work/identity.p12"
printf '%s' "$APPLE_NOTARY_KEY_P8_BASE64" | base64 --decode >"$work/notary.p8"

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$work/identity.p12" -k "$keychain" -P "$APPLE_DEVELOPER_ID_P12_PASSWORD" \
  -T /usr/bin/codesign
security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')

identity="$(security find-identity -v -p codesigning "$keychain" |
  awk -F'"' '/Developer ID Application/ { print $2; exit }')"
if [[ -z "$identity" ]]; then
  echo "No Developer ID Application identity in APPLE_DEVELOPER_ID_P12_BASE64" >&2
  exit 1
fi

codesign --force --timestamp --options runtime \
  --entitlements "$(dirname "$0")/../ops/macos-entitlements.plist" \
  --keychain "$keychain" --sign "$identity" "$binary"
codesign --verify --strict --verbose=2 "$binary"

ditto -c -k --keepParent "$binary" "$work/notarize.zip"
xcrun notarytool submit "$work/notarize.zip" \
  --key "$work/notary.p8" --key-id "$APPLE_NOTARY_KEY_ID" \
  --issuer "$APPLE_NOTARY_ISSUER_ID" --wait --timeout 30m

# The signed binary must still run under the hardened runtime.
"$binary" --version
