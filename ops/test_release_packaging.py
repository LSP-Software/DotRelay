import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile
import tarfile

spec = importlib.util.spec_from_file_location("packaging", Path(__file__).parent.parent / "scripts/package-release.py")
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class PackagingTests(unittest.TestCase):
    def test_platforms_have_unique_archives_and_stable_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for platform in ("linux-x64", "darwin-arm64", "win32-x64"):
                folder = root / platform
                folder.mkdir()
                (folder / ("dotrelay.exe" if platform.startswith("win32") else "dotrelay")).write_bytes(platform.encode())
            packaging.package(root, "v1.2.3-alpha.1")
            archives = {p.name: p.read_bytes() for p in root.iterdir() if p.is_file()}
            self.assertEqual(len(archives), 3)
            packaging.package(root, "v1.2.3-alpha.1")
            self.assertEqual(archives, {p.name: p.read_bytes() for p in root.iterdir() if p.is_file()})
            with tarfile.open(root / "dotrelay-v1.2.3-alpha.1-linux-x64.tar.gz") as archive:
                self.assertEqual(archive.extractfile("dotrelay").read(), b"linux-x64")
                self.assertEqual(archive.getmember("dotrelay").mode, 0o755)
            with zipfile.ZipFile(root / "dotrelay-v1.2.3-alpha.1-win32-x64.zip") as archive:
                self.assertEqual(archive.read("dotrelay.exe"), b"win32-x64")


if __name__ == "__main__":
    unittest.main()
