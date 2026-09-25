# Data Correctness (Audit Piece 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stored orbital elements only ever move forward in time, and the globe's snapshots and name lists are published and served as one consistent generation.

**Architecture:** `write_gp` gets an epoch guard, a targeted delete and a pre-delete row floor; a session-level advisory lock serialises GP ingests and globe publication. `app/ingest/snapshot.py` publishes immutable generations (`globe/gen/<gen>/…`) and switches a `globe/current.json` pointer last; the API serves `/globe/current` plus generation-addressed, immutably cached snapshot/names files from S3; the web loads the pointer first. A `publish-globe` job republishes from the database and runs in the deploy workflow so a generation exists right after deploy.

**Tech Stack:** Python 3.12, FastAPI, psycopg 3 (dict rows, autocommit), boto3/S3, pytest + testcontainers Postgres + moto; Next.js/TypeScript, vitest, Playwright; GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-25-data-correctness-design.md`

## Global Constraints

- An element set replaces the stored one only when its epoch is strictly later; equal epochs keep the stored row.
- Space-Track runs delete only rows whose NORAD ID is absent from the payload; CelesTrak runs never delete.
- The row floor (`minimum`) counts incoming records that match known objects and is checked before any delete.
- Generation id: `YYYYMMDDTHHMMSSZ-r<run id>` (UTC); regex `^\d{8}T\d{6}Z-r\d+$`.
- Keys: `globe/gen/<gen>/LEO.bin.gz`, `globe/gen/<gen>/HIGH.bin.gz`, `globe/gen/<gen>/names-LEO.json.gz`, `globe/gen/<gen>/names-HIGH.json.gz`; pointer `globe/current.json`; legacy `globe/LEO.bin.gz`, `globe/HIGH.bin.gz`.
- Pointer JSON: `{"generation", "generated_at" (ISO UTC), "groups": {"LEO": {"count"}, "HIGH": {"count"}}}`; written only after all four files exist.
- Names file: gzip of `{"generated_at", "names": {"<norad id>": "<name>"}}` built from the same rows as the snapshot.
- Cleanup keeps the current generation, the newest one before it, and anything newer; best effort (never fails the run).
- Cache headers: `/globe/current` `public, max-age=60, s-maxage=60`; versioned files `public, max-age=31536000, immutable`; un-versioned files `public, max-age=60, s-maxage=300`.
- API commands from `api/` with `uv run`; web commands from `web/` with `npx`. Lint: `uv run ruff check .` (do not run `ruff format`), `npx tsc --noEmit`, `npx eslint src tests`; keep added Python lines ≤ 100 characters.
- Commit messages end with a blank line and:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01VPsSApUQwExwuTy7VzPMbH`

## Review Focus

- Two GP ingests overlapping (manual run + schedule) must not interleave their writes or publications: pinned in Task 1 (`test_overlapping_runs_wait_for_each_other`).
- A crash between writing LEO and HIGH (or their names) must leave the site on the previous complete generation: pinned in Task 2 (`test_a_failed_file_leaves_the_previous_generation_live`, parametrised over all four files).
- A malicious `gen` value (`../current.json`, `x/../../`) must never reach the store: pinned in Task 4 (`test_versioned_endpoints_reject_malformed_generations`).
- Tabs still running the old frontend during the deploy must keep loading: pinned in Task 4 (`test_unversioned_endpoints_serve_the_current_generation`).
- A tab that switches generation must not show names from the old one: pinned in Task 5 (`fetches names for the current generation and drops names from a previous generation`).

---

### Task 1: Epochs only move forward; GP ingests are serialised (#1)

**Files:**
- Modify: `api/app/ingest/runlog.py` (add `advisory_lock`, `GLOBE_LOCK`)
- Modify: `api/app/ingest/gp.py` (`write_gp`, `run_ingest_gp`)
- Modify: `api/tests/test_ingest_gp.py`

**Interfaces:**
- Produces: `advisory_lock(conn: psycopg.Connection, name: str)` context manager and `GLOBE_LOCK = "kessler.globe"` in `app.ingest.runlog` — Task 3's `run_publish_globe` takes the same lock.
- Produces: `write_gp(...) -> int` keeps its signature; returns rows inserted or updated.

- [ ] **Step 1: Write the failing tests and update the one existing test whose expectation changes**

In `api/tests/test_ingest_gp.py`:

1. Add `import psycopg` next to the other imports and `from app.db import connect` next to the `app.*` imports.

2. In `test_celestrak_fallback_upserts_without_deleting`, the CelesTrak sample has a newer ISS epoch (2026-09-23) but the same NAVSTAR epoch as Space-Track, so only the ISS row changes now. Replace `assert n.written == 2` with:

```python
    assert n.written == 1                                # only the ISS epoch is newer
    assert rows[24876]["source"] == "spacetrack"          # equal epoch: stored row kept
```

(keep the other assertions; add the `rows[24876]` line after `rows = gp_rows(catalog)`.)

3. Append:

