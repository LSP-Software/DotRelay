"""Package built CLI bytes once into uniquely named deterministic archives."""
import gzip
import os
from pathlib import Path
import re
import tarfile
import zipfile


def package(root, tag):
    if not re.fullmatch(r"v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?", tag):
        raise ValueError("Strict release tag required")
    seen = set()
    for binary in sorted(Path(root).rglob("dotrelay*")):
        if binary.name not in ("dotrelay", "dotrelay.exe"):
            continue
        if binary.is_symlink() or not binary.is_file():
            raise ValueError("CLI must be a regular file")
        platform = binary.parent.name
        if not re.fullmatch(r"(?:linux|darwin|win32)-(?:x64|arm64)", platform) or platform in seen:
            raise ValueError("Invalid or duplicated CLI platform")
        seen.add(platform)
        archive = Path(root) / f"dotrelay-{tag}-{platform}"
        if platform.startswith("win32-"):
            with zipfile.ZipFile(str(archive) + ".zip", "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
                entry = zipfile.ZipInfo(binary.name, date_time=(1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = 0o100755 << 16
                entry.compress_type = zipfile.ZIP_DEFLATED
                output.writestr(entry, binary.read_bytes())
        else:
            with open(str(archive) + ".tar.gz", "wb") as destination:
                with gzip.GzipFile(filename="", mode="wb", fileobj=destination, mtime=0) as compressed:
                    with tarfile.open(fileobj=compressed, mode="w") as output:
                        entry = tarfile.TarInfo(binary.name)
                        entry.size = binary.stat().st_size
                        entry.mode = 0o755
                        with binary.open("rb") as source:
                            output.addfile(entry, source)
    if not all(any(item.startswith(prefix) for item in seen) for prefix in ("linux-", "darwin-", "win32-")):
        raise ValueError("Missing supported CLI platform")


if __name__ == "__main__":
    package("release-binaries", os.environ["RELEASE_TAG"])
