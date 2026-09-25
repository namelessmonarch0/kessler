import csv
import io
import json
from datetime import UTC, datetime, timedelta

import pytest

from app.config import Settings
from app.history.archive import HISTORY_PREFIX, decode_records
from app.ingest.gp import GpIngestResult, parse_gp_csv, parse_gp_records, run_ingest_gp
from app.ingest.satcat import run_ingest_satcat
from app.ingest.snapshot import (
    LocalSnapshotStore,
    snapshot_key,
    unpack_snapshot,
)
from app.ingest.sources import SourceError
from tests.conftest import FIXTURES
from tests.test_ingest_satcat import SAMPLE, FakeCelesTrak

ST_SAMPLE = json.loads((FIXTURES / "gp_spacetrack_sample.json").read_text())
CT_SAMPLE = (FIXTURES / "gp_celestrak_sample.csv").read_text()
NOW = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)
SETTINGS = Settings(min_satcat_rows=10, min_gp_rows_spacetrack=3, min_gp_rows_celestrak=1)


class FakeSpaceTrack:
    def __init__(self, data=None, error: Exception | None = None):
        self.data, self.error = data, error

    def gp_all_on_orbit(self):
        if self.error:
            raise self.error
        return self.data


class FakeCelesTrakGp(FakeCelesTrak):
    def gp_active_csv(self) -> str:
        return CT_SAMPLE


@pytest.fixture
def catalog(conn):
    run_ingest_satcat(conn, celestrak=FakeCelesTrak(SAMPLE), settings=SETTINGS)
    return conn


@pytest.fixture
def store(tmp_path):
    return LocalSnapshotStore(tmp_path)


def gp_rows(conn):
    return {r["norad_id"]: r for r in conn.execute("SELECT * FROM gp_elements").fetchall()}


def test_parse_gp_records_and_csv():
    recs = {r.norad_id: r for r in parse_gp_records(ST_SAMPLE)}
    assert recs[25544].mean_motion == pytest.approx(15.49224498)
    assert recs[25544].epoch == datetime(2026, 9, 22, 6, 30, 37, 496448, tzinfo=UTC)
    csv_recs = {r.norad_id: r for r in parse_gp_csv(CT_SAMPLE)}
    assert csv_recs[24876].mean_motion_dot == pytest.approx(0.52e-6)


def test_parse_gp_skips_malformed_rows():
    bad = [{"NORAD_CAT_ID": "1", "EPOCH": "not-a-date"}, ST_SAMPLE[0]]
    assert [r.norad_id for r in parse_gp_records(bad)] == [25544]


def test_spacetrack_ingest_replaces_and_skips_unknown_objects(catalog, store):
    n = run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    assert n.written == 3
    rows = gp_rows(catalog)
    assert set(rows) == {25544, 24876, 29733}
    assert rows[25544]["source"] == "spacetrack"


def test_snapshots_are_written_per_group(catalog, store):
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    header, records = unpack_snapshot(store.get(snapshot_key("LEO")))
    assert header["version"] == 1 and header["count"] == 2
    by_id = {r[0]: r for r in records}
    assert set(by_id) == {25544, 29733}
    iss = by_id[25544]
    assert header["owners"][iss[1]] == "ISS"
    assert header["types"][iss[2]] == "PAY"
    assert iss[4] == pytest.approx(15.49224498)
    high_header, high_records = unpack_snapshot(store.get(snapshot_key("HIGH")))
    assert [r[0] for r in high_records] == [24876]


def test_too_few_spacetrack_rows_keeps_data(catalog, store):
    s = Settings(min_satcat_rows=10, min_gp_rows_spacetrack=100, min_gp_rows_celestrak=1)
    # A recent Space-Track success means the row-floor failure below must stay within the
    # 24h grace window: it raises rather than silently falling back to CelesTrak.
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    before = gp_rows(catalog)
    with pytest.raises(SourceError, match="expected at least 100"):
        run_ingest_gp(
            catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
            store=store, settings=s, now=NOW,
        )
    assert gp_rows(catalog) == before