```python
class StaleCelesTrakGp(FakeCelesTrak):
    """CelesTrak serving an ISS element set older than the one Space-Track already gave us."""

    def gp_active_csv(self) -> str:
        return CT_SAMPLE.replace("2026-09-23T06:30:37.496448", "2026-09-21T06:00:00.000000")


def test_older_fallback_element_set_does_not_replace_newer(catalog, store):
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    before = gp_rows(catalog)
    result = run_ingest_gp(
        catalog, spacetrack=None, celestrak=StaleCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW + timedelta(hours=6),
    )
    assert result.written == 0
    after = gp_rows(catalog)
    assert after[25544]["epoch"] == before[25544]["epoch"]
    assert after[25544]["source"] == "spacetrack"


def test_spacetrack_run_removes_only_objects_missing_from_the_payload(catalog, store):
    s = Settings(min_satcat_rows=10, min_gp_rows_spacetrack=2, min_gp_rows_celestrak=1)
    kw = dict(celestrak=FakeCelesTrakGp(SAMPLE), store=store, settings=s)
    run_ingest_gp(catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), now=NOW, **kw)
    without_debris = [r for r in ST_SAMPLE if r["NORAD_CAT_ID"] != "29733"]
    result = run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(without_debris), now=NOW + timedelta(hours=6), **kw
    )
    assert set(gp_rows(catalog)) == {25544, 24876}
    assert result.written == 0  # the remaining element sets are unchanged


def test_payload_matching_too_few_objects_deletes_nothing(catalog, store):
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    before = gp_rows(catalog)
    short = [r for r in ST_SAMPLE if r["NORAD_CAT_ID"] in ("25544", "123456", "24876")]
    short = [dict(r, EPOCH="2026-09-23T00:00:00") for r in short]  # 2 known objects < floor of 3
    with pytest.raises(SourceError, match="expected at least 3"):
        run_ingest_gp(
            catalog, spacetrack=FakeSpaceTrack(short), celestrak=FakeCelesTrakGp(SAMPLE),
            store=store, settings=SETTINGS, now=NOW + timedelta(hours=6),
        )
    assert gp_rows(catalog) == before


def test_overlapping_runs_wait_for_each_other(catalog, store, migrated):
    kw = dict(spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
              store=store, settings=SETTINGS, now=NOW)
    with connect(migrated) as other:
        other.execute("SELECT pg_advisory_lock(hashtext('kessler.globe'))")  # another run in flight
        catalog.execute("SET statement_timeout = '500ms'")
        try:
            with pytest.raises(psycopg.errors.QueryCanceled):
                run_ingest_gp(catalog, **kw)
        finally:
            catalog.execute("RESET statement_timeout")
        assert gp_rows(catalog) == {}  # it waited instead of writing alongside the other run
    assert run_ingest_gp(catalog, **kw).written == 3  # the other session ended: the lock is free
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_ingest_gp.py -q`
Expected: failures in `test_celestrak_fallback_upserts_without_deleting` (written is 2), `test_older_fallback_element_set_does_not_replace_newer` (epoch replaced), `test_spacetrack_run_removes_only_objects_missing_from_the_payload` (written 2, not 0), and `test_overlapping_runs_wait_for_each_other` (no lock: the run writes instead of waiting). `test_payload_matching_too_few_objects_deletes_nothing` already passes (the old code rolls back its whole-table delete); it is the regression guard for the new targeted delete.

- [ ] **Step 3: Implement**

In `api/app/ingest/runlog.py`, add below the imports:

```python
GLOBE_LOCK = "kessler.globe"


@contextmanager
def advisory_lock(conn: psycopg.Connection, name: str) -> Iterator[None]:
    """Holds a session-level Postgres advisory lock for the block: runs that take the same lock
    wait for each other (a manual run overlapping the schedule). The lock also ends with the
    connection, so a crashed run cannot leave it held."""
    conn.execute("SELECT pg_advisory_lock(hashtext(%s))", (name,))
    try:
        yield
    finally:
        conn.execute("SELECT pg_advisory_unlock(hashtext(%s))", (name,))
```

In `api/app/ingest/gp.py`:

1. Change the runlog import to `from app.ingest.runlog import GLOBE_LOCK, advisory_lock, last_success, run_log`.

2. Replace `write_gp` with:

```python
def write_gp(
    conn: psycopg.Connection, records: list[GpRecord], source: str, *, replace: bool,
    minimum: int | None = None,
) -> int:
    """Writes parsed GP records for known objects and returns the rows inserted or updated.

    A stored element set is only replaced by one with a strictly later epoch (an equal epoch is
    the same set), so a stale fallback source can never move an object back in time.
    Space-Track runs (`replace`) are the full on-orbit catalog: rows for objects missing from the
    payload are deleted. `minimum` guards that delete: it counts incoming records that match
    known objects and is checked before anything is deleted, so a short or garbage payload
    leaves the table untouched.
    """
    cols = ", ".join(GP_COLUMNS)
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in (*GP_COLUMNS[1:], "source", "fetched_at"))
    with conn.transaction():
        conn.execute(
            "CREATE TEMP TABLE gp_in (LIKE gp_elements INCLUDING DEFAULTS) ON COMMIT DROP"
        )
        with conn.cursor() as cur, cur.copy(f"COPY gp_in ({cols}, source) FROM STDIN") as copy:
            for r in records:
                copy.write_row((*astuple(r), source))
        matched = conn.execute(
            "SELECT count(DISTINCT norad_id) AS n FROM gp_in "
            "WHERE norad_id IN (SELECT norad_id FROM objects)"
        ).fetchone()["n"]
        unknown = len({r.norad_id for r in records}) - matched
        if unknown:
            log.warning("skipped %d GP records for unknown norad_ids", unknown)
        if minimum is not None and matched < minimum:
            raise SourceError(
                f"{source} GP payload matched only {matched} known objects, expected at "
                f"least {minimum}; keeping previous data"
            )
        if replace:
            conn.execute("DELETE FROM gp_elements WHERE norad_id NOT IN (SELECT norad_id FROM gp_in)")
        cur = conn.execute(
            f"""
            INSERT INTO gp_elements ({cols}, source, fetched_at)
            SELECT DISTINCT ON (norad_id) {cols}, source, now() FROM gp_in
            WHERE norad_id IN (SELECT norad_id FROM objects)
            ORDER BY norad_id, epoch DESC
            ON CONFLICT (norad_id) DO UPDATE SET {updates}
            WHERE gp_elements.epoch < EXCLUDED.epoch
            """
        )
        log.info("%s GP: %d records matched the catalog, %d written", source, matched, cur.rowcount)
        return cur.rowcount
```

3. In `run_ingest_gp`, take the lock for the whole run: change `with run_log(conn, "ingest_gp") as run:` to

```python
    with run_log(conn, "ingest_gp") as run, advisory_lock(conn, GLOBE_LOCK):
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && uv run pytest -q && uv run ruff check .`
Expected: all pass (including the history-archive tests in this file and `tests/test_jobs.py`), no lint findings. Check `awk 'length > 100 {print FILENAME": "FNR}' app/ingest/gp.py app/ingest/runlog.py tests/test_ingest_gp.py` prints nothing for lines you added.

- [ ] **Step 5: Commit**

```bash
git add api/app/ingest/runlog.py api/app/ingest/gp.py api/tests/test_ingest_gp.py
git commit -m "fix(api): stored element sets only move forward in time; serialise GP ingests"
```

---

### Task 2: Publish immutable globe generations

**Files:**
- Modify: `api/app/ingest/snapshot.py`
- Modify: `api/app/aws.py` (`S3SnapshotStore.delete`)
- Create: `api/tests/test_snapshot_publish.py`
- Modify: `api/tests/test_store_keys.py`, `api/tests/test_aws.py`, `api/tests/factories.py` (add `add_gp`)

