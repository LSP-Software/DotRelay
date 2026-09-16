#!/usr/bin/env python3
"""Trigger Coolify deploys for DotRelay apps and wait for completion.

Usage:
  scripts/coolify-deploy.py --environment dev  [app names...]
  scripts/coolify-deploy.py --environment production

App selection: by name within the environment's project:
  dev        -> project "DotRelay-Dev"    apps "DotRelay API (Dev)", "DotRelay Web (Dev)"
  production -> project "DotRelay"        apps "DotRelay API", "DotRelay Web"
Passing explicit app names overrides the defaults for the environment.

Required environment variables:
  COOLIFY_ENDPOINT  e.g. https://app.coolify.io
  COOLIFY_TOKEN     API token with `deploy` permission (and read for apps/deployments)

Exit code 0 only when every triggered app reaches the `finished` status.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

TERMINAL_OK = {"finished"}
TERMINAL_BAD = {"failed", "canceled", "cancelled", "stopped"}
ENVIRONMENTS = {
    "dev": ["DotRelay API (Dev)", "DotRelay Web (Dev)"],
    "production": ["DotRelay API", "DotRelay Web"],
}


def api(method, path, token, endpoint, payload=None):
    url = endpoint.rstrip("/") + path
    data = None
    # Explicit User-Agent: Coolify sits behind Cloudflare, which rejects the
    # default python-urllib UA (error 1010).
    headers = {"Authorization": f"Bearer {token}", "User-Agent": "dotrelay-ci/1.0"}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = resp.read().decode()
            code = resp.status
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        code = e.code
    if code >= 300:
        raise RuntimeError(f"{method} {path} -> {code}: {body[:500]}")
    return json.loads(body) if body else None


def find_apps_by_name(endpoint, token, wanted):
    """Resolve wanted app names to UUIDs.

    The application list entries carry no project field, so resolution is
    by exact name; the DotRelay app names are unique instance-wide
    (distinct project/environment suffixes).
    """
    apps = api("GET", "/api/v1/applications", token, endpoint) or []
    apps = [a for a in apps if not a.get("deleted_at")]
    found = {}
    for name in wanted:
        matches = [a for a in apps if a.get("name") == name]
        if not matches:
            raise RuntimeError(f"application {name!r} not found")
        if len(matches) > 1:
            raise RuntimeError(f"application name {name!r} is ambiguous: {len(matches)} matches")
        found[name] = matches[0]["uuid"]
    return found


def trigger_deploy(endpoint, token, app_uuid):
    # POST /api/v1/deploy?uuid= (no body, mirroring the Coolify provider).
    resp = api("POST", f"/api/v1/deploy?uuid={app_uuid}", token, endpoint)
    deployments = (resp or {}).get("deployments") or []
    for item in deployments:
        if item.get("deployment_uuid"):
            return item["deployment_uuid"]
    return None


def app_deployment_uuids(endpoint, token, app_uuid):
    resp = api("GET", f"/api/v1/deployments/applications/{app_uuid}", token, endpoint)
    if isinstance(resp, dict):
        resp = resp.get("deployments") or []
    elif resp is None:
        resp = []
    return resp


def pick_in_flight_or_latest(deployments):
    for d in deployments:
        if (d.get("status") or "").lower() in IN_FLIGHT and d.get("deployment_uuid"):
            return d
    for d in deployments:
        if d.get("deployment_uuid"):
            return d
    return None


def wait_for_deployment(endpoint, token, deployment_uuid, timeout_s=2700):
    deadline = time.monotonic() + timeout_s
    last = None
    while time.monotonic() < deadline:
        d = api("GET", f"/api/v1/deployments/{deployment_uuid}", token, endpoint) or {}
        status = (d.get("status") or "").lower()
        last = status
        if status in TERMINAL_OK:
            return status
        if status in TERMINAL_BAD:
            logs = d.get("logs")
            if isinstance(logs, str):
                logs = logs[-1500:]
            if logs:
                print(logs, file=sys.stderr)
            raise RuntimeError(f"deployment {deployment_uuid} ended with status {status!r}")
        time.sleep(10)
    raise TimeoutError(f"deployment {deployment_uuid} still {last!r} after {timeout_s}s")


def deploy_app(endpoint, token, app_uuid):
    deployment_uuid = trigger_deploy(endpoint, token, app_uuid)
    if not deployment_uuid:
        # Coolify may omit deployment_uuid when it skips a duplicate queue
        # entry; fall back to the app's newest in-flight (or latest) deployment.
        deadline = time.monotonic() + 60
        while True:
            in_flight = [
                d
                for d in app_deployment_uuids(endpoint, token, app_uuid)
                if (d.get("status") or "").lower() in IN_FLIGHT and d.get("deployment_uuid")
            ]
            if in_flight:
                deployment_uuid = in_flight[-1]["deployment_uuid"]
                break
            if time.monotonic() >= deadline:
                latest = pick_in_flight_or_latest(app_deployment_uuids(endpoint, token, app_uuid))
                if latest:
                    deployment_uuid = latest["deployment_uuid"]
                else:
                    raise RuntimeError(f"deploy for app {app_uuid} returned no deployment id")
                break
            time.sleep(5)
    return wait_for_deployment(endpoint, token, deployment_uuid)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--environment", required=True, choices=sorted(ENVIRONMENTS))
    parser.add_argument("apps", nargs="*", help="explicit app names (override defaults)")
    args = parser.parse_args()

    endpoint = os.environ.get("COOLIFY_ENDPOINT", "").strip()
    token = os.environ.get("COOLIFY_TOKEN", "").strip()
    if not endpoint or not token:
        sys.exit("COOLIFY_ENDPOINT and COOLIFY_TOKEN must be set")

    env = ENVIRONMENTS[args.environment]
    wanted = args.apps or env
    found = find_apps_by_name(endpoint, token, wanted)
    for name in wanted:
        print(f"deploying {name} (app {found[name]})...")
        status = deploy_app(endpoint, token, found[name])
        print(f"  {name}: {status}")


if __name__ == "__main__":
    main()
