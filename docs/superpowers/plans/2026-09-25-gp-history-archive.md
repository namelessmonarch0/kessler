# Orbit-History Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `ingest-gp` run archives the element sets that changed since the last run, exactly as received, to gzip JSON Lines files in S3, and a reader loads date ranges back.

**Architecture:** A new `app/history` package: `archive.py` selects new element sets by comparing epochs with `gp_elements`, encodes them and writes one file per run through the existing `SnapshotStore`; `read.py` walks day prefixes and deduplicates per object; `__main__.py` is a `dump` CLI. `run_ingest_gp` calls the archiver after fetching and before writing the database, so a failed archive aborts the run with the database untouched.

**Tech Stack:** Python 3.12, psycopg 3 (dict rows, autocommit), boto3/S3, pytest with testcontainers Postgres and moto, ruff. Commands run from `api/` with `uv run`.

**Spec:** `docs/superpowers/specs/2026-09-25-gp-history-archive-design.md`

## Global Constraints

- Archive key: `history/gp/YYYY/MM/DD/HHMMSSZ-<source>-r<run id>.jsonl.gz`, UTC, from the run start time and the `ingest_runs` id.
- Sources: `spacetrack`, `celestrak` (a future bulk import will use `spacetrack-history`).
- File content: gzip JSON Lines, one element set per line, exactly as received (every field, nothing renamed or dropped; CelesTrak CSV rows as JSON objects of their columns).
- A record is new when its epoch is later than the `gp_elements` epoch for its NORAD ID, or the ID has no row. Unknown IDs are archived.
- Order inside a run: fetch → archive → write `gp_elements` → write snapshots. An archive failure fails the run before the database is touched.
- Every run writes a file, even with zero new records.
- Storage: the existing snapshot bucket (RETAIN) via `SnapshotStore`; no infrastructure changes.
- Reader: inclusive UTC days, key order, yields a record only if its epoch is later than the last one yielded for that NORAD ID.
- Job result: `{"ingest_gp": <written>, "archived_gp": <archived>}` alongside the existing keys.
- Lint: ruff rules `E, F, I, B, UP`, line length 100.

## Review Focus

- Two runs starting in the same second (a manual run overlapping the schedule) must produce two files, not overwrite one: pinned in Task 3 (`test_runs_starting_in_the_same_second_keep_separate_files`).
- The same instant written in different epoch formats (`...496448`, `...496448Z`, `+00:00`) must compare equal, or every run re-archives everything: pinned in Task 2 (`test_same_instant_in_another_format_is_not_new`).
- Malformed records (missing `EPOCH`, non-numeric `NORAD_CAT_ID`) must be skipped, not crash the ingest: pinned in Task 2 (`test_malformed_records_are_skipped`).
- A day with no files, and an empty file from a quiet run, must read back as nothing rather than raise: pinned in Task 4 (`test_missing_days_and_empty_files_read_as_nothing`).
- After a failed archive write, the next successful run must still archive the element sets the failed run missed: pinned in Task 3 (`test_archive_write_failure_keeps_database_and_fails_the_run`).

---

### Task 1: `keys(prefix)` on both snapshot stores

**Files:**
- Modify: `api/app/ingest/snapshot.py` (`SnapshotStore` protocol, `LocalSnapshotStore`)
- Modify: `api/app/aws.py` (`S3SnapshotStore`)
- Create: `api/tests/test_store_keys.py`
- Modify: `api/tests/test_aws.py`

**Interfaces:**
- Produces: `SnapshotStore.keys(prefix: str) -> list[str]` — every stored key starting with `prefix`, sorted ascending. Implemented by `LocalSnapshotStore.keys` and `S3SnapshotStore.keys`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_store_keys.py`:

```python
from app.ingest.snapshot import LocalSnapshotStore


def test_local_keys_lists_sorted_keys_under_a_prefix(tmp_path):
    store = LocalSnapshotStore(tmp_path)
    for key in ("a/b/2", "a/b/1", "a/c/1", "top"):
        store.put(key, b"x")
    (tmp_path / "a" / "b" / "3.tmp").write_bytes(b"partial write")  # never a key
    assert store.keys("a/b/") == ["a/b/1", "a/b/2"]
    assert store.keys("a/") == ["a/b/1", "a/b/2", "a/c/1"]
    assert store.keys("") == ["a/b/1", "a/b/2", "a/c/1", "top"]