**Interfaces:**
- Consumes: `SnapshotStore.keys(prefix)` (existing).
- Produces (in `app.ingest.snapshot`): `SnapshotStore.delete(key: str) -> None` (missing keys ignored); `POINTER_KEY = "globe/current.json"`; `GENERATIONS_PREFIX = "globe/gen/"`; `GENERATION_PATTERN = r"^\d{8}T\d{6}Z-r\d+$"`; `generation_id(generated_at: datetime, run_id: int) -> str`; `generation_key(generation: str, filename: str) -> str`; `snapshot_file(group: str) -> str` (`"LEO.bin.gz"`); `names_file(group: str) -> str` (`"names-LEO.json.gz"`); `read_pointer(store) -> dict | None`; `publish_generation(conn, store, generated_at: datetime, run_id: int) -> dict[str, int]` (per-group counts); `remove_old_generations(store, current: str) -> None`; `snapshot_key(group)` stays (legacy key); `write_snapshots` stays unchanged in this task (Task 3 removes it).
- Produces (in `tests.factories`): `add_gp(conn, *norad_ids)` — inserts a fixed GP row per ID (epoch 2026-09-22 UTC); Task 4's tests reuse it.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_store_keys.py`:

```python
def test_local_delete_removes_a_key_and_ignores_missing_ones(tmp_path):
    store = LocalSnapshotStore(tmp_path)
    store.put("globe/gen/a/LEO.bin.gz", b"x")
    store.delete("globe/gen/a/LEO.bin.gz")
    store.delete("globe/gen/a/LEO.bin.gz")  # already gone: no error
    assert store.keys("globe/") == []
```

Append to `api/tests/test_aws.py`:

```python
def test_s3_store_delete_removes_a_key_and_ignores_missing_ones(aws):
    boto3.client("s3", region_name=REGION).create_bucket(
        Bucket="snaps", CreateBucketConfiguration={"LocationConstraint": REGION}
    )
    store = S3SnapshotStore("snaps")
    store.put("globe/gen/a/LEO.bin.gz", b"x")
    store.delete("globe/gen/a/LEO.bin.gz")
    store.delete("globe/gen/a/LEO.bin.gz")
    assert store.keys("globe/") == []
```

Append to `api/tests/factories.py`:

```python
GP_SQL = (
    "INSERT INTO gp_elements (norad_id, epoch, mean_motion, eccentricity, inclination, raan, "
    "arg_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot, source) "
    "VALUES (%s, %s, 15.5, 0.001, 53, 10, 20, 30, 0.0001, 0, 0, 'spacetrack')"
)


def add_gp(conn: psycopg.Connection, *norad_ids: int) -> None:
    """A fixed element set (epoch 2026-09-22 UTC) for each object, for snapshot/globe tests."""
    for norad_id in norad_ids:
        conn.execute(GP_SQL, (norad_id, datetime(2026, 9, 22, tzinfo=UTC)))
```

(add `from datetime import UTC, date, datetime` in place of `from datetime import date` at the top of `factories.py`.)

Create `api/tests/test_snapshot_publish.py`:

```python
import gzip
import json
import logging
from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.ingest.snapshot import (
    POINTER_KEY,
    LocalSnapshotStore,
    generation_id,
    generation_key,
    publish_generation,
    read_pointer,
    snapshot_key,
    unpack_snapshot,
)
from tests.factories import add_gp

T0 = datetime(2026, 9, 25, 6, 41, 12, tzinfo=UTC)
FILES = ("LEO.bin.gz", "HIGH.bin.gz", "names-LEO.json.gz", "names-HIGH.json.gz")


def names(store, gen, group):
    return json.loads(gzip.decompress(store.get(generation_key(gen, f"names-{group}.json.gz"))))


class FailingStore(LocalSnapshotStore):
    def __init__(self, root, fail_suffix):
        super().__init__(root)
        self.fail_suffix = fail_suffix

    def put(self, key, data):
        if key.endswith(self.fail_suffix):
            raise OSError("S3 unavailable")
        super().put(key, data)


def test_generation_id_is_utc_time_and_run():
    assert generation_id(T0, 42) == "20260925T064112Z-r42"
    assert generation_id(T0.astimezone(timezone(timedelta(hours=-5))), 7) == "20260925T064112Z-r7"


def test_publish_writes_both_groups_names_and_then_the_pointer(world, store):
    add_gp(world, 1, 2, 3, 4)  # 2 and 3 are decayed in seed_stats_world
    counts = publish_generation(world, store, T0, 42)
    gen = "20260925T064112Z-r42"
    assert counts == {"LEO": 1, "HIGH": 1}
    assert sorted(store.keys(f"globe/gen/{gen}/")) == sorted(generation_key(gen, f) for f in FILES)
    assert read_pointer(store) == {
        "generation": gen, "generated_at": "2026-09-25T06:41:12+00:00",
        "groups": {"LEO": {"count": 1}, "HIGH": {"count": 1}},
    }
    _, leo = unpack_snapshot(store.get(generation_key(gen, "LEO.bin.gz")))
    assert [r[0] for r in leo] == [1]
    assert names(store, gen, "LEO") == {"generated_at": T0.isoformat(), "names": {"1": "ALPHA SAT"}}
    assert names(store, gen, "HIGH")["names"] == {"4": "GAMMA GEO"}


@pytest.mark.parametrize("failing", FILES)
def test_a_failed_file_leaves_the_previous_generation_live(world, tmp_path, failing):
    add_gp(world, 1, 4)
    good = LocalSnapshotStore(tmp_path)
    publish_generation(world, good, T0, 1)
    with pytest.raises(OSError, match="S3 unavailable"):
        publish_generation(world, FailingStore(tmp_path, f"/{failing}"), T0 + timedelta(hours=6), 2)
    assert read_pointer(good)["generation"] == "20260925T064112Z-r1"
    assert len(good.keys("globe/gen/20260925T064112Z-r1/")) == 4  # previous generation intact


def test_cleanup_keeps_current_previous_and_newer_and_drops_legacy_files(world, store):
    add_gp(world, 1, 4)
    store.put(snapshot_key("LEO"), b"legacy")
    store.put(snapshot_key("HIGH"), b"legacy")
    store.put(generation_key("20990101T000000Z-r999", "LEO.bin.gz"), b"from the future")
    for hours, run in ((0, 1), (6, 2), (12, 3)):
        publish_generation(world, store, T0 + timedelta(hours=hours), run)
    gens = {k.split("/")[2] for k in store.keys("globe/gen/")}
    assert gens == {"20260925T184112Z-r3", "20260925T124112Z-r2", "20990101T000000Z-r999"}
    assert store.get(snapshot_key("LEO")) is None and store.get(snapshot_key("HIGH")) is None


def test_cleanup_failure_does_not_fail_the_publication(world, tmp_path, caplog, monkeypatch):
    add_gp(world, 1, 4)
    store = LocalSnapshotStore(tmp_path)
    publish_generation(world, store, T0, 1)

    def broken_delete(key):
        raise OSError("delete denied")

    monkeypatch.setattr(store, "delete", broken_delete)
    with caplog.at_level(logging.WARNING):
        publish_generation(world, store, T0 + timedelta(hours=6), 2)
    assert read_pointer(store)["generation"] == "20260925T124112Z-r2"
    assert "could not remove old globe generations" in caplog.text


def test_read_pointer_is_none_before_the_first_publication(store):
    assert read_pointer(store) is None
    assert store.get(POINTER_KEY) is None
```

