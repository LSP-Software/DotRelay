"""Check readiness, exact profile/suite, secure API routing and web health."""
import json
import os
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit


def get(origin, path, origin_header=None):
    headers = {"Accept": "application/json"}
    if origin_header:
        headers["Origin"] = origin_header
    request = urllib.request.Request(origin + path, headers=headers)
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.geturl() != origin + path:
            raise RuntimeError("Unexpected smoke-test redirect")
        return json.load(response)


def check(api, web, profile_id):
    if get(api, "/ready") != {"status": "ready"}:
        raise RuntimeError("Database is not ready")
    capabilities = get(api, "/api/v1/capabilities")
    if capabilities.get("serverProfileId") != profile_id or capabilities.get("suite", {}).get("name") != "dotrelay-e2ee-v3-classical-webcrypto":
        raise RuntimeError("Unexpected Server Profile or cryptographic suite")
    if get(web, "/api/health") != {"status": "ok"}:
        raise RuntimeError("Web health failed")
    try:
        get(api, "/api/v1/session", "https://untrusted.example")
    except urllib.error.HTTPError as error:
        if error.code != 403:
            raise RuntimeError("Unexpected origin-gate response") from None
    else:
        raise RuntimeError("API accepted an untrusted origin")


if __name__ == "__main__":
    api, web, profile_id = [os.environ[name] for name in ("SMOKE_API_ORIGIN", "SMOKE_WEB_ORIGIN", "SMOKE_SERVER_PROFILE_ID")]
    for origin in [api, web]:
        parsed = urlsplit(origin)
        if parsed.scheme != "https" or parsed.netloc != origin.removeprefix("https://"):
            raise RuntimeError("Smoke targets must be exact HTTPS origins")
    for attempt in range(12):
        try:
            check(api, web, profile_id)
            print("Deployment readiness, profile, suite, web and origin gates passed")
            break
        except Exception:
            if attempt == 11:
                raise SystemExit("Deployment smoke failed; keep traffic disabled (response details suppressed)")
            time.sleep(10)
