import importlib.util
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
                backup.restore("backup.age", {"PGDATABASE": "target"}, "identity")
            self.assertEqual(run.call_count, 1)

    def test_checksum_failure_never_decrypts_or_contacts_database(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "backup.age"
            archive.write_bytes(b"corrupted")
            Path(str(archive) + ".json").write_text('{"version":1,"sha256":"wrong"}')
            with patch.object(backup, "run") as run:
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    backup.verify(archive, "identity")
                run.assert_not_called()

    def test_backup_never_overwrites_existing_archive(self):
        with tempfile.TemporaryDirectory() as root:
            archive = Path(root) / "backup.age"
            archive.write_bytes(b"original")
            with self.assertRaises(FileExistsError):
                backup.backup(archive, {}, "recipient", "identity")
            self.assertEqual(archive.read_bytes(), b"original")


if __name__ == "__main__":
    unittest.main()
