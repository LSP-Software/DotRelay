#!/bin/sh
# Installs the DotRelay CLI (`dotrelay`) from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/LSP-Software/DotRelay/main/scripts/install.sh | sh
#
# Environment:
#   DOTRELAY_VERSION       release to install, such as 1.2.3 or v1.2.3-alpha.1
#                          (default: the latest stable release)
#   DOTRELAY_INSTALL_DIR   directory for the binary (default: ~/.local/bin)
#   DOTRELAY_DOWNLOAD_BASE releases URL to download from
#                          (default: https://github.com/LSP-Software/DotRelay/releases)
#
# The archive is checked against the release's SHA256SUMS before anything is
# installed. The script never uses root and sends nothing but the downloads.

set -eu

# Everything runs inside main, so a download cut short by the network never
# executes a partial script.
main() {
  base="${DOTRELAY_DOWNLOAD_BASE:-https://github.com/LSP-Software/DotRelay/releases}"
  base="${base%/}"

  need curl
  need tar
  need uname
  need mktemp

  platform="$(detect_platform)"
  arch="$(detect_arch "$platform")"

  if [ -n "${DOTRELAY_VERSION:-}" ]; then
    tag="v${DOTRELAY_VERSION#v}"
    valid_tag "$tag" || fail "DOTRELAY_VERSION must be a release version such as 1.2.3 or v1.2.3-alpha.1 (got ${DOTRELAY_VERSION})"
  else
    tag="$(latest_tag)"
  fi

  install_dir="${DOTRELAY_INSTALL_DIR:-}"
  if [ -z "$install_dir" ]; then
    [ -n "${HOME:-}" ] || fail "HOME is not set; set DOTRELAY_INSTALL_DIR to the directory for dotrelay"
    install_dir="$HOME/.local/bin"
  fi

  archive="dotrelay-${tag}-${platform}-${arch}.tar.gz"
  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t dotrelay)" || fail "could not create a temporary directory"
  trap 'rm -rf "$tmp"' EXIT
  trap 'rm -rf "$tmp"; exit 130' INT
  trap 'rm -rf "$tmp"; exit 143' TERM

  say "downloading dotrelay ${tag} for ${platform}-${arch}"
  download "${base}/download/${tag}/${archive}" "$tmp/$archive"
  download "${base}/download/${tag}/SHA256SUMS" "$tmp/SHA256SUMS"

  expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
  case "$expected" in
    "" | *[!0-9a-f]*) fail "SHA256SUMS for ${tag} has no valid checksum for ${archive}" ;;
  esac
  [ "${#expected}" -eq 64 ] || fail "SHA256SUMS for ${tag} has no valid checksum for ${archive}"
  actual="$(sha256 "$tmp/$archive")"
  if [ "$actual" != "$expected" ]; then
    fail "checksum mismatch for ${archive}: expected ${expected}, got ${actual}. Nothing was installed."
  fi
  say "verified SHA-256 ${actual}"

  mkdir "$tmp/extract"
  tar -xzf "$tmp/$archive" -C "$tmp/extract" || fail "could not extract ${archive}"
  if [ ! -f "$tmp/extract/dotrelay" ] || [ -L "$tmp/extract/dotrelay" ]; then
    fail "${archive} does not contain the dotrelay binary"
  fi

  mkdir -p "$install_dir" || fail "could not create ${install_dir}; set DOTRELAY_INSTALL_DIR to a directory you can write"
  # Copy beside the target, then rename over it, so a running dotrelay is
  # never overwritten in place.
  staged="$install_dir/.dotrelay.install.$$"
  cp "$tmp/extract/dotrelay" "$staged" || fail "could not write to ${install_dir}; set DOTRELAY_INSTALL_DIR to a directory you can write"
  chmod 755 "$staged"
  mv -f "$staged" "$install_dir/dotrelay" || {
    rm -f "$staged"
    fail "could not install ${install_dir}/dotrelay"
  }

  version="$("$install_dir/dotrelay" --version 2>/dev/null)" ||
    fail "installed ${install_dir}/dotrelay, but it does not run on this machine"
  say "installed dotrelay ${version} to ${install_dir}/dotrelay"

  case ":${PATH:-}:" in
    *":${install_dir}:"*) ;;
    *)
      say ""
      say "${install_dir} is not on your PATH. Add it to your shell profile"
      say "(~/.profile, ~/.bashrc, ~/.zshrc, or similar):"
      say ""
      say "  export PATH=\"${install_dir}:\$PATH\""
      ;;
  esac
}

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'dotrelay install: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "this installer needs '$1'; install it and try again"
}

valid_tag() {
  printf '%s\n' "$1" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'
}

detect_platform() {
  case "$(uname -s)" in
    Linux)
      # The Linux binaries link against glibc.
      if ldd --version 2>&1 | grep -qi musl || ls /lib/ld-musl-* >/dev/null 2>&1; then
        fail "this system uses musl libc; DotRelay's Linux binaries need glibc"
      fi
      echo linux
      ;;
    Darwin) echo darwin ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      fail "on Windows, run in PowerShell: irm https://raw.githubusercontent.com/LSP-Software/DotRelay/main/scripts/install.ps1 | iex"
      ;;
    *) fail "unsupported operating system: $(uname -s). See https://github.com/LSP-Software/DotRelay/releases" ;;
  esac
}

detect_arch() {
  machine="$(uname -m)"
  # A shell running under Rosetta reports x86_64 on Apple silicon.
  if [ "$1" = darwin ] && [ "$machine" = x86_64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    machine=arm64
  fi
  case "$machine" in
    x86_64 | amd64) echo x64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) fail "unsupported architecture: ${machine}. See https://github.com/LSP-Software/DotRelay/releases" ;;
  esac
}

# The latest stable release, from the tag GitHub redirects /releases/latest to.
latest_tag() {
  url="$(curl -fsSL --retry 3 -o /dev/null -w '%{url_effective}' "${base}/latest")" ||
    fail "could not reach ${base}/latest"
  found="${url##*/}"
  valid_tag "$found" ||
    fail "found no stable release at ${base}/latest. Set DOTRELAY_VERSION to install a prerelease, for example DOTRELAY_VERSION=v0.1.0-alpha.1"
  echo "$found"
}

download() {
  curl -fsSL --retry 3 -o "$2" "$1" || fail "download failed: $1"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail "this installer needs sha256sum or shasum to verify the download"
  fi
}

main "$@"
