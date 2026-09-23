from app.config import Settings
from app.db import Database, connect


def test_settings_read_environment(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://x:y@db:5432/z")
    monkeypatch.setenv("MIN_SATCAT_ROWS", "10")
    s = Settings()
    assert s.database_url == "postgresql://x:y@db:5432/z"
    assert s.min_satcat_rows == 10
    assert s.spacetrack_user is None


def test_settings_treats_blank_env_var_as_none(monkeypatch):
    # .env.example ships SPACETRACK_USER= (blank); `cp .env.example .env` must not turn
    # that into a truthy empty-string secret.
    monkeypatch.setenv("SPACETRACK_USER", "")
    assert Settings().spacetrack_user is None


def test_settings_ignores_dotenv_file_in_tests(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("ORIGIN_SECRET=x\n")
    monkeypatch.chdir(tmp_path)
    assert Settings().origin_secret is None


def test_connect_returns_dict_rows_in_autocommit(database_url):
    with connect(database_url) as conn:
        row = conn.execute("SELECT 1 AS one").fetchone()
        assert row == {"one": 1}
        assert conn.autocommit is True


def test_database_pool_yields_connections(database_url):
    db = Database(database_url)
    gen = db.conn()
    try:
        conn = next(gen)
        assert conn.execute("SELECT 2 AS two").fetchone() == {"two": 2}
    finally:
        gen.close()
        db.close()


def test_pool_recovers_after_server_terminates_backend(migrated, conn):
    """Neon suspends its compute after ~5 min idle, killing pooled backends server-side.
    The pool must detect and discard a dead connection on checkout, not hand it back out."""
    db = Database(migrated)
    try:
        gen = db.conn()
        c = next(gen)
        assert c.execute("SELECT 1 AS one").fetchone() == {"one": 1}
        gen.close()

        conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE pid <> pg_backend_pid() AND datname = current_database() "
            "AND usename = current_user"
        )

        gen2 = db.conn()
        c2 = next(gen2)
        assert c2.execute("SELECT 1 AS one").fetchone() == {"one": 1}
        gen2.close()
    finally:
        db.close()
