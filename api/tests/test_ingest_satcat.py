import pytest

from app.config import Settings
from app.domain.catalog import EventRef
from app.ingest.satcat import derive_objects, parse_satcat_csv, run_ingest_satcat
from app.ingest.sources import SourceError
from tests.conftest import FIXTURES

SAMPLE = (FIXTURES / "satcat_sample.csv").read_text()


class FakeCelesTrak:
    def __init__(self, satcat: str):
        self._satcat = satcat

    def satcat_csv(self) -> str:
        if self._satcat.startswith("<html"):
            raise SourceError("CelesTrak SATCAT: unexpected response starting '<html'")
        return self._satcat


def settings(**kw) -> Settings:
    return Settings(min_satcat_rows=kw.pop("min_satcat_rows", 10), **kw)


def test_parse_satcat_csv_types_and_nulls():
    rows = {r.norad_id: r for r in parse_satcat_csv(SAMPLE)}
    assert len(rows) == 20
    luna = rows[114]
    assert luna.orbit_center == "MO"
    assert luna.apogee is None and luna.rcs is None
    iss = rows[25544]
    assert iss.object_type == "PAY" and iss.owner == "ISS"
    assert iss.launch_date.isoformat() == "1998-11-20"
    assert iss.decay_date is None
    assert iss.rcs == pytest.approx(399.0524)


def test_parse_satcat_rejects_missing_columns():
    with pytest.raises(SourceError, match="missing columns"):
        parse_satcat_csv("OBJECT_NAME,NORAD_CAT_ID\nX,1\n")


def test_derive_objects_rules():
    events = {
        "1999-025": EventRef("fengyun-1c-2007", 2007),
        "1982-092": EventRef("kosmos-1408-2021", 2021),
    }
    objs = {o.norad_id: o for o in derive_objects(parse_satcat_csv(SAMPLE), events)}
    assert objs[25544].regime == "LEO"
    assert objs[24876].regime == "MEO"
    assert objs[40258].regime == "GEO"
    assert objs[5].regime == "HEO"
    assert objs[114].regime == "OTHER"
    assert objs[1].first_seen_year == 1957
    assert objs[25544].rcs_size == "LARGE"
    # Fengyun-1C fragments: catalog numbers read 2006, but they are linked to the 2007 test.
    assert objs[29716].event_id == "fengyun-1c-2007"
    assert objs[29716].first_seen_year == 2007
    assert objs[29733].event_id == "fengyun-1c-2007"
    assert objs[29733].first_seen_year == 2007
    # An earlier Kosmos 1408 piece (cataloged ~2014) is not part of the 2021 test.
    assert objs[42060].event_id is None
    assert objs[42060].first_seen_year == 2014
    assert objs[49516].event_id == "kosmos-1408-2021"
    assert objs[49516].first_seen_year == 2021
    # Six-digit catalog numbers are real objects.
    assert objs[100000].first_seen_year == 2026
    assert objs[29716].parent_cospar == "1999-025"


def test_run_ingest_satcat_writes_objects_and_logs(conn):
    n = run_ingest_satcat(conn, celestrak=FakeCelesTrak(SAMPLE), settings=settings())
    assert n == 20
    assert conn.execute("SELECT count(*) AS n FROM objects").fetchone()["n"] == 20
    fy = conn.execute("SELECT * FROM objects WHERE norad_id = 29733").fetchone()
    assert fy["event_id"] == "fengyun-1c-2007"
    # Unknown owner codes are created on the fly with name = code.
    por = conn.execute("SELECT name FROM owners WHERE code = 'POR'").fetchone()
    assert por["name"] == "POR"
    run = conn.execute("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1").fetchone()
    assert (run["job"], run["source"], run["status"], run["rows"]) == (
        "ingest_satcat", "celestrak", "ok", 20,
    )


def test_rerun_is_idempotent(conn):
    run_ingest_satcat(conn, celestrak=FakeCelesTrak(SAMPLE), settings=settings())
    run_ingest_satcat(conn, celestrak=FakeCelesTrak(SAMPLE), settings=settings())
    assert conn.execute("SELECT count(*) AS n FROM objects").fetchone()["n"] == 20


def test_bad_payload_keeps_previous_data(conn):
    run_ingest_satcat(conn, celestrak=FakeCelesTrak(SAMPLE), settings=settings())
    with pytest.raises(SourceError):
        run_ingest_satcat(conn, celestrak=FakeCelesTrak("<html>oops</html>"), settings=settings())
    assert conn.execute("SELECT count(*) AS n FROM objects").fetchone()["n"] == 20
    run = conn.execute("SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 1").fetchone()
    assert run["status"] == "failed" and "unexpected" in run["error"]


def test_too_few_rows_is_rejected(conn):
    with pytest.raises(SourceError, match="expected at least 25"):
        run_ingest_satcat(
            conn, celestrak=FakeCelesTrak(SAMPLE), settings=settings(min_satcat_rows=25)
        )
    assert conn.execute("SELECT count(*) AS n FROM objects").fetchone()["n"] == 0
