"""Run Gitleaks, printing only safe redacted finding locations."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

with tempfile.TemporaryDirectory() as directory:
    report = Path(directory) / "findings.json"
    scope = "--all" if os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch" else "HEAD"
    result = subprocess.run(["/tmp/gitleaks", "git", "--redact", "--log-opts=--diff-merges=first-parent " + scope, "--report-format=json", "--report-path=" + str(report)])
    if report.exists():
        for finding in json.loads(report.read_text()):
            print(json.dumps({key: finding.get(key) for key in ["RuleID", "File", "StartLine", "Commit", "Fingerprint"]}))
    raise SystemExit(result.returncode)
