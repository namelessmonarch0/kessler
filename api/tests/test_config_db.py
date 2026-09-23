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
