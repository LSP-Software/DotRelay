"""Install the immutable, integrity-verified official @oven Bun npm archives.

Two toolchains are pinned in ops/bun-toolchain.json: the stable runtime that
builds, tests and ships DotRelay, and a dated canary used only for `bun lint`.
Dated npm versions survive canary GitHub asset replacement. Never resolve a
moving npm tag. Fail closed on missing archives, changed bytes or wrong revision.
"""
import hashlib
import base64
import io
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import urllib.request
import urllib.error
from urllib.parse import urlsplit
import tarfile

lock = json.loads((Path(__file__).parent.parent / "ops/bun-toolchain.json").read_text())
system = {"Linux": "linux", "Darwin": "darwin", "Windows": "windows"}[platform.system()]
arch = "aarch64" if platform.machine().lower() in ("aarch64", "arm64") else "x64"
name = "bun.exe" if system == "windows" else "bun"


def install(toolchain):
    """Download, verify and unpack one pinned toolchain; return its directory."""
    asset = next(a for a in toolchain["assets"] if a["name"] == f"@oven/bun-{system}-{arch}")
    directory = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / ("dotrelay-bun-" + toolchain["commit"])
    directory.mkdir(parents=True, exist_ok=True)
    parsed = urlsplit(asset["url"])
    if parsed.scheme != "https" or parsed.hostname != "registry.npmjs.org" or parsed.username or parsed.password:
        raise RuntimeError("Unexpected toolchain archive origin")
    with urllib.request.urlopen(asset["url"], timeout=90) as response:
        if urlsplit(response.geturl()).hostname != "registry.npmjs.org":
            raise RuntimeError("Unexpected toolchain archive redirect")
        data = response.read()
    algorithm, expected = asset["integrity"].split("-", 1)
    if algorithm != "sha512" or base64.b64encode(hashlib.sha512(data).digest()).decode() != expected:
        raise RuntimeError("Bun archive integrity mismatch; refusing to execute")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        member = next(info for info in archive.getmembers() if Path(info.name).name == name and info.isfile())
        binary = directory / name
        source = archive.extractfile(member)
        if source is None:
            raise RuntimeError("Bun executable missing from archive")
        binary.write_bytes(source.read())
        binary.chmod(0o700)
    revision = subprocess.check_output([str(binary), "--revision"], text=True).strip()
    if revision != toolchain["revision"]:
        raise RuntimeError("Bun revision mismatch")
    bunx = directory / ("bunx.exe" if system == "windows" else "bunx")
    shutil.copyfile(binary, bunx)
    bunx.chmod(0o700)
    return directory, revision


# The stable runtime toolchain goes on PATH: it builds, tests and ships
# DotRelay. The canary is installed beside it only for `bun lint`, which
# scripts/lint.ts finds through DOTRELAY_LINT_BUN.
runtime, runtime_revision = install(lock)
lint, lint_revision = install(lock["lint"])
if os.environ.get("GITHUB_PATH"):
    with open(os.environ["GITHUB_PATH"], "a") as output:
        output.write(str(runtime) + "\n")
if os.environ.get("GITHUB_ENV"):
    with open(os.environ["GITHUB_ENV"], "a") as output:
        output.write("DOTRELAY_LINT_BUN=" + str(lint / name) + "\n")
print("Verified Bun " + runtime_revision + " at " + str(runtime))
print("Verified lint-only Bun " + lint_revision + " at " + str(lint / name))
