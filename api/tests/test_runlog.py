import psycopg
import pytest

from app.ingest.runlog import advisory_lock


class FakeConn:
    """Succeeds on the lock call, raises on the unlock call (a broken connection)."""

    def execute(self, sql, params=None):
        if "pg_advisory_unlock" in sql:
            raise psycopg.OperationalError("connection broken")
        return None


def test_failed_unlock_does_not_mask_the_original_exception():
    with pytest.raises(ValueError, match="root cause"):
        with advisory_lock(FakeConn(), "x"):
            raise ValueError("root cause")
