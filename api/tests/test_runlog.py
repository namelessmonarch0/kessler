import logging
import time
from datetime import timedelta

import psycopg
import pytest
from psycopg import sql

from app.db import connect
from app.ingest import runlog
from app.ingest.runlog import advisory_lock

NAME = "kessler.test-lock"


@pytest.fixture
def short_wait(monkeypatch):
    monkeypatch.setattr(runlog, "LOCK_WAIT", timedelta(milliseconds=500))


def held_elsewhere(url: str, name: str) -> bool:
    """Whether some other session holds `name`: a try-lock from a fresh connection fails."""
    with connect(url) as c, c.transaction():
        row = c.execute("SELECT pg_try_advisory_xact_lock(hashtext(%s)) AS ok", (name,)).fetchone()
        return not row["ok"]


def test_the_lock_is_held_for_the_block_and_a_second_holder_gives_up(
    database_url, short_wait, caplog
):
    with caplog.at_level(logging.INFO, logger="app.ingest.runlog"):
        with advisory_lock(database_url, NAME):
            assert held_elsewhere(database_url, NAME)
            with pytest.raises(psycopg.errors.QueryCanceled):
                with advisory_lock(database_url, NAME):
                    pass
    assert not held_elsewhere(database_url, NAME)
    assert "waiting for globe lock" in caplog.text
    assert "acquired globe lock" in caplog.text


def test_an_error_in_the_block_propagates_unchanged_and_frees_the_lock(database_url, short_wait):
    error = ValueError("root cause")
    with pytest.raises(ValueError) as raised:
        with advisory_lock(database_url, NAME):
            raise error
    assert raised.value is error
    with advisory_lock(database_url, NAME):  # free at once: QueryCanceled after 0.5 s otherwise
        pass


@pytest.fixture
def idle_in_transaction_timeout(database_url):
    """New sessions on the test database are ended after 1 s idle in a transaction, as Neon ends
    them after 5 minutes; reset afterwards."""
    alter = sql.SQL("ALTER DATABASE {} {}")
    with connect(database_url) as c:
        db = sql.Identifier(c.info.dbname)
        c.execute(alter.format(db, sql.SQL("SET idle_in_transaction_session_timeout = '1s'")))
        try:
            yield
        finally:
            c.execute(alter.format(db, sql.SQL("RESET idle_in_transaction_session_timeout")))


def test_the_lock_outlives_the_servers_idle_in_transaction_timeout(
    database_url, idle_in_transaction_timeout, short_wait
):
    with connect(database_url) as c:  # the limit is in force for new sessions
        row = c.execute("SHOW idle_in_transaction_session_timeout").fetchone()
        assert row["idle_in_transaction_session_timeout"] == "1s"
    with advisory_lock(database_url, NAME):
        time.sleep(2)  # the run works on its own connection while the lock's sits idle
    with advisory_lock(database_url, NAME):  # free at once: QueryCanceled after 0.5 s otherwise
        pass
