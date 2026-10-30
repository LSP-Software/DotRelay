import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("smoke", Path(__file__).parent.parent / "scripts/smoke-deployment.py")
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class SmokeTests(unittest.TestCase):
    def test_wrong_profile_or_suite_is_never_healthy(self):
        for doc in [{"serverProfileId": "other", "suite": {"name": "dotrelay-e2ee-v3-classical-webcrypto"}}, {"serverProfileId": "expected", "suite": {"name": "wrong"}}]:
            with patch.object(smoke, "get", side_effect=[{"status": "ready"}, doc]):
                with self.assertRaisesRegex(RuntimeError, "Server Profile"):
                    smoke.check("https://api.example", "https://web.example", "expected")

    def test_liveness_does_not_substitute_for_database_readiness(self):
        with patch.object(smoke, "get", return_value={"status": "ok"}):
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                smoke.check("https://api.example", "https://web.example", "expected")


if __name__ == "__main__":
    unittest.main()
