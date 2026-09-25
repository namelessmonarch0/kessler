import httpx
import pytest
import respx

from app.config import Settings
from app.ingest.snapshot import LocalSnapshotStore, snapshot_key
from app.ingest.sources import (
    CELESTRAK_GP_ACTIVE_URL,
    CELESTRAK_SATCAT_URL,
    SPACETRACK_GP_URL,
    SPACETRACK_LOGIN_URL,
)
from app.jobs import run_job
from tests.conftest import FIXTURES


@respx.mock
def test_run_all_end_to_end(conn, migrated, tmp_path):
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
        result = run_job("all", settings, store=store, http=http)
    assert result == {"ingest_satcat": 20, "rebuild_stats": result["rebuild_stats"],
                      "ingest_gp": 3, "archived_gp": 4}
    assert result["rebuild_stats"] > 0
    assert store.get(snapshot_key("LEO")) is not None


def test_unknown_job_is_rejected(migrated):
    with pytest.raises(ValueError, match="unknown job"):
        run_job("bogus", Settings(database_url=migrated))