def test_short_spacetrack_payload_after_24h_falls_back_to_celestrak(catalog, store):
    # No prior successful ingest_gp run at all: last_success is None, so the 24h grace
    # window never applies and a too-short Space-Track payload falls straight through
    # to CelesTrak within the same run (instead of just failing the run outright).
    s = Settings(min_satcat_rows=10, min_gp_rows_spacetrack=100, min_gp_rows_celestrak=1)
    n = run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=s, now=NOW,
    )
    assert n.written == 2
    rows = gp_rows(catalog)
    assert set(rows) == {25544, 24876}
    assert rows[25544]["source"] == "celestrak"
    run = catalog.execute("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1").fetchone()
    assert run["source"] == "celestrak" and run["status"] == "ok"


def test_spacetrack_failure_within_24h_keeps_data(catalog, store):
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    before = gp_rows(catalog)
    with pytest.raises(SourceError, match="login failed"):
        run_ingest_gp(
            catalog, spacetrack=FakeSpaceTrack(error=SourceError("Space-Track login failed")),
            celestrak=FakeCelesTrakGp(SAMPLE), store=store, settings=SETTINGS,
            now=datetime.now(UTC),
        )
    assert gp_rows(catalog) == before


def test_celestrak_fallback_upserts_without_deleting(catalog, store):
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    # Pretend the last Space-Track success was 2 days ago.
    catalog.execute(
        "UPDATE ingest_runs SET finished_at = %s WHERE job = 'ingest_gp'",
        (datetime.now(UTC) - timedelta(days=2),),
    )
    n = run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(error=SourceError("Space-Track GP: HTTP 500")),
        celestrak=FakeCelesTrakGp(SAMPLE), store=store, settings=SETTINGS,
        now=datetime.now(UTC),
    )
    assert n.written == 2
    rows = gp_rows(catalog)
    assert set(rows) == {25544, 24876, 29733}          # debris 29733 kept
    assert rows[25544]["source"] == "celestrak"          # refreshed
    assert rows[29733]["source"] == "spacetrack"
    run = catalog.execute("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1").fetchone()
    assert run["source"] == "celestrak" and run["status"] == "ok"


UNMATCHED_ST_SAMPLE = [
    {
        "NORAD_CAT_ID": str(900000 + i),
        "EPOCH": "2026-09-22T00:00:00",
        "MEAN_MOTION": "15.0",
        "ECCENTRICITY": "0.001",
        "INCLINATION": "51.6",
        "RA_OF_ASC_NODE": "10.0",
        "ARG_OF_PERICENTER": "10.0",
        "MEAN_ANOMALY": "10.0",
        "BSTAR": "0.0001",
        "MEAN_MOTION_DOT": "0.0",
        "MEAN_MOTION_DDOT": "0.0",
    }
    for i in range(3)
]


def test_spacetrack_write_floor_rolls_back_when_no_objects_match(catalog, store):
    # Parses fine and clears the row-floor on the parsed payload, but none of these
    # norad_ids exist in `objects`, so the write (which replaces gp_elements for
    # Space-Track) would otherwise commit 0 rows and silently wipe the table.
    run_ingest_gp(
        catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    before = gp_rows(catalog)
    with pytest.raises(SourceError, match="expected at least"):
        run_ingest_gp(
            catalog, spacetrack=FakeSpaceTrack(UNMATCHED_ST_SAMPLE),
            celestrak=FakeCelesTrakGp(SAMPLE), store=store, settings=SETTINGS, now=NOW,
        )
    assert gp_rows(catalog) == before


def test_no_spacetrack_credentials_uses_celestrak(catalog, store):
    n = run_ingest_gp(
        catalog, spacetrack=None, celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    assert n.written == 2


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
