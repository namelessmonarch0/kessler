import argparse
import json
import logging
from contextlib import ExitStack

import httpx

from app.config import Settings, load_settings, make_store
from app.db import connect
from app.ingest.gp import run_ingest_gp
from app.ingest.satcat import run_ingest_satcat
from app.ingest.snapshot import SnapshotStore
from app.ingest.sources import USER_AGENT, CelesTrakClient, SpaceTrackClient
from app.stats.rebuild import run_rebuild_stats

JOBS = ("ingest-satcat", "ingest-gp", "rebuild-stats", "all")


def run_job(
    name: str,
    settings: Settings,
    *,
    store: SnapshotStore | None = None,
    http: httpx.Client | None = None,
) -> dict[str, int]:
    if name not in JOBS:
        raise ValueError(f"unknown job {name!r}; expected one of {', '.join(JOBS)}")
    store = store or make_store(settings)
    with ExitStack() as stack:
        if http is None:
            http = stack.enter_context(
                httpx.Client(timeout=180, headers={"User-Agent": USER_AGENT},
                             follow_redirects=True)
            )
        conn = stack.enter_context(connect(settings.database_url))
        celestrak = CelesTrakClient(http)
        spacetrack = (
            SpaceTrackClient(http, settings.spacetrack_user, settings.spacetrack_pass)
            if settings.spacetrack_user and settings.spacetrack_pass
            else None
        )
        result: dict[str, int] = {}
        if name in ("ingest-satcat", "all"):
            result["ingest_satcat"] = run_ingest_satcat(conn, celestrak=celestrak,
                                                        settings=settings)
        if name in ("ingest-satcat", "rebuild-stats", "all"):
            result["rebuild_stats"] = run_rebuild_stats(conn)
        if name in ("ingest-gp", "all"):
            result["ingest_gp"] = run_ingest_gp(conn, spacetrack=spacetrack, celestrak=celestrak,
                                                store=store, settings=settings)
        return result


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run a Kessler data job.")
    parser.add_argument("job", choices=JOBS)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    print(json.dumps(run_job(args.job, load_settings())))


if __name__ == "__main__":
    main()