(`world` and `store` come from `api/tests/conftest.py`; `world` seeds objects 1 LEO "ALPHA SAT", 2 and 3
decayed, 4 GEO "GAMMA GEO".)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_snapshot_publish.py tests/test_store_keys.py tests/test_aws.py -q`
Expected: import error (`cannot import name 'POINTER_KEY'`) and `AttributeError: ... has no attribute 'delete'`.

- [ ] **Step 3: Implement**

In `api/app/ingest/snapshot.py`:

1. Imports: add `import logging` and change `from datetime import datetime` to `from datetime import UTC, datetime`; add `log = logging.getLogger(__name__)` after the imports.

2. Extend the protocol and the local store:

```python
class SnapshotStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...

    def get(self, key: str) -> bytes | None: ...

    def keys(self, prefix: str) -> list[str]: ...

    def delete(self, key: str) -> None: ...
```

```python
    def delete(self, key: str) -> None:
        (self.root / key).unlink(missing_ok=True)
```

3. Replace `snapshot_key` and add the generation helpers after it:

```python
def snapshot_key(group: str) -> str:
    """Legacy single-file snapshot, served only until the first generation is published."""
    return f"globe/{group}.bin.gz"


POINTER_KEY = "globe/current.json"
GENERATIONS_PREFIX = "globe/gen/"
GENERATION_PATTERN = r"^\d{8}T\d{6}Z-r\d+$"


def generation_id(generated_at: datetime, run_id: int) -> str:
    t = generated_at.astimezone(UTC)
    return f"{t:%Y%m%dT%H%M%S}Z-r{run_id}"


def generation_key(generation: str, filename: str) -> str:
    return f"{GENERATIONS_PREFIX}{generation}/{filename}"


def snapshot_file(group: str) -> str:
    return f"{group}.bin.gz"


def names_file(group: str) -> str:
    return f"names-{group}.json.gz"


def read_pointer(store: SnapshotStore) -> dict | None:
    data = store.get(POINTER_KEY)
    return json.loads(data) if data is not None else None
```

4. Add after `write_snapshots`:

```python
GROUP_ROWS_SQL = """
    SELECT o.norad_id, o.name, o.owner, o.object_type, g.epoch, g.mean_motion, g.eccentricity,
           g.inclination, g.raan, g.arg_pericenter, g.mean_anomaly, g.bstar,
           g.mean_motion_dot, g.mean_motion_ddot
    FROM gp_elements g JOIN objects o USING (norad_id)
    WHERE o.decay_date IS NULL AND o.regime = ANY(%s)
    ORDER BY o.norad_id
"""


def pack_names(rows: list[dict], generated_at: datetime) -> bytes:
    body = {"generated_at": generated_at.isoformat(),
            "names": {str(r["norad_id"]): r["name"] for r in rows}}
    return gzip.compress(json.dumps(body, separators=(",", ":")).encode(), mtime=0)


def publish_generation(
    conn: psycopg.Connection, store: SnapshotStore, generated_at: datetime, run_id: int
) -> dict[str, int]:
    """Publishes the globe as one generation: both groups' snapshots and name lists, all read
    in one database snapshot, then the pointer switch. A failure before the switch leaves the
    previous generation live. Returns the object count per group."""
    generation = generation_id(generated_at, run_id)
    with conn.transaction():
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        groups = {
            group: conn.execute(GROUP_ROWS_SQL, (list(regimes),)).fetchall()
            for group, regimes in SNAPSHOT_GROUPS.items()
        }
    for group, rows in groups.items():
        store.put(generation_key(generation, snapshot_file(group)), pack_snapshot(rows, generated_at))
        store.put(generation_key(generation, names_file(group)), pack_names(rows, generated_at))
    counts = {group: len(rows) for group, rows in groups.items()}
    pointer = {"generation": generation, "generated_at": generated_at.astimezone(UTC).isoformat(),
               "groups": {group: {"count": n} for group, n in counts.items()}}
    store.put(POINTER_KEY, json.dumps(pointer, separators=(",", ":")).encode())
    try:
        remove_old_generations(store, generation)
    except Exception:  # the new generation is live; the next publication retries the cleanup
        log.warning("could not remove old globe generations", exc_info=True)
    return counts


def remove_old_generations(store: SnapshotStore, current: str) -> None:
    """Deletes generations older than the one before `current` (kept for clients mid-load),
    and the legacy single-file snapshots. Generations newer than `current` are never touched."""
    keys = store.keys(GENERATIONS_PREFIX)
    generation_of = {k: k[len(GENERATIONS_PREFIX):].split("/", 1)[0] for k in keys}
    older = sorted({g for g in generation_of.values() if g < current})
    keep = {current, *older[-1:]}
    for key, generation in generation_of.items():
        if generation not in keep and generation < current:
            store.delete(key)
    for group in SNAPSHOT_GROUPS:
        store.delete(snapshot_key(group))