def test_local_keys_for_a_missing_prefix_is_empty(tmp_path):
    assert LocalSnapshotStore(tmp_path).keys("history/gp/2026/09/25/") == []
    assert LocalSnapshotStore(tmp_path / "not-created").keys("") == []
```

Append to `api/tests/test_aws.py`:

```python
def test_s3_store_keys_lists_sorted_keys_under_a_prefix(aws):
    boto3.client("s3", region_name=REGION).create_bucket(
        Bucket="snaps", CreateBucketConfiguration={"LocationConstraint": REGION}
    )
    store = S3SnapshotStore("snaps")
    for key in ("history/gp/2026/09/25/b", "history/gp/2026/09/25/a", "globe/LEO.bin.gz"):
        store.put(key, b"x")
    assert store.keys("history/gp/2026/09/25/") == [
        "history/gp/2026/09/25/a", "history/gp/2026/09/25/b",
    ]
    assert store.keys("history/gp/2026/09/26/") == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_store_keys.py tests/test_aws.py -k keys -v`
Expected: FAIL with `AttributeError: 'LocalSnapshotStore' object has no attribute 'keys'` (and the same for `S3SnapshotStore`).

- [ ] **Step 3: Implement**

In `api/app/ingest/snapshot.py`, extend the protocol and the local store:

```python
class SnapshotStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...

    def get(self, key: str) -> bytes | None: ...

    def keys(self, prefix: str) -> list[str]: ...
```

```python
    def keys(self, prefix: str) -> list[str]:
        """Stored keys starting with `prefix`, sorted. Half-written `.tmp` files are not keys."""
        start = self.root / prefix[: prefix.rfind("/") + 1]
        if not start.is_dir():
            return []
        found = (p.relative_to(self.root).as_posix() for p in start.rglob("*") if p.is_file())
        return sorted(k for k in found if k.startswith(prefix) and not k.endswith(".tmp"))
```

(Add the method to `LocalSnapshotStore` after `get`.)

In `api/app/aws.py`, add to `S3SnapshotStore` after `get`:

```python
    def keys(self, prefix: str) -> list[str]:
        pages = self.client.get_paginator("list_objects_v2").paginate(
            Bucket=self.bucket, Prefix=prefix
        )
        return sorted(obj["Key"] for page in pages for obj in page.get("Contents", []))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && uv run pytest tests/test_store_keys.py tests/test_aws.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add api/app/ingest/snapshot.py api/app/aws.py api/tests/test_store_keys.py api/tests/test_aws.py
git commit -m "feat(api): list stored keys by prefix (local and S3 stores)"
```

---

### Task 2: The archive module

**Files:**
- Modify: `api/app/domain/orbits.py` (add `parse_epoch`)
- Modify: `api/app/ingest/gp.py` (use `parse_epoch`, delete `_epoch`)
- Create: `api/app/history/__init__.py`
- Create: `api/app/history/archive.py`
- Create: `api/tests/test_history_archive.py`

**Interfaces:**
- Consumes: `SnapshotStore.put`, `SnapshotStore.keys` (Task 1).
- Produces (in `app.domain.orbits`): `parse_epoch(value: str) -> datetime` — ISO-8601 → timezone-aware UTC datetime; naive input is UTC.
- Produces (in `app.history.archive`):
  - `HISTORY_PREFIX = "history/gp/"`
  - `day_prefix(day: date) -> str` — `"history/gp/YYYY/MM/DD/"`
  - `archive_key(run_at: datetime, source: str, run_id: int) -> str`
  - `encode_records(records: Iterable[Mapping]) -> bytes` / `decode_records(data: bytes) -> list[dict]`
  - `element_set_id(item: Mapping) -> tuple[int, datetime] | None`
  - `select_new_records(conn: psycopg.Connection, items: Iterable[Mapping]) -> list[Mapping]`
  - `archive_gp(conn, store, items, *, source: str, run_at: datetime, run_id: int) -> int` — writes the run's file, returns the number of records in it.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_history_archive.py`:

