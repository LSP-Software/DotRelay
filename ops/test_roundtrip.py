"""Real-service regression. Uses unique throwaway databases, never a live DB."""
import os
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlsplit, urlunsplit
import uuid
import postgres as backup


def main():
    original = urlsplit(os.environ["DATABASE_URL"])
    prefix = "dotrelay_backup_" + uuid.uuid4().hex
    source, target = prefix + "_source", prefix + "_target"
    base = urlunsplit(original._replace(path="/dotrelay_test_admin"))
    admin = backup.pg_environment(base)
    admin["PGDATABASE"] = "postgres"
    def query(env, sql):
        return backup.run(["psql", "-XAt", "--set=ON_ERROR_STOP=1", "-c", sql], env)
    created = []
    try:
        for name in [source, target]:
            query(admin, f'CREATE DATABASE "{name}"')
            created.append(name)
        src_url = urlunsplit(original._replace(path="/" + source))
        src = backup.pg_environment(src_url)
        dst = dict(src, PGDATABASE=target)
        env = dict(os.environ, DATABASE_URL=src_url)
        backup.run(["bun", "node_modules/prisma/build/index.js", "migrate", "deploy", "--config", "packages/database/prisma.config.ts"], env)
        identity = "00000000-0000-4000-8000-000000000042"
        query(src, f"INSERT INTO server_profiles (id,origin) VALUES ('{identity}', 'https://relay.example')")
        query(src, "CREATE TABLE backup_fixture (id integer primary key, ciphertext bytea not null); INSERT INTO backup_fixture VALUES (1, decode('deadbeef00010203','hex'))")
        with tempfile.TemporaryDirectory() as directory:
            os.chmod(directory, 0o700)
            key = Path(directory) / "identity"
            backup.run(["age-keygen", "-o", str(key)])
            os.chmod(key, 0o600)
            recipient = backup.run(["age-keygen", "-y", str(key)]).decode().strip()
            archive = Path(directory) / "database.age"
            backup.backup(archive, src, recipient, key)
            backup.restore(archive, dst, key)
            assert query(dst, "SELECT id FROM server_profiles").strip().decode() == identity
            assert query(dst, "SELECT encode(ciphertext,'hex') FROM backup_fixture").strip() == b"deadbeef00010203"
            assert query(dst, 'SELECT count(*) FROM "_prisma_migrations"') == query(src, 'SELECT count(*) FROM "_prisma_migrations"')
            try:
                backup.restore(archive, dst, key)
            except RuntimeError:
                pass
            else:
                raise AssertionError("Nonempty target accepted")
            archive.write_bytes(archive.read_bytes()[:-8] + b"corrupt!")
            try:
                backup.verify(archive, key)
            except RuntimeError:
                pass
            else:
                raise AssertionError("Corrupt backup accepted")
        print("Encrypted real-schema PostgreSQL backup/restore, identity, ciphertext, migration history and refusal checks passed")
    finally:
        for name in created:
            query(admin, f'DROP DATABASE "{name}"')


if __name__ == "__main__":
    main()