```

(Keep `pack_snapshot`, `unpack_snapshot`, `write_snapshots`, `SNAPSHOT_GROUPS`, `MAGIC`, `RECORD`, `FIELDS` as they
are: the GP ingest still calls `write_snapshots` until Task 3 switches it to `publish_generation`.)

In `api/app/aws.py`, add to `S3SnapshotStore` after `keys`:

```python
    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=key)  # no error when already gone
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && uv run pytest -q && uv run ruff check .`
Expected: all pass (the GP ingest still writes the legacy files through `write_snapshots`); no lint findings;
the line-length check on the files you touched prints nothing.

- [ ] **Step 5: Commit**

```bash
git add api/app/ingest/snapshot.py api/app/aws.py api/tests/test_snapshot_publish.py api/tests/test_store_keys.py api/tests/test_aws.py api/tests/factories.py
git commit -m "feat(api): publish globe snapshots as immutable generations behind a pointer"
```

---

### Task 3: Ingest publishes generations; `publish-globe` job; deploy step

**Files:**
- Modify: `api/app/ingest/gp.py` (call `publish_generation`)
- Modify: `api/app/ingest/snapshot.py` (remove `write_snapshots`; add `run_publish_globe`)
- Modify: `api/app/jobs.py`, `api/app/lambda_jobs.py` (docstring)
- Modify: `.github/workflows/deploy.yml`
- Modify: `api/tests/test_ingest_gp.py`, `api/tests/test_jobs.py`

**Interfaces:**
- Consumes: `publish_generation`, `read_pointer`, `generation_key`, `snapshot_file`, `names_file` (Task 2); `advisory_lock`, `GLOBE_LOCK`, `run_log` (Task 1 / existing).
- Produces: `run_publish_globe(conn, store, now: datetime | None = None) -> int` in `app.ingest.snapshot` (objects published); job name `"publish-globe"` in `app.jobs.JOBS`, result key `"publish_globe"`.

- [ ] **Step 1: Write the failing tests and update the tests that read legacy keys**

In `api/tests/test_ingest_gp.py`:

1. Replace the `snapshot_key` import with `generation_key, read_pointer` (from `app.ingest.snapshot`).

2. Replace `test_snapshots_are_written_per_group` with:

```python
def test_snapshots_are_published_as_one_generation(catalog, store):
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    pointer = read_pointer(store)
    run_id = catalog.execute("SELECT id FROM ingest_runs WHERE job = 'ingest_gp'").fetchone()["id"]
    assert pointer["generation"] == f"20260923T120000Z-r{run_id}"
    assert pointer["groups"] == {"LEO": {"count": 2}, "HIGH": {"count": 1}}
    gen = pointer["generation"]
    header, records = unpack_snapshot(store.get(generation_key(gen, "LEO.bin.gz")))
    assert header["version"] == 1 and header["count"] == 2
    by_id = {r[0]: r for r in records}
    assert set(by_id) == {25544, 29733}
    iss = by_id[25544]
    assert header["owners"][iss[1]] == "ISS"
    assert header["types"][iss[2]] == "PAY"
    assert iss[4] == pytest.approx(15.49224498)
    _, high_records = unpack_snapshot(store.get(generation_key(gen, "HIGH.bin.gz")))
    assert [r[0] for r in high_records] == [24876]
```

3. Append:

```python
class FailingHighStore(LocalSnapshotStore):
    def put(self, key: str, data: bytes) -> None:
        if key.endswith("/HIGH.bin.gz"):
            raise OSError("S3 unavailable")
        super().put(key, data)


def test_failed_publication_keeps_the_previous_generation_and_fails_the_run(catalog, store, tmp_path):
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    first = read_pointer(store)["generation"]
    with pytest.raises(OSError, match="S3 unavailable"):
        run_ingest_gp(
            catalog, spacetrack=FakeSpaceTrack(NEWER_ISS), celestrak=FakeCelesTrakGp(SAMPLE),
            store=FailingHighStore(tmp_path), settings=SETTINGS, now=NOW + timedelta(hours=6),
        )
    assert read_pointer(store)["generation"] == first
    assert store.get(generation_key(first, "HIGH.bin.gz")) is not None
    assert last_run(catalog)["status"] == "failed"
```

In `api/tests/test_jobs.py`:

1. Replace `from app.ingest.snapshot import LocalSnapshotStore, snapshot_key` with `from app.ingest.snapshot import LocalSnapshotStore, read_pointer`.
2. In `test_run_all_end_to_end`, replace `assert store.get(snapshot_key("LEO")) is not None` with `assert read_pointer(store) is not None`.
3. Append (same `respx`/fixture setup as `test_run_all_end_to_end`; copy its mock and settings lines into a helper if you prefer, but do not change their values):

```python
@respx.mock
def test_publish_globe_republishes_from_the_database(conn, migrated, tmp_path):
    respx.get(CELESTRAK_SATCAT_URL).mock(
        return_value=httpx.Response(200, text=(FIXTURES / "satcat_sample.csv").read_text())
    )
    respx.post(SPACETRACK_LOGIN_URL).mock(return_value=httpx.Response(200, text='""'))
    respx.get(SPACETRACK_GP_URL).mock(
        return_value=httpx.Response(200, text=(FIXTURES / "gp_spacetrack_sample.json").read_text())
    )
    respx.get(CELESTRAK_GP_ACTIVE_URL).mock(return_value=httpx.Response(500))
    settings = Settings(
        database_url=migrated, spacetrack_user="u", spacetrack_pass="p",
        min_satcat_rows=10, min_gp_rows_spacetrack=3,
    )
    store = LocalSnapshotStore(tmp_path)
    with httpx.Client() as http:
        run_job("all", settings, store=store, http=http)
        before = read_pointer(store)["generation"]
        gp_calls = respx.calls.call_count
        result = run_job("publish-globe", settings, store=store, http=http)
    assert result == {"publish_globe": 3}
    assert read_pointer(store)["generation"] != before
    assert respx.calls.call_count == gp_calls  # no Space-Track or CelesTrak request
```

(`test_run_all_end_to_end` uses the same `@respx.mock` decorator; `CELESTRAK_SATCAT_URL`, `SPACETRACK_LOGIN_URL`, `SPACETRACK_GP_URL`, `CELESTRAK_GP_ACTIVE_URL`, `FIXTURES`, `respx`, `httpx`, `Settings` and `run_job` are already imported in `test_jobs.py`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_ingest_gp.py tests/test_jobs.py -q`
Expected: `test_snapshots_are_published_as_one_generation` and the failed-publication test fail (the ingest still writes legacy files, so `read_pointer` returns None); `test_run_all_end_to_end` fails the same way; `test_publish_globe_republishes_from_the_database` fails with `ValueError: unknown job 'publish-globe'`.

- [ ] **Step 3: Implement**

In `api/app/ingest/snapshot.py`: delete `write_snapshots`, add `from app.ingest.runlog import GLOBE_LOCK, advisory_lock, run_log` to the imports (`runlog` does not import `snapshot`, so there is no cycle), and add at the end:

```python
def run_publish_globe(
    conn: psycopg.Connection, store: SnapshotStore, now: datetime | None = None
) -> int:
    """Republishes the globe from the database without fetching anything (after a deploy, or to
    repair a failed publication). Takes the same lock as GP ingests."""
    now = now or datetime.now(UTC)
    with run_log(conn, "publish_globe") as run, advisory_lock(conn, GLOBE_LOCK):
        run.source = "database"
        run.rows = sum(publish_generation(conn, store, now, run.id).values())
    return run.rows
```

In `api/app/ingest/gp.py`: change the snapshot import to `from app.ingest.snapshot import SnapshotStore, publish_generation`, and replace `write_snapshots(conn, store, now)` in `run_ingest_gp` with `publish_generation(conn, store, now, run.id)`.