```python
import gzip
import json
from datetime import UTC, date, datetime, timedelta, timezone

import pytest

from app.config import Settings
from app.domain.orbits import parse_epoch
from app.history.archive import (
    archive_gp,
    archive_key,
    day_prefix,
    decode_records,
    encode_records,
    select_new_records,
)
from app.ingest.satcat import run_ingest_satcat
from tests.test_ingest_satcat import SAMPLE, FakeCelesTrak

SETTINGS = Settings(min_satcat_rows=10)
ISS_EPOCH = datetime(2026, 9, 22, 6, 30, 37, 496448, tzinfo=UTC)


def omm(norad_id: str, epoch: str, **extra) -> dict:
    return {"NORAD_CAT_ID": norad_id, "EPOCH": epoch, "MEAN_MOTION": "15.49", **extra}


@pytest.fixture
def catalog(conn):
    run_ingest_satcat(conn, celestrak=FakeCelesTrak(SAMPLE), settings=SETTINGS)
    return conn


def store_epoch(conn, norad_id: int, epoch: datetime) -> None:
    conn.execute(
        "INSERT INTO gp_elements (norad_id, epoch, mean_motion, eccentricity, inclination, raan, "
        "arg_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot, source) "
        "VALUES (%s, %s, 15, 0, 51.6, 0, 0, 0, 0, 0, 0, 'test')",
        (norad_id, epoch),
    )


def test_parse_epoch_treats_naive_times_as_utc():
    assert parse_epoch("2026-09-22T06:30:37.496448") == ISS_EPOCH
    assert parse_epoch("2026-09-22T06:30:37.496448Z") == ISS_EPOCH
    assert parse_epoch("2026-09-22T08:30:37.496448+02:00") == ISS_EPOCH


def test_archive_key_is_utc_and_unique_per_run():
    run_at = datetime(2026, 9, 25, 6, 41, 12, tzinfo=UTC)
    assert archive_key(run_at, "spacetrack", 42) == (
        "history/gp/2026/09/25/064112Z-spacetrack-r42.jsonl.gz"
    )
    local = run_at.astimezone(timezone(timedelta(hours=-5)))  # same instant, UTC-5
    assert archive_key(local, "celestrak", 7) == (
        "history/gp/2026/09/25/064112Z-celestrak-r7.jsonl.gz"
    )
    assert day_prefix(date(2026, 9, 5)) == "history/gp/2026/09/05/"


def test_encode_round_trips_records_exactly_and_is_gzip():
    records = [omm("25544", "2026-09-22T06:30:37.496448", TLE_LINE1="1 25544U 98067A"),
               {"OBJECT_NAME": "NAVSTAR 43 (USA 132)", "NORAD_CAT_ID": "24876"}]
    data = encode_records(records)
    lines = gzip.decompress(data).decode("utf-8").splitlines()
    assert [json.loads(line) for line in lines] == records
    assert list(json.loads(lines[0])) == list(records[0])  # field order kept
    assert decode_records(data) == records
    assert decode_records(encode_records([])) == []


def test_unstored_and_newer_element_sets_are_new(catalog):
    store_epoch(catalog, 25544, ISS_EPOCH)
    items = [
        omm("25544", "2026-09-22T12:00:00.000000"),  # newer than stored
        omm("24876", "2026-09-22T10:11:43.219392"),  # no stored row
        omm("123456", "2026-09-21T00:00:00.000000"),  # unknown to the catalogue
    ]
    assert select_new_records(catalog, items) == items


def test_equal_or_older_element_sets_are_not_new(catalog):
    store_epoch(catalog, 25544, ISS_EPOCH)
    items = [omm("25544", "2026-09-22T06:30:37.496448"), omm("25544", "2026-09-21T00:00:00")]
    assert select_new_records(catalog, items) == []


def test_same_instant_in_another_format_is_not_new(catalog):
    store_epoch(catalog, 25544, ISS_EPOCH)
    items = [omm("25544", "2026-09-22T06:30:37.496448Z"),
             omm("25544", "2026-09-22T06:30:37.496448+00:00")]
    assert select_new_records(catalog, items) == []


def test_malformed_records_are_skipped(catalog):
    good = omm("25544", "2026-09-22T06:30:37.496448")
    items = [{"NORAD_CAT_ID": "25544"}, omm("ISS", "2026-09-22T06:30:37"),
             omm("25544", "not-a-date"), omm("25544", None), good]
    assert select_new_records(catalog, items) == [good]


def test_archive_gp_writes_one_file_for_the_run(catalog, store):
    run_at = datetime(2026, 9, 25, 6, 41, 12, tzinfo=UTC)
    items = [omm("25544", "2026-09-22T06:30:37.496448")]
    n = archive_gp(catalog, store, items, source="spacetrack", run_at=run_at, run_id=3)
    assert n == 1
    key = "history/gp/2026/09/25/064112Z-spacetrack-r3.jsonl.gz"
    assert store.keys("history/") == [key]
    assert decode_records(store.get(key)) == items


def test_archive_gp_writes_an_empty_file_when_nothing_is_new(catalog, store):
    store_epoch(catalog, 25544, ISS_EPOCH)
    run_at = datetime(2026, 9, 25, 12, 41, tzinfo=UTC)
    items = [omm("25544", "2026-09-22T06:30:37.496448")]
    assert archive_gp(catalog, store, items, source="spacetrack", run_at=run_at, run_id=4) == 0
    [key] = store.keys("history/")
    assert decode_records(store.get(key)) == []
```

