"""Writes each GP ingest run's new element sets to the history archive.

Layout: history/gp/YYYY/MM/DD/HHMMSSZ-<source>-r<run id>.jsonl.gz (UTC), gzip JSON Lines, one
element set per line exactly as the source sent it.
See docs/superpowers/specs/2026-09-25-gp-history-archive-design.md.
"""
import gzip
import json
import logging
from collections.abc import Iterable, Mapping
from datetime import UTC, date, datetime

import psycopg

from app.domain.orbits import parse_epoch
from app.ingest.snapshot import SnapshotStore

log = logging.getLogger(__name__)

HISTORY_PREFIX = "history/gp/"


def day_prefix(day: date) -> str:
    return f"{HISTORY_PREFIX}{day:%Y/%m/%d}/"


def archive_key(run_at: datetime, source: str, run_id: int) -> str:
    """One key per run: the run id keeps two runs that start in the same second apart."""
    t = run_at.astimezone(UTC)
    return f"{day_prefix(t.date())}{t:%H%M%S}Z-{source}-r{run_id}.jsonl.gz"


def encode_records(records: Iterable[Mapping]) -> bytes:
    body = "".join(
        json.dumps(dict(r), ensure_ascii=False, separators=(",", ":")) + "\n" for r in records
    )
    return gzip.compress(body.encode("utf-8"), mtime=0)


def decode_records(data: bytes) -> list[dict]:
    return [json.loads(line) for line in gzip.decompress(data).decode("utf-8").splitlines() if line]


def element_set_id(item: Mapping) -> tuple[int, datetime] | None:
    """(NORAD ID, epoch) of a raw OMM record, or None when either is missing or malformed."""
    try:
        return int(item["NORAD_CAT_ID"]), parse_epoch(item["EPOCH"])
    except (KeyError, TypeError, ValueError):
        return None


def select_new_records(conn: psycopg.Connection, items: Iterable[Mapping]) -> list[Mapping]:
    """Raw records whose epoch is later than the one stored in gp_elements for their NORAD ID, or
    whose ID has no stored row (including IDs unknown to the catalogue)."""
    stored = {
        r["norad_id"]: r["epoch"]
        for r in conn.execute("SELECT norad_id, epoch FROM gp_elements").fetchall()
    }
    new: list[Mapping] = []
    malformed = 0
    for item in items:
        ident = element_set_id(item)
        if ident is None:
            malformed += 1
            continue
        norad_id, epoch = ident
        previous = stored.get(norad_id)
        if previous is None or epoch > previous:
            new.append(item)
    if malformed:
        log.warning("not archiving %d GP records without a valid NORAD ID and epoch", malformed)
    return new


def archive_gp(
    conn: psycopg.Connection,
    store: SnapshotStore,
    items: Iterable[Mapping],
    *,
    source: str,
    run_at: datetime,
    run_id: int,
) -> int:
    """Writes this run's new element sets (an empty file when there are
    none) and returns how many."""
    new = select_new_records(conn, items)
    store.put(archive_key(run_at, source, run_id), encode_records(new))
    return len(new)