In `api/app/jobs.py`:

1. `JOBS = ("ingest-satcat", "ingest-gp", "rebuild-stats", "publish-globe", "all")`
2. Add `from app.ingest.snapshot import SnapshotStore, run_publish_globe` (merge with the existing `SnapshotStore` import).
3. In `run_job`, after the GP branch:

```python
        if name == "publish-globe":
            result["publish_globe"] = run_publish_globe(conn, store)
```

In `api/app/lambda_jobs.py`, extend the module docstring's second sentence: `The deploy workflow invokes {"job": "migrate"} and then {"job": "publish-globe"}; ...`.

In `.github/workflows/deploy.yml`, after the "Run database migrations" step, add:

```yaml
      - name: Publish the globe from the database
        run: |
          aws lambda invoke --function-name kessler-jobs --cli-binary-format raw-in-base64-out \
            --cli-read-timeout 900 --payload '{"job":"publish-globe"}' out.json > meta.json
          cat out.json
          if grep -q FunctionError meta.json; then echo "globe publish failed"; exit 1; fi
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && uv run pytest -q && uv run ruff check .`
Expected: all pass, no lint findings; line-length check on touched Python files prints nothing.

- [ ] **Step 5: Commit**

```bash
git add api/app/ingest/gp.py api/app/ingest/snapshot.py api/app/jobs.py api/app/lambda_jobs.py .github/workflows/deploy.yml api/tests/test_ingest_gp.py api/tests/test_jobs.py
git commit -m "feat(api): GP ingest publishes globe generations; publish-globe job runs on deploy"
```

---

### Task 4: API serves the pointer and generation-addressed files

**Files:**
- Modify: `api/app/api/routes.py`
- Delete: `api/app/services/globe.py`, `api/tests/test_globe_names.py`
- Create: `api/tests/test_api_globe.py`
- Modify: `api/tests/test_api.py` (remove `test_snapshot_etag_and_404`; its cases move to the new file)

**Interfaces:**
- Consumes: `POINTER_KEY`, `GENERATION_PATTERN`, `generation_key`, `snapshot_file`, `names_file`, `read_pointer`, `snapshot_key`, `publish_generation` (Task 2).
- Produces: `GET /api/globe/current`; `GET /api/globe/snapshot?group&gen`; `GET /api/globe/names?group&gen` (response `{"generated_at", "names"}`).

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_api_globe.py`:

```python
from datetime import UTC, datetime

import pytest

from app.ingest.snapshot import generation_key, publish_generation, snapshot_key
from tests.factories import add_gp

T0 = datetime(2026, 9, 25, 6, 41, 12, tzinfo=UTC)
GEN = "20260925T064112Z-r42"
IMMUTABLE = "public, max-age=31536000, immutable"
CURRENT = "public, max-age=60, s-maxage=300"


@pytest.fixture
def published(world, store):
    add_gp(world, 1, 2, 3, 4)
    publish_generation(world, store, T0, 42)
    return store


def test_current_is_404_until_a_generation_exists(client):
    r = client.get("/api/globe/current")
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"


def test_current_returns_the_pointer(client, published):
    r = client.get("/api/globe/current")
    assert r.status_code == 200
    assert r.json()["generation"] == GEN
    assert r.headers["cache-control"] == "public, max-age=60, s-maxage=60"


def test_versioned_snapshot_is_immutable(client, published):
    r = client.get(f"/api/globe/snapshot?group=LEO&gen={GEN}")
    assert r.status_code == 200
    assert r.content == published.get(generation_key(GEN, "LEO.bin.gz"))
    assert r.headers["cache-control"] == IMMUTABLE
    again = client.get(f"/api/globe/snapshot?group=LEO&gen={GEN}",
                       headers={"If-None-Match": r.headers["etag"]})
    assert again.status_code == 304


def test_versioned_names_come_from_the_generation_not_the_database(client, published, world):
    world.execute("UPDATE objects SET name = 'RENAMED' WHERE norad_id = 1")
    r = client.get(f"/api/globe/names?group=LEO&gen={GEN}")
    assert r.status_code == 200
    assert r.json() == {"generated_at": T0.isoformat(), "names": {"1": "ALPHA SAT"}}
    assert r.headers["cache-control"] == IMMUTABLE


def test_unknown_generation_is_404(client, published):
    other = "20200101T000000Z-r1"
    assert client.get(f"/api/globe/snapshot?group=LEO&gen={other}").status_code == 404
    assert client.get(f"/api/globe/names?group=LEO&gen={other}").status_code == 404


@pytest.mark.parametrize("bad", ["../current.json", "20260925T064112Z-r42/../x", "latest", ""])
def test_versioned_endpoints_reject_malformed_generations(client, published, bad):
    for path in ("snapshot", "names"):
        r = client.get(f"/api/globe/{path}", params={"group": "LEO", "gen": bad})
        assert r.status_code == 422, (path, bad)


def test_unversioned_endpoints_serve_the_current_generation(client, published):
    r = client.get("/api/globe/snapshot?group=HIGH")
    assert r.status_code == 200
    assert r.content == published.get(generation_key(GEN, "HIGH.bin.gz"))
    assert r.headers["cache-control"] == CURRENT
    names = client.get("/api/globe/names?group=HIGH")
    assert names.json()["names"] == {"4": "GAMMA GEO"}
    assert names.headers["cache-control"] == CURRENT


def test_unversioned_snapshot_falls_back_to_the_legacy_file_before_any_generation(client, store):
    store.put(snapshot_key("LEO"), b"\x1f\x8bdata")
    r = client.get("/api/globe/snapshot?group=LEO")
    assert r.status_code == 200 and r.content == b"\x1f\x8bdata"
    assert r.headers["content-type"] == "application/octet-stream"
    assert client.get("/api/globe/snapshot?group=HIGH").status_code == 404
    assert client.get("/api/globe/names?group=LEO").status_code == 404


def test_names_reject_unknown_group(client):
    r = client.get("/api/globe/names?group=MARS")
    assert r.status_code == 422
    assert r.json()["error"]["code"]
```

In `api/tests/test_api.py`: delete `test_snapshot_etag_and_404` and, if `snapshot_key` becomes unused, its import. Delete `api/tests/test_globe_names.py` (its cases are covered above and in `test_snapshot_publish.py`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_api_globe.py -q`
Expected: failures — `/api/globe/current` is 404-by-routing (no route), versioned requests ignore `gen`, cache headers differ.

- [ ] **Step 3: Implement**

In `api/app/api/routes.py`:

1. Imports: replace `from app.ingest.snapshot import SNAPSHOT_GROUPS, snapshot_key` with