(`conn` and `store` fixtures come from `api/tests/conftest.py`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_history_archive.py -v`
Expected: FAIL at import: `ImportError: cannot import name 'parse_epoch' from 'app.domain.orbits'`.

- [ ] **Step 3: Implement**

At the top of `api/app/domain/orbits.py` add the import, and add the function after the constants:

```python
from datetime import UTC, datetime
```

```python
def parse_epoch(value: str) -> datetime:
    """An OMM epoch as a timezone-aware UTC datetime. Space-Track and CelesTrak send naive ISO-8601
    times that are UTC; explicit offsets and a trailing Z are honoured."""
    dt = datetime.fromisoformat(value)
    return dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC)
```

In `api/app/ingest/gp.py`: delete the `_epoch` function, add `from app.domain.orbits import parse_epoch` to the imports, and change `epoch=_epoch(d["EPOCH"]),` in `parse_gp_records` to `epoch=parse_epoch(d["EPOCH"]),`.

Create `api/app/history/__init__.py`:

```python
"""Orbit-history archive: every new GP element set, as received (spec 2026-09-25)."""
```

Create `api/app/history/archive.py`:

```python
"""Writes each GP ingest run's new element sets to the history archive.

Layout: history/gp/YYYY/MM/DD/HHMMSSZ-<source>-r<run id>.jsonl.gz (UTC), gzip JSON Lines, one element
set per line exactly as the source sent it. See docs/superpowers/specs/2026-09-25-gp-history-archive-design.md.
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
    """Writes this run's new element sets (an empty file when there are none) and returns how many."""
    new = select_new_records(conn, items)
    store.put(archive_key(run_at, source, run_id), encode_records(new))
    return len(new)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && uv run pytest tests/test_history_archive.py tests/test_ingest_gp.py -v`
Expected: all PASS (the GP ingest tests still pass after the `parse_epoch` swap).

- [ ] **Step 5: Commit**

```bash
git add api/app/domain/orbits.py api/app/ingest/gp.py api/app/history api/tests/test_history_archive.py
git commit -m "feat(api): history archive module (select new element sets, encode, write)"
```

---

### Task 3: Archive inside every GP ingest run

**Files:**
- Modify: `api/app/ingest/runlog.py` (`RunState.id`)
- Modify: `api/app/ingest/gp.py` (`fetch_gp` returns raw records; `run_ingest_gp` archives first and returns `GpIngestResult`)
- Modify: `api/app/jobs.py` (report `archived_gp`)
- Modify: `api/tests/test_ingest_gp.py`
- Modify: `api/tests/test_jobs.py`

**Interfaces:**
- Consumes: `archive_gp`, `HISTORY_PREFIX`, `decode_records` (Task 2); `SnapshotStore.keys` (Task 1).
- Produces:
  - `RunState.id: int | None` — the `ingest_runs` id of the run in progress.
  - `fetch_gp(conn, spacetrack, celestrak, now, min_spacetrack_rows) -> tuple[str, list[Mapping], list[GpRecord]]` — source, raw records, parsed records.
  - `GpIngestResult(written: int, archived: int)` (a `NamedTuple` in `app.ingest.gp`), returned by `run_ingest_gp`.
  - `run_job(...)` result gains `"archived_gp": int` whenever it includes `"ingest_gp"`.

- [ ] **Step 1: Write the failing tests and update the existing ones**

In `api/tests/test_ingest_gp.py`:

1. Change the imports:

```python
import csv
import io
import json
from datetime import UTC, datetime, timedelta

import pytest

