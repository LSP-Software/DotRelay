"""Production-image regression: fail closed, read-only startup, schema readiness."""
import json
import subprocess
import time
import urllib.error
import urllib.request

image = "dotrelay-api-test"
settings = {"DATABASE_URL": "postgresql://dotrelay:dotrelay@127.0.0.1:5432/dotrelay", "SERVER_PROFILE_ID": "11111111-1111-4111-8111-111111111111", "SERVER_PROFILE_ORIGIN": "https://api.example", "WEB_ORIGIN": "https://web.example", "GITHUB_CLIENT_ID": "Iv1.test", "GITHUB_CLIENT_SECRET": "synthetic-test-client-secret", "BETTER_AUTH_SECRET": "synthetic-auth-secret-012345678901234567890123456789"}


def arguments(values):
    result = []
    for key, value in values.items():
        result += ["--env", f"{key}={value}"]
    return result


for change in [{key: ""} for key in settings] + [{"NODE_ENV": "development"}, {"WEB_ORIGIN": "http://web.example"}, {"SERVER_PROFILE_ORIGIN": "http://api.example"}]:
    result = subprocess.run(["docker", "run", "--rm", *arguments(dict(settings, **change)), image], capture_output=True, text=True, timeout=30)
    assert result.returncode != 0, "Insecure configuration booted"
    assert settings["GITHUB_CLIENT_SECRET"] not in result.stderr
    assert settings["BETTER_AUTH_SECRET"] not in result.stderr

container = subprocess.check_output(["docker", "run", "-d", "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=64m", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--network=host", *arguments(settings), image], text=True).strip()
try:
    for attempt in range(30):
        try:
            with urllib.request.urlopen("http://127.0.0.1:3001/ready", timeout=4) as response:
                assert json.load(response) == {"status": "ready"}
            break
        except (urllib.error.URLError, ConnectionError):
            if attempt == 29:
                raise RuntimeError("Read-only API never became ready") from None
            time.sleep(1)
    user = subprocess.check_output(["docker", "exec", container, "id", "-u"], text=True).strip()
    assert user == "10001"
    # An incompatible migration history must stop readiness while liveness
    # keeps working. Restore the disposable CI fixture in finally.
    subprocess.run(["docker", "exec", container, "bun", "-e", 'const {createDatabaseClient}=await import("@dotrelay/database"); const db=createDatabaseClient(); await db.$executeRawUnsafe("UPDATE _prisma_migrations SET checksum = \'mismatch\'"); await db.$disconnect();'], check=True, stdout=subprocess.DEVNULL)
    try:
        urllib.request.urlopen("http://127.0.0.1:3001/ready", timeout=4)
        raise AssertionError("Changed schema remained ready")
    except urllib.error.HTTPError as error:
        assert error.code == 503
    with urllib.request.urlopen("http://127.0.0.1:3001/health", timeout=4) as response:
        assert json.load(response) == {"status": "ok"}
finally:
    subprocess.run(["docker", "rm", "-f", container], check=True, stdout=subprocess.DEVNULL)
print("Production API image configuration, confidentiality, non-root/read-only startup and readiness passed")
