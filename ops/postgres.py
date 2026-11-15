#!/usr/bin/env python3
"""Encrypted, authenticated PostgreSQL backups; restore refuses every non-empty target.

Credentials are read from the environment, never accepted as command arguments.
age encryption to a public recipient does not say who made an archive, so each
backup's manifest carries an HMAC-SHA256 under BACKUP_MAC_KEY_FILE, a private key
kept away from backup storage; verify and restore refuse an archive whose
manifest does not authenticate before anything is decrypted.
Only stable, non-sensitive failures are printed. Requires PostgreSQL 17 clients
and age 1.x. Stop all API/maintenance writers before migrate or restore.
"""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit, unquote, parse_qs


def pg_environment(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ("postgres", "postgresql") or not parsed.hostname or parsed.path in ("", "/", "/postgres", "/template0", "/template1"):
        raise RuntimeError("An explicit application database is required")
    env = dict(os.environ)
    env.update(PGHOST=parsed.hostname, PGPORT=str(parsed.port or 5432), PGDATABASE=unquote(parsed.path[1:]), PGUSER=unquote(parsed.username or ""), PGPASSWORD=unquote(parsed.password or ""))
    query = parse_qs(parsed.query)
    # Do not silently drop TLS verification parameters from DATABASE_URL.
    supported = {"sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT", "sslcert": "PGSSLCERT", "sslkey": "PGSSLKEY"}
    if set(query) - set(supported):
        raise RuntimeError("Unsupported database URL options; configure libpq TLS variables explicitly")
    for key, values in query.items():
        env[supported[key]] = values[-1]
    env["PGCONNECT_TIMEOUT"] = "10"
    return env


def run(command, env=None, data=None, output=None):
    streams = {"stdin": data} if hasattr(data, "read") else {"input": data}
    result = subprocess.run(command, env=env, stdout=output if output is not None else subprocess.PIPE, stderr=subprocess.PIPE, **streams)
    if result.returncode:
        raise RuntimeError(f"{Path(command[0]).name} failed; target remains offline")
    return result.stdout


def private_file(path):
    path = Path(path)
    if not path.is_file() or path.stat().st_mode & 0o077:
        raise RuntimeError("A private regular identity file is required")
    return path


def checksum(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


MANIFEST_VERSION = 2
MAC_DOMAIN = b"dotrelay-backup-manifest-v2\n"


def mac_key(path):
    """The manifest MAC key: a private file of at least 32 bytes (or 64 hex characters)."""
    raw = private_file(path).read_bytes().strip()
    try:
        key = bytes.fromhex(raw.decode("ascii"))
    except (UnicodeDecodeError, ValueError):
        key = raw
    if len(key) < 32:
        raise RuntimeError("The backup MAC key must hold at least 32 bytes")
    return key


def manifest_mac(key, fields):
    body = json.dumps(fields, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(key, MAC_DOMAIN + body, hashlib.sha256).hexdigest()


def verify(archive, identity, key_path, allow_unauthenticated=False):
    archive = Path(archive)
    manifest = json.loads(Path(str(archive) + ".json").read_text())
    if manifest.get("version") == MANIFEST_VERSION:
        fields = {"version": MANIFEST_VERSION, "sha256": manifest.get("sha256"), "size": manifest.get("size")}
        expected = manifest_mac(mac_key(key_path), fields)
        if not isinstance(manifest.get("mac"), str) or not hmac.compare_digest(manifest["mac"], expected):
            raise RuntimeError("Backup manifest is not authentic")
        if fields["size"] != archive.stat().st_size or fields["sha256"] != checksum(archive):
            raise RuntimeError("Backup checksum mismatch")
    elif manifest.get("version") == 1 and allow_unauthenticated:
        # Archives made before manifests were authenticated: accepted only on
        # the operator's explicit, per-run assertion that storage was trusted.
        if manifest.get("sha256") != checksum(archive):
            raise RuntimeError("Backup checksum mismatch")
    else:
        raise RuntimeError("Backup manifest is not authentic")
    private_file(identity)
    # age authenticates the full encrypted stream before pg_restore sees it.
    # Unlinked private temporary file bounds memory while ensuring the whole
    # age stream authenticates before the first database write. The host's
    # temp storage must be private/encrypted; do not use a shared mount.
    plaintext = tempfile.TemporaryFile()
    try:
        run(["age", "--decrypt", "--identity", str(identity), str(archive)], output=plaintext)
        plaintext.seek(0)
        run(["pg_restore", "--list"], data=plaintext)
        plaintext.seek(0)
        return plaintext
    except BaseException:
        plaintext.close()
        raise


def backup(archive, env, recipient, identity, key_path):
    key = mac_key(key_path)
    archive = Path(archive)
    archive.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if archive.parent.stat().st_mode & 0o077:
        raise RuntimeError("Backup directory must have mode 0700")
    # Exclusive creation prevents clobbering a prior backup or following symlinks.
    with archive.open("xb") as output:
        os.chmod(archive, 0o600)
        dump = subprocess.Popen(["pg_dump", "--format=custom", "--no-owner", "--no-privileges"], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            encrypted = subprocess.run(["age", "--recipient", recipient], stdin=dump.stdout, stdout=output, stderr=subprocess.DEVNULL)
            dump.stdout.close()
            if dump.wait() or encrypted.returncode:
                raise RuntimeError("Backup pipeline failed")
            output.flush()
            os.fsync(output.fileno())
        finally:
            if dump.poll() is None:
                dump.kill()
                dump.wait()
    fields = {"version": MANIFEST_VERSION, "sha256": checksum(archive), "size": archive.stat().st_size}
    manifest = dict(fields, mac=manifest_mac(key, fields))
    with Path(str(archive) + ".json").open("x") as output:
        json.dump(manifest, output)
    verify(archive, identity, key_path).close()


def restore(archive, env, identity, key_path, allow_unauthenticated=False):
    plaintext = verify(archive, identity, key_path, allow_unauthenticated)
    try:
        # Never --clean, DROP DATABASE, or overwrite an existing schema. The
        # operator supplies a newly created isolated target and switches only
        # after validation; the original database and backup stay intact.
        count = run(["psql", "-XAt", "--set=ON_ERROR_STOP=1", "-c", "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','v','m','S','f')"], env).strip()
        if count != b"0":
            raise RuntimeError("Restore requires an empty isolated database")
        run(["pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--dbname", env["PGDATABASE"]], env, plaintext)
    finally:
        if hasattr(plaintext, "close"):
            plaintext.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["backup", "verify", "restore"])
    parser.add_argument("archive")
    args = parser.parse_args()
    identity = os.environ["BACKUP_IDENTITY_FILE"]
    key_path = os.environ["BACKUP_MAC_KEY_FILE"]
    legacy = os.environ.get("DOTRELAY_ALLOW_UNAUTHENTICATED_BACKUP") == "true"
    if args.action == "verify":
        verify(args.archive, identity, key_path, legacy).close()
    else:
        env = pg_environment(os.environ["RESTORE_DATABASE_URL" if args.action == "restore" else "DATABASE_URL"])
        if args.action == "backup":
            backup(args.archive, env, os.environ["BACKUP_AGE_RECIPIENT"], identity, key_path)
        else:
            if os.environ.get("DOTRELAY_WRITERS_STOPPED") != "true":
                raise RuntimeError("Stop all writers and set DOTRELAY_WRITERS_STOPPED=true")
            restore(args.archive, env, identity, key_path, legacy)
    print("Backup operation verified")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except (Exception, KeyboardInterrupt):
        print("Backup operation failed; keep the service offline and inspect the isolated target. Credentials and database diagnostics are suppressed.", file=sys.stderr)
        sys.exit(1)
