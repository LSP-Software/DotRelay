"""Install the exact official Bun release asset; never resolve a moving tag.

Asset IDs and SHA-256 pins identify bytes independently of the canary alias.
Retain these archives in your artifact store for long-term offline rebuilding.
If upstream removes an asset, installation fails rather than upgrading silently.
"""
import hashlib
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
import zipfile

lock = json.loads((Path(__file__).parent.parent / "ops/bun-toolchain.json").read_text())
system = {"Linux": "linux", "Darwin": "darwin", "Windows": "windows"}[platform.system()]
arch = "aarch64" if platform.machine().lower() in ("aarch64", "arm64") else "x64"
asset = next(a for a in lock["assets"] if a["name"] == f"bun-{system}-{arch}.zip")
directory = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir())) / ("dotrelay-bun-" + lock["commit"])
directory.mkdir(parents=True, exist_ok=True)
headers = {"Accept": "application/octet-stream", "User-Agent": "DotRelay-toolchain"}
if os.environ.get("GITHUB_TOKEN"):
    headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
request = urllib.request.Request(f'https://api.github.com/repos/oven-sh/bun/releases/assets/{asset["id"]}', headers=headers)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, hdrs, newurl):
        return None
try:
    with urllib.request.build_opener(NoRedirect).open(request, timeout=90) as response:
        data = response.read()
except urllib.error.HTTPError as error:
    if error.code != 302:
        raise RuntimeError("Pinned Bun asset could not be downloaded") from None
    location = error.headers.get("Location", "")
    parsed = urlsplit(location)
    if parsed.scheme != "https" or parsed.hostname not in ("release-assets.githubusercontent.com", "objects.githubusercontent.com"):
        raise RuntimeError("Unexpected Bun asset redirect")
    # Never forward the GitHub credential across origins.
    with urllib.request.urlopen(location, timeout=90) as response:
        data = response.read()
if hashlib.sha256(data).hexdigest() != asset["sha256"]:
    raise RuntimeError("Bun archive checksum mismatch; refusing to execute")
name = "bun.exe" if system == "windows" else "bun"
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    member = next(info for info in archive.infolist() if Path(info.filename).name == name)
    binary = directory / name
    binary.write_bytes(archive.read(member))
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
