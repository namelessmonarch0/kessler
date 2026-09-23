import json
from datetime import UTC, datetime, timedelta

import pytest

from app.config import Settings
from app.ingest.gp import parse_gp_csv, parse_gp_records, run_ingest_gp
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
    assert n == 3
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
    with pytest.raises(SourceError, match="expected at least 100"):
        run_ingest_gp(
            catalog, spacetrack=FakeSpaceTrack(ST_SAMPLE), celestrak=FakeCelesTrakGp(SAMPLE),
            store=store, settings=s, now=NOW,
        )
    assert gp_rows(catalog) == {}


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
    assert n == 2
    rows = gp_rows(catalog)
    assert set(rows) == {25544, 24876, 29733}          # debris 29733 kept
    assert rows[25544]["source"] == "celestrak"          # refreshed
    assert rows[29733]["source"] == "spacetrack"
    run = catalog.execute("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1").fetchone()
    assert run["source"] == "celestrak" and run["status"] == "ok"


def test_no_spacetrack_credentials_uses_celestrak(catalog, store):
    n = run_ingest_gp(
        catalog, spacetrack=None, celestrak=FakeCelesTrakGp(SAMPLE),
        store=store, settings=SETTINGS, now=NOW,
    )
    assert n == 2
