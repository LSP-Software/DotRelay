import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ALERTS = ROOT / "ops" / "alerts"
RULES = ALERTS / "dotrelay.rules.yml"


class AlertRulesTest(unittest.TestCase):
    def test_rules_reference_only_exported_metrics_and_events(self):
        rules = RULES.read_text()
        metrics = (ROOT / "apps" / "api" / "src" / "metrics.ts").read_text()
        events = (ROOT / "apps" / "api" / "src" / "observability.ts").read_text()
        for name in set(re.findall(r"\bdotrelay_[a-z_]+", rules)):
            base = re.sub(r"_(bucket|sum|count)$", "", name)
            self.assertIn(f'"{base}"', metrics, name)
        for name in set(re.findall(r'event_name="([^"]+)"', rules)):
            self.assertIn(f'"{name}"', events, name)
        for name in (
            "DotRelayRetentionFailed",
            "DotRelayRateLimitRefusalsSpike",
            "DotRelayRateLimitUnavailable",
            "DotRelayNotReady",
            "DotRelayHigh5xxRatio",
        ):
            self.assertIn(f"alert: {name}\n", rules)

    @unittest.skipUnless(shutil.which("promtool"), "promtool is not installed")
    def test_promtool_checks_and_unit_tests(self):
        subprocess.run(["promtool", "check", "rules", str(RULES)], check=True)
        subprocess.run(
            ["promtool", "test", "rules", "dotrelay.rules.test.yml"],
            cwd=ALERTS,
            check=True,
        )


if __name__ == "__main__":
    unittest.main()