from app.config import Settings
from app.history.archive import HISTORY_PREFIX, decode_records
from app.ingest.gp import GpIngestResult, parse_gp_csv, parse_gp_records, run_ingest_gp
```

(keep the remaining existing imports as they are).

2. `run_ingest_gp` now returns `GpIngestResult`. Update the four existing assertions on its return value:
   - in `test_spacetrack_ingest_replaces_and_skips_unknown_objects`: `assert n == 3` → `assert n.written == 3`
   - in `test_short_spacetrack_payload_after_24h_falls_back_to_celestrak`: `assert n == 2` → `assert n.written == 2`
   - in `test_celestrak_fallback_upserts_without_deleting`: `assert n == 2` → `assert n.written == 2`
   - in `test_no_spacetrack_credentials_uses_celestrak`: `assert n == 2` → `assert n.written == 2`

3. Append the new tests:

```python
class FailingHistoryStore(LocalSnapshotStore):
    """A store whose history writes fail (S3 down, permissions), while snapshots still work."""

    def put(self, key: str, data: bytes) -> None:
        if key.startswith(HISTORY_PREFIX):
            raise OSError("S3 unavailable")
        super().put(key, data)


def archive_files(store) -> list[str]:
    return store.keys(HISTORY_PREFIX)


def advanced(sample: list[dict], norad_id: int, epoch: str) -> list[dict]:
    """The sample with one object's element set replaced by a newer one."""
    return [dict(r, EPOCH=epoch) if r["NORAD_CAT_ID"] == str(norad_id) else r for r in sample]


NEWER_ISS = advanced(ST_SAMPLE, 25544, "2026-09-23T06:00:00.000000")


def last_run(conn):
    return conn.execute("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1").fetchone()


def test_first_run_archives_every_record_as_received(catalog, store):
    result = run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    # 123456 is unknown to the catalogue: not written to gp_elements, but archived.
    assert result == GpIngestResult(written=3, archived=4)
    [key] = archive_files(store)
    assert key == f"history/gp/2026/09/23/120000Z-spacetrack-r{last_run(catalog)['id']}.jsonl.gz"
    assert decode_records(store.get(key)) == ST_SAMPLE


def test_later_runs_archive_only_new_element_sets(catalog, store):
    kw = dict(celestrak=FakeCelesTrakGp(SAMPLE), store=store, settings=SETTINGS)
    run_ingest_gp(catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), now=NOW, **kw)
    second = run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(NEWER_ISS), now=NOW + timedelta(hours=6), **kw
    )
    assert second.archived == 2
    records = decode_records(store.get(archive_files(store)[1]))
    assert [r["NORAD_CAT_ID"] for r in records] == ["25544", "123456"]  # changed + still unknown
    third = run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(NEWER_ISS), now=NOW + timedelta(hours=12), **kw
    )
    assert third.archived == 1  # nothing changed; only the unknown object repeats
    assert len(archive_files(store)) == 3


def test_archive_write_failure_keeps_database_and_fails_the_run(catalog, store, tmp_path):
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    before = gp_rows(catalog)
    with pytest.raises(OSError, match="S3 unavailable"):
        run_ingest_gp(
            catalog, spacetrack=FakeSpaceTrack(NEWER_ISS), celestrak=FakeCelesTrakGp(SAMPLE),
            store=FailingHistoryStore(tmp_path), settings=SETTINGS,
            now=NOW + timedelta(hours=6),
        )
    assert gp_rows(catalog) == before
    run = last_run(catalog)
    assert run["status"] == "failed" and "S3 unavailable" in run["error"]
    # The next good run still archives the element set the failed run missed.
    retry = run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(NEWER_ISS), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW + timedelta(hours=12),
    )
    records = decode_records(store.get(archive_files(store)[-1]))
    assert retry.archived == 2 and records[0]["EPOCH"] == "2026-09-23T06:00:00.000000"


def test_runs_starting_in_the_same_second_keep_separate_files(catalog, store):
    for _ in range(2):
        run_ingest_gp(
            catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
            store=store, settings=SETTINGS, now=NOW,
        )
    assert len(archive_files(store)) == 2