```python
from app.ingest.snapshot import (
    GENERATION_PATTERN,
    SNAPSHOT_GROUPS,
    generation_key,
    names_file,
    read_pointer,
    snapshot_file,
    snapshot_key,
)
```

   remove `from app.services.globe import globe_names`, and add `import gzip` and `from typing import Annotated` / `from fastapi import Query` if not already imported (check the existing import lines and merge).

2. Replace the `globe_snapshot` and `globe_names_route` handlers with:

```python
IMMUTABLE = "public, max-age=31536000, immutable"
CURRENT_FILE = "public, max-age=60, s-maxage=300"
Generation = Annotated[str | None, Query(pattern=GENERATION_PATTERN)]


def _globe_file(request: Request, group: str, gen: str | None, filename: str,
                legacy_key: str | None) -> tuple[bytes | None, dict[str, str]]:
    """Reads one globe file: from the requested generation (immutable), or from the current one
    (short-lived), or — before any generation exists — from the legacy key when there is one.
    Returns (None, headers) when the client's ETag still matches."""
    store = request.app.state.store
    if gen is not None:
        key, cache = generation_key(gen, filename), IMMUTABLE
    else:
        pointer = read_pointer(store)
        key = generation_key(pointer["generation"], filename) if pointer else legacy_key
        cache = CURRENT_FILE
    data = store.get(key) if key else None
    if data is None:
        where = f" in generation {gen}" if gen else ""
        raise ApiError(404, "not_found", f"no globe data for group {group}{where}")
    etag = '"' + hashlib.sha1(data).hexdigest() + '"'
    headers = {"ETag": etag, "Cache-Control": cache}
    if request.headers.get("if-none-match") == etag:
        return None, headers
    return data, headers


@router.get("/globe/current")
def globe_current(request: Request, response: Response) -> dict:
    pointer = read_pointer(request.app.state.store)
    if pointer is None:
        raise ApiError(404, "not_found", "no globe generation published yet")
    response.headers["Cache-Control"] = "public, max-age=60, s-maxage=60"
    return pointer


@router.get("/globe/snapshot")
def globe_snapshot(
    request: Request, group: Literal["LEO", "HIGH"] = "LEO", gen: Generation = None
) -> Response:
    assert group in SNAPSHOT_GROUPS
    data, headers = _globe_file(request, group, gen, snapshot_file(group), snapshot_key(group))
    if data is None:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type="application/octet-stream", headers=headers)


@router.get("/globe/names")
def globe_names_route(
    request: Request, group: Literal["LEO", "HIGH"] = "LEO", gen: Generation = None
) -> Response:
    data, headers = _globe_file(request, group, gen, names_file(group), None)
    if data is None:
        return Response(status_code=304, headers=headers)
    return Response(content=gzip.decompress(data), media_type="application/json",
                    headers=headers)
```

   If `last_success`, `json` or `get_conn` become unused in `routes.py` after this, remove only the unused imports (`last_success` is still used by `/health`).

3. Delete `api/app/services/globe.py`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && uv run pytest -q && uv run ruff check .`
Expected: all pass; no lint findings; line-length check prints nothing for your lines.

- [ ] **Step 5: Commit**

```bash
git add -A api/app/api/routes.py api/app/services/globe.py api/tests/test_api_globe.py api/tests/test_api.py api/tests/test_globe_names.py
git commit -m "feat(api): serve globe generations: /globe/current and immutable versioned files"
```

---

### Task 5: The web loads the pointer first

**Files:**
- Modify: `web/src/lib/api.ts`, `web/src/lib/names.ts`, `web/src/components/globe/GlobeSection.tsx`
- Modify: `web/tests/unit/api.test.ts`, `web/tests/unit/names.test.ts`
- Create: `web/tests/fixtures/api/current.json`
- Modify: `web/e2e/explorer.spec.ts`

**Interfaces:**
- Consumes: the API from Task 4.
- Produces: `api.current(): Promise<GlobeCurrent | null>`; `api.snapshot(group, generation?)`; `api.names(group, generation?)`; `GlobeCurrent` type exported from `web/src/lib/api.ts`; `nameCache.useGeneration(generation: string | undefined)`.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("api", …)` block in `web/tests/unit/api.test.ts`:

```ts
  it("reads the globe pointer and treats 404 as no generation yet", async () => {
    stubFetch(Response.json({ error: { code: "not_found", message: "none" } }, { status: 404 }));
    expect(await api.current()).toBeNull();
    const pointer = { generation: "20260925T064112Z-r42", generated_at: "2026-09-25T06:41:12+00:00", groups: { LEO: { count: 1 }, HIGH: { count: 0 } } };
    const fn = stubFetch(Response.json(pointer));
    expect(await api.current()).toEqual(pointer);
    expect((fn.mock.calls[0] as unknown[])[0]).toBe("/api/globe/current");
  });

  it("addresses snapshots and names by generation when given one", async () => {
    const fn = stubFetch(new Response(new Uint8Array([1])));
    await api.snapshot("LEO", "20260925T064112Z-r42");
    expect((fn.mock.calls[0] as unknown[])[0]).toBe("/api/globe/snapshot?group=LEO&gen=20260925T064112Z-r42");
    await api.snapshot("HIGH");
    expect((fn.mock.calls[1] as unknown[])[0]).toBe("/api/globe/snapshot?group=HIGH");
    const names = stubFetch(Response.json({ generated_at: null, names: { "1": "A" } }));
    expect(await api.names("LEO", "20260925T064112Z-r42")).toEqual({ "1": "A" });
    expect((names.mock.calls[0] as unknown[])[0]).toBe("/api/globe/names?group=LEO&gen=20260925T064112Z-r42");
  });
```

Append to `web/tests/unit/names.test.ts` (inside the `describe`):

```ts
  it("fetches names for the current generation and drops names from a previous generation", async () => {
    const fetcher = vi.fn(async (_g: "LEO" | "HIGH", gen?: string) => ({ "1": gen ?? "none" }));
    const c = createNameCache(fetcher);
    c.useGeneration("g1");
    expect((await c.get("LEO"))?.get(1)).toBe("g1");
    c.useGeneration("g1"); // same generation: keeps the cache
    expect(c.peek("LEO")?.get(1)).toBe("g1");
    c.useGeneration("g2");
    expect(c.peek("LEO")).toBeNull();
    expect((await c.get("LEO"))?.get(1)).toBe("g2");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith("LEO", "g2");
  });
```

Create `web/tests/fixtures/api/current.json`:

```json
{"generation":"20260924T004100Z-r42","generated_at":"2026-09-24T00:41:00+00:00","groups":{"LEO":{"count":1},"HIGH":{"count":0}}}
```

In `web/e2e/explorer.spec.ts`, add `"/globe/current": "api/current.json",` to the `map` inside `mockApi`, and add a test:

```ts
test("loads globe snapshots from the published generation", async ({ page }) => {
  const snapshotUrls: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/globe/snapshot")) snapshotUrls.push(r.url());
  });
  await mockApi(page);
  await page.goto("/");
  await expect.poll(() => snapshotUrls.length).toBeGreaterThan(0);
  expect(new URL(snapshotUrls[0]).searchParams.get("gen")).toBe("20260924T004100Z-r42");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run tests/unit/api.test.ts tests/unit/names.test.ts`
Expected: failures (`api.current` is not a function; `useGeneration` is not a function).

- [ ] **Step 3: Implement**

In `web/src/lib/api.ts`, add the type near the other exports and update the `api` object's globe members:

```ts
export interface GlobeCurrent {
  generation: string;
  generated_at: string;
  groups: Record<"LEO" | "HIGH", { count: number }>;
}
```

```ts
  /** The published globe generation, or null before the first one exists. */
  async current(): Promise<GlobeCurrent | null> {
    const res = await fetch("/api/globe/current");
    if (res.status === 404) return null;
    if (!res.ok) throw await toError(res);
    return (await res.json()) as GlobeCurrent;
  },
  names: async (group: "LEO" | "HIGH", generation?: string) =>
    (await getJson<{ generated_at: string | null; names: Record<string, string> }>(`/globe/names${buildQuery({ group, gen: generation })}`)).names,
  async snapshot(group: "LEO" | "HIGH", generation?: string): Promise<Uint8Array | null> {
    const res = await fetch(`/api/globe/snapshot${buildQuery({ group, gen: generation })}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await toError(res);
    return new Uint8Array(await res.arrayBuffer());
  },
```

Replace `web/src/lib/names.ts`'s `createNameCache` and export with:

```ts
export function createNameCache(
  fetcher: (g: Group, generation?: string) => Promise<Record<string, string>>,
  now: () => number = Date.now,
  cooldownMs = 60_000,
) {
  const fresh = (): Record<Group, Entry> => ({
    LEO: { map: null, pending: null, failedAt: null },
    HIGH: { map: null, pending: null, failedAt: null },
  });
  let generation: string | undefined;
  let entries = fresh();
  return {
    /** Names belong to one snapshot generation: switching drops the previous generation's. */
    useGeneration(next: string | undefined) {
      if (next === generation) return;
      generation = next;
      entries = fresh();
    },
    peek: (g: Group) => entries[g].map,
    get(g: Group): Promise<Map<number, string> | null> {
      const e = entries[g];
      if (e.map) return Promise.resolve(e.map);
      if (e.pending) return e.pending;
      if (e.failedAt !== null && now() - e.failedAt < cooldownMs) return Promise.resolve(null);
      e.pending = fetcher(g, generation)
        .then((names) => {
          e.map = new Map(Object.entries(names).map(([k, v]) => [Number(k), v]));
          e.failedAt = null;
          return e.map;
        })
        .catch(() => {
          e.failedAt = now();
          return null;
        })
        .finally(() => {
          e.pending = null;
        });
      return e.pending;
    },
  };
}

export const nameCache = createNameCache((g, generation) => api.names(g, generation));
```

In `web/src/components/globe/GlobeSection.tsx`:

1. Add `import { nameCache } from "@/lib/names";`.
2. Change `fetchGroup` to take the generation:

```ts
async function fetchGroup(group: "LEO" | "HIGH", generation: string | undefined): Promise<OrbitRecord[] | null> {
  const gz = await api.snapshot(group, generation);
  return gz ? (await loadSnapshot(gz)).records : null;
}
```

3. Add state for the loaded generation next to the other `useState` calls in the component: `const [source, setSource] = useState<{ generation: string | undefined } | null>(null);`
4. Replace the LEO effect and the HIGH effect with:

```ts
  useEffect(() => {
    let cancelled = false;
    // Pointer first, so LEO, HIGH and the name labels all come from one published generation.
    // No pointer yet (or it failed): fall back to the un-versioned endpoints.
    api.current()
      .catch(() => null)
      .then((pointer) => {
        const generation = pointer?.generation;
        nameCache.useGeneration(generation);
        if (!cancelled) setSource({ generation });
        return fetchGroup("LEO", generation);
      })
      .then((records) => {
        if (cancelled) return;
        setLeo(records);
        setStatus(records ? "ready" : "missing");
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!wantHigh || high || !source) return;
    fetchGroup("HIGH", source.generation).then(setHigh).catch(() => undefined);
  }, [wantHigh, high, source]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit && npx eslint src tests && npx playwright test`
Expected: all unit tests pass (previously 276), typecheck and lint clean, all e2e tests pass (previously 18, now 19).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/names.ts web/src/components/globe/GlobeSection.tsx web/tests/unit/api.test.ts web/tests/unit/names.test.ts web/tests/fixtures/api/current.json web/e2e/explorer.spec.ts
git commit -m "feat(web): load globe snapshots and names from the published generation"
```

---

### Task 6: Ship and verify (controller, with the owner's go-ahead)

Pushing to `main` deploys (`api/**` triggers `deploy.yml`; `web/**` triggers Vercel). Ask the owner before pushing.

- [ ] **Step 1:** Full local check: `cd api && uv run pytest -q && uv run ruff check .`; `cd infra && uv run pytest -q`; `cd web && npx vitest run && npx tsc --noEmit && npx eslint src tests && npx playwright test`.
- [ ] **Step 2:** With the go-ahead, merge to `main`, push, and watch the `deploy` workflow; expect the new "Publish the globe from the database" step to succeed.
- [ ] **Step 3:** Verify with `AWS_PROFILE=kessler-agent`: `aws s3 cp s3://<bucket>/globe/current.json -` shows a generation; `aws s3 ls s3://<bucket>/globe/` shows no legacy `LEO.bin.gz`/`HIGH.bin.gz`.
- [ ] **Step 4:** Verify the live site: `curl -sI https://kessler.kudayyurter.dev/api/globe/current` → 200 with `max-age=60`; `curl -sI "https://kessler.kudayyurter.dev/api/globe/snapshot?group=LEO&gen=<gen>"` → 200 with `immutable`; load the site in a headless browser and confirm the globe renders and the snapshot request carries `gen=`.
- [ ] **Step 5:** After the next scheduled GP run, confirm a new generation replaced the pointer and at most two generations remain under `globe/gen/`.
