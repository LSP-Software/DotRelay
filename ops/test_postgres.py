import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("backup", Path(__file__).with_name("postgres.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class SafetyTests(unittest.TestCase):
    def test_credentials_are_environment_only_and_tls_options_preserved(self):
        env = backup.pg_environment("postgresql://user:s%40fe@host:5433/app?sslmode=verify-full&sslrootcert=/cert")
        self.assertEqual(env["PGPASSWORD"], "s@fe")
        self.assertEqual(env["PGSSLMODE"], "verify-full")
        self.assertEqual(env["PGSSLROOTCERT"], "/cert")
        for url in ["postgresql://host/postgres", "postgresql://host/", "https://host/app", "postgresql://host/app?unknown=true"]:
            with self.assertRaises(RuntimeError):
                backup.pg_environment(url)

    def test_restore_refuses_existing_data_before_running_restore(self):
        with patch.object(backup, "verify", return_value=b"archive"), patch.object(backup, "run", return_value=b"1") as run:
            with self.assertRaisesRegex(RuntimeError, "empty isolated"):
                backup.restore("backup.age", {"PGDATABASE": "target"}, "identity", "key")
            self.assertEqual(run.call_count, 1)

    def make_key(self, root):
        key = Path(root) / "backup.key"
        key.write_text("ab" * 32 + "\n")
        os.chmod(key, 0o600)
        return key

    def write_manifest(self, archive, key, sha256=None, mac=None):
        sha256 = sha256 or backup.checksum(archive)
        fields = {"version": 2, "sha256": sha256, "size": Path(archive).stat().st_size}
        manifest = dict(fields, mac=mac or backup.manifest_mac(backup.mac_key(key), fields))
        Path(str(archive) + ".json").write_text(json.dumps(manifest))

    def test_checksum_failure_never_decrypts_or_contacts_database(self):
        with tempfile.TemporaryDirectory() as root:
            key = self.make_key(root)
            archive = Path(root) / "backup.age"
            archive.write_bytes(b"corrupted")
            self.write_manifest(archive, key, sha256="0" * 64)
            with patch.object(backup, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "not authentic|checksum"):
                    backup.verify(archive, "identity", key)
                run.assert_not_called()

    def test_replaced_archive_with_matching_checksum_is_refused(self):
        # Someone who can write backup storage can replace the archive and
        # recompute its checksum, but cannot forge the manifest MAC.
        with tempfile.TemporaryDirectory() as root:
            key = self.make_key(root)
            archive = Path(root) / "backup.age"
            archive.write_bytes(b"attacker archive")
            self.write_manifest(archive, key, mac="00" * 32)
            with patch.object(backup, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "not authentic"):
                    backup.verify(archive, "identity", key)
                run.assert_not_called()

    def test_unauthenticated_legacy_manifest_is_refused_by_default(self):
        with tempfile.TemporaryDirectory() as root:
            key = self.make_key(root)
            archive = Path(root) / "backup.age"
            archive.write_bytes(b"legacy")
            Path(str(archive) + ".json").write_text(json.dumps({"version": 1, "sha256": backup.checksum(archive)}))
            with patch.object(backup, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "not authentic"):
                    backup.verify(archive, "identity", key)
                run.assert_not_called()

    def test_authentic_manifest_reaches_decryption(self):
        with tempfile.TemporaryDirectory() as root:
            key = self.make_key(root)
            identity = Path(root) / "identity"
            identity.write_text("AGE-SECRET-KEY-placeholder")
            os.chmod(identity, 0o600)
            archive = Path(root) / "backup.age"
            archive.write_bytes(b"genuine")
            self.write_manifest(archive, key)
            with patch.object(backup, "run") as run:
                backup.verify(archive, identity, key).close()
                self.assertEqual(run.call_args_list[0].args[0][0], "age")

    def test_mac_key_must_be_private_and_long_enough(self):
        with tempfile.TemporaryDirectory() as root:
            key = Path(root) / "backup.key"
            key.write_text("ab" * 32)
            os.chmod(key, 0o644)
            with self.assertRaises(RuntimeError):
                backup.mac_key(key)
            os.chmod(key, 0o600)
            key.write_text("short")
            with self.assertRaises(RuntimeError):
                backup.mac_key(key)

    def test_backup_never_overwrites_existing_archive(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "backup.age"
            archive.write_bytes(b"original")
            with self.assertRaises(FileExistsError):
                backup.backup(archive, {}, "recipient", "identity", self.make_key(root))
            self.assertEqual(archive.read_bytes(), b"original")


if __name__ == "__main__":
    unittest.main()