def test_celestrak_fallback_is_archived_with_its_tag(catalog, store):
    result = run_ingest_gp(
        catalog, spacetrack=None, celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    [key] = archive_files(store)
    assert key.endswith(f"-celestrak-r{last_run(catalog)['id']}.jsonl.gz")
    records = decode_records(store.get(key))
    assert records == list(csv.DictReader(io.StringIO(CT_SAMPLE)))  # whole CSV rows, as received
    assert result.archived == len(records) == 2
```

In `api/tests/test_jobs.py`, change the result assertion in `test_run_all_end_to_end` to:

```python
    assert result == {"ingest_satcat": 20, "rebuild_stats": result["rebuild_stats"],
                      "ingest_gp": 3, "archived_gp": 4}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_ingest_gp.py tests/test_jobs.py -v`
Expected: FAIL at import with `ImportError: cannot import name 'GpIngestResult' from 'app.ingest.gp'`.

- [ ] **Step 3: Implement**

In `api/app/ingest/runlog.py`, give `RunState` the run id and set it:

```python
@dataclass
class RunState:
    source: str
    rows: int | None = None
    id: int | None = None
```

and in `run_log`, replace `state = RunState(source=source)` with:

```python
    state = RunState(source=source, id=run_id)
```

In `api/app/ingest/gp.py`:

1. Add `from typing import NamedTuple` and `from app.history.archive import archive_gp` to the imports.

2. Add after `GP_COLUMNS`:

```python
class GpIngestResult(NamedTuple):
    written: int  # element sets written to gp_elements
    archived: int  # new element sets written to the history archive
```

3. Replace `fetch_gp` with:

```python
def fetch_gp(
    conn: psycopg.Connection, spacetrack, celestrak, now: datetime, min_spacetrack_rows: int
) -> tuple[str, list[Mapping], list[GpRecord]]:
    """Fetches GP records, preferring Space-Track, and returns (source, raw records, parsed
    records); the raw records are what the history archive keeps. The Space-Track row floor is
    applied here, inside the try, so a short/garbage payload (no HTTP error, just too few rows)
    goes through the same last-success/24h fallback rule as an outright fetch failure."""
    if spacetrack is not None:
        try:
            raw = spacetrack.gp_all_on_orbit()
            records = parse_gp_records(raw)
            if len(records) < min_spacetrack_rows:
                raise SourceError(
                    f"spacetrack returned {len(records)} GP records, expected at least "
                    f"{min_spacetrack_rows}; keeping previous data"
                )
            return "spacetrack", raw, records
        except SourceError:
            last_ok = last_success(conn, "ingest_gp", "spacetrack")
            if last_ok is not None and now - last_ok < FALLBACK_AFTER:
                raise
            log.warning("Space-Track unavailable for over 24 h; falling back to CelesTrak")
    raw = list(csv.DictReader(io.StringIO(celestrak.gp_active_csv())))
    return "celestrak", raw, parse_gp_records(raw)
```

4. Replace `run_ingest_gp` with:

```python
def run_ingest_gp(
    conn: psycopg.Connection,
    *,
    spacetrack,
    celestrak,
    store: SnapshotStore,
    settings: Settings,
    now: datetime | None = None,
) -> GpIngestResult:
    now = now or datetime.now(UTC)
    with run_log(conn, "ingest_gp") as run:
        source, raw, records = fetch_gp(
            conn, spacetrack, celestrak, now, settings.min_gp_rows_spacetrack
        )
        run.source = source
        if source == "celestrak" and len(records) < settings.min_gp_rows_celestrak:
            raise SourceError(
                f"celestrak returned {len(records)} GP records, expected at least "
                f"{settings.min_gp_rows_celestrak}; keeping previous data"
            )
        # History first: it is computed against the stored epochs, and if it cannot be written the
        # run fails here with gp_elements untouched, so the next run archives the same changes.
        archived = archive_gp(conn, store, raw, source=source, run_at=now, run_id=run.id)
        # Space-Track is the full catalog: replace. CelesTrak is partial: upsert only.
        run.rows = write_gp(
            conn, records, source, replace=(source == "spacetrack"),
            minimum=settings.min_gp_rows_spacetrack if source == "spacetrack" else None,
        )
        write_snapshots(conn, store, now)
    log.info("ingest_gp wrote %d element sets and archived %d new ones", run.rows, archived)
    return GpIngestResult(written=run.rows, archived=archived)
```

In `api/app/jobs.py`, replace the GP branch of `run_job` with:

```python
        if name in ("ingest-gp", "all"):
            gp = run_ingest_gp(conn, spacetrack=spacetrack, celestrak=celestrak,
                               store=store, settings=settings)
            result["ingest_gp"] = gp.written
            result["archived_gp"] = gp.archived
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && uv run pytest -q`
Expected: the whole API suite passes (previously 131 tests, now more), including `test_lambda_jobs.py`.

- [ ] **Step 5: Lint**

Run: `cd api && uv run ruff check . && uv run ruff format --check app tests`
Expected: no findings. (If `format --check` lists files you touched, run `uv run ruff format <those files>` and re-run the tests.)

- [ ] **Step 6: Commit**

```bash
git add api/app/ingest/runlog.py api/app/ingest/gp.py api/app/jobs.py api/tests/test_ingest_gp.py api/tests/test_jobs.py
git commit -m "feat(api): archive new GP element sets before each ingest writes the database"
```

---

### Task 4: Reading the archive back

**Files:**
- Create: `api/app/history/read.py`
- Create: `api/app/history/__main__.py`
- Create: `api/tests/test_history_read.py`

**Interfaces:**
- Consumes: `day_prefix`, `decode_records`, `element_set_id`, `archive_key`, `encode_records` (Task 2); `SnapshotStore.keys`/`get` (Task 1); `load_settings`, `make_store` (`app.config`).
- Produces:
  - `read_history(store: SnapshotStore, start: date, end: date) -> Iterator[dict]`
  - CLI: `python -m app.history dump --from YYYY-MM-DD --to YYYY-MM-DD` (JSON Lines on stdout); `main(argv: list[str] | None = None) -> None` in `app.history.__main__`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_history_read.py`:

```python
import json
from datetime import UTC, date, datetime

from app.config import Settings
from app.history import __main__ as cli
from app.history.archive import archive_key, encode_records
from app.history.read import read_history


def omm(norad_id: str, epoch: str, **extra) -> dict:
    return {"NORAD_CAT_ID": norad_id, "EPOCH": epoch, **extra}


def put_run(store, run_at: datetime, run_id: int, records: list[dict], source="spacetrack"):
    store.put(archive_key(run_at, source, run_id), encode_records(records))


def test_round_trips_every_field(store):
    record = omm("25544", "2026-09-22T06:30:37.496448", TLE_LINE1="1 25544U", GP_ID="284716723")
    put_run(store, datetime(2026, 9, 25, 0, 41, tzinfo=UTC), 1, [record])
    assert list(read_history(store, date(2026, 9, 25), date(2026, 9, 25))) == [record]


def test_repeats_and_older_epochs_are_dropped(store):
    first = omm("25544", "2026-09-25T00:10:00")
    unknown = omm("999999", "2026-09-24T00:00:00")
    put_run(store, datetime(2026, 9, 25, 0, 41, tzinfo=UTC), 1, [first, unknown])
    # A retried run re-archives `first`; the unknown object repeats until SATCAT knows it.
    put_run(store, datetime(2026, 9, 25, 6, 41, tzinfo=UTC), 2, [first, unknown])
    newer = omm("25544", "2026-09-25T06:00:00")
    put_run(store, datetime(2026, 9, 25, 12, 41, tzinfo=UTC), 3,
            [newer, omm("25544", "2026-09-24T00:00:00")])
    out = list(read_history(store, date(2026, 9, 25), date(2026, 9, 25)))
    assert out == [first, unknown, newer]


def test_date_range_is_inclusive_utc_days(store):
    for day in (24, 25, 26, 27):
        put_run(store, datetime(2026, 9, day, 0, 41, tzinfo=UTC), day,
                [omm(str(day), f"2026-09-{day}T00:00:00")])
    out = list(read_history(store, date(2026, 9, 25), date(2026, 9, 26)))
    assert [r["NORAD_CAT_ID"] for r in out] == ["25", "26"]


def test_missing_days_and_empty_files_read_as_nothing(store):
    assert list(read_history(store, date(2026, 9, 1), date(2026, 9, 30))) == []
    put_run(store, datetime(2026, 9, 25, 0, 41, tzinfo=UTC), 1, [])  # a run with nothing new
    assert list(read_history(store, date(2026, 9, 25), date(2026, 9, 25))) == []
    assert list(read_history(store, date(2026, 9, 26), date(2026, 9, 25))) == []  # end < start


def test_dump_prints_json_lines(store, monkeypatch, capsys):
    record = omm("25544", "2026-09-22T06:30:37.496448")
    put_run(store, datetime(2026, 9, 25, 0, 41, tzinfo=UTC), 1, [record])
    monkeypatch.setattr(cli, "load_settings", lambda: Settings())
    monkeypatch.setattr(cli, "make_store", lambda settings: store)
    cli.main(["dump", "--from", "2026-09-25", "--to", "2026-09-25"])
    lines = capsys.readouterr().out.splitlines()
    assert [json.loads(line) for line in lines] == [record]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_history_read.py -v`
Expected: FAIL at import: `ModuleNotFoundError: No module named 'app.history.__main__'` (or `app.history.read`).

- [ ] **Step 3: Implement**

Create `api/app/history/read.py`:

```python
"""Reads the orbit-history archive back (see app.history.archive for the layout)."""
from collections.abc import Iterator
from datetime import date, datetime, timedelta

from app.history.archive import day_prefix, decode_records, element_set_id
from app.ingest.snapshot import SnapshotStore


def read_history(store: SnapshotStore, start: date, end: date) -> Iterator[dict]:
    """Element sets archived on UTC days start..end (inclusive), in archive order.

    A record is yielded only if its epoch is later than the last one yielded for its NORAD ID:
    the recorder only archives epochs newer than the stored one, so repeats (a retried run, an
    object not yet in the catalogue) always carry an epoch already seen. Memory stays one entry
    per object however long the range."""
    last: dict[int, datetime] = {}
    day = start
    while day <= end:
        for key in store.keys(day_prefix(day)):
            data = store.get(key) if key.endswith(".jsonl.gz") else None
            if data is None:
                continue
            for record in decode_records(data):
                ident = element_set_id(record)
                if ident is None:
                    continue
                norad_id, epoch = ident
                previous = last.get(norad_id)
                if previous is not None and epoch <= previous:
                    continue
                last[norad_id] = epoch
                yield record
        day += timedelta(days=1)
```

Create `api/app/history/__main__.py`:

```python
"""python -m app.history dump --from YYYY-MM-DD --to YYYY-MM-DD

Prints archived element sets as JSON Lines. Reads the local snapshot directory, or the S3 bucket
when SNAPSHOT_BUCKET is set (with AWS credentials in the environment)."""
import argparse
import json
import sys
from datetime import date

from app.config import load_settings, make_store
from app.history.read import read_history


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.history",
                                     description="Read the orbit-history archive.")
    commands = parser.add_subparsers(dest="command", required=True)
    dump = commands.add_parser("dump", help="print element sets for UTC days as JSON Lines")
    dump.add_argument("--from", dest="start", type=date.fromisoformat, required=True)
    dump.add_argument("--to", dest="end", type=date.fromisoformat, required=True)
    args = parser.parse_args(argv)
    store = make_store(load_settings())
    for record in read_history(store, args.start, args.end):
        sys.stdout.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && uv run pytest tests/test_history_read.py -v && uv run pytest -q && uv run ruff check .`
Expected: all PASS, no lint findings.

- [ ] **Step 5: Commit**

```bash
git add api/app/history/read.py api/app/history/__main__.py api/tests/test_history_read.py
git commit -m "feat(api): read the orbit-history archive back (read_history, dump CLI)"
```

---

### Task 5: Ship and verify the first real runs

**Files:** none (deployment and checks). Pushing to `main` deploys (`.github/workflows/deploy.yml` runs on `api/**` changes), so **ask the owner before pushing**.

- [ ] **Step 1: Final local check**

Run: `cd api && uv run pytest -q && uv run ruff check .`
Expected: all tests pass, no lint findings.

- [ ] **Step 2: With the owner's go-ahead, push and watch the deploy**

```bash
git push origin main
gh run list -R namelessmonarch0/kessler --limit 3
gh run watch -R namelessmonarch0/kessler "$(gh run list -R namelessmonarch0/kessler --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')"
```

Expected: the `api` and `deploy` workflows finish with `success`.

- [ ] **Step 3: Find the bucket**

```bash
aws cloudformation describe-stacks --stack-name KesslerApp --region us-east-2 \
  --query "Stacks[0].Outputs[?OutputKey=='SnapshotBucketName'].OutputValue" --output text
```

Expected: the bucket name (use it as `$BUCKET` below).

- [ ] **Step 4: After the next scheduled GP run (00:41, 06:41, 12:41 or 18:41 UTC), check the baseline file**

```bash
aws s3 ls "s3://$BUCKET/history/gp/" --recursive --human-readable | tail -5
aws logs tail /aws/lambda/kessler-jobs --since 2h --region us-east-2 | grep "archived"
```

Expected: one `...-spacetrack-r<id>.jsonl.gz` file of a few MB (the baseline: every on-orbit element set), and a log line `ingest_gp wrote <~30000> element sets and archived <~30000> new ones`.

- [ ] **Step 5: After the following run, check that only changes were archived**

Run the same two commands again.
Expected: a second, smaller file, and an archived count well below the written count.

- [ ] **Step 6: Spot-check a file reads back**

```bash
cd api && SNAPSHOT_BUCKET="$BUCKET" uv run python -m app.history dump --from "$(date -u +%F)" --to "$(date -u +%F)" | head -2
```

Expected: two JSON objects with Space-Track fields (`NORAD_CAT_ID`, `EPOCH`, `TLE_LINE1`, ...). (This needs AWS credentials in the shell; if `load_settings` asks for production parameters, run it with `SSM_PREFIX` unset.)
