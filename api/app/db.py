from collections.abc import Iterator
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

# prepare_threshold=None: Neon's pooled endpoint (PgBouncer, transaction mode) breaks
# server-side prepared statements. autocommit=True: every write uses conn.transaction().
CONN_KWARGS: dict[str, Any] = {
    "row_factory": dict_row,
    "autocommit": True,
    "prepare_threshold": None,
}


def connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url, **CONN_KWARGS)


class Database:
    def __init__(self, url: str, max_size: int = 4):
        self.pool = ConnectionPool(
            url, min_size=0, max_size=max_size, kwargs=CONN_KWARGS, open=True,
            check=ConnectionPool.check_connection,
        )

    def conn(self) -> Iterator[psycopg.Connection]:
        with self.pool.connection() as c:
            yield c

    def close(self) -> None:
        self.pool.close()
