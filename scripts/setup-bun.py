"""Install an immutable, integrity-verified official @oven Bun npm archive.

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
asset = next(a for a in lock["assets"] if a["name"] == f"@oven/bun-{system}-{arch}")
directory = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / ("dotrelay-bun-" + lock["commit"])
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
name = "bun.exe" if system == "windows" else "bun"
with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
    member = next(info for info in archive.getmembers() if Path(info.name).name == name and info.isfile())
    binary = directory / name
    source = archive.extractfile(member)
    if source is None:
        raise RuntimeError("Bun executable missing from archive")
    binary.write_bytes(source.read())
    binary.chmod(0o700)
revision = subprocess.check_output([str(binary), "--revision"], text=True).strip()
if revision != lock["revision"]:
    raise RuntimeError("Bun revision mismatch")
shutil.copyfile(binary, directory / ("bunx.exe" if system == "windows" else "bunx"))
(directory / ("bunx.exe" if system == "windows" else "bunx")).chmod(0o700)
if os.environ.get("GITHUB_PATH"):
    with open(os.environ["GITHUB_PATH"], "a") as output:
        output.write(str(directory) + "\n")
print("Verified Bun " + revision)
