import logging
from datetime import timedelta

import psycopg
import pytest

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
