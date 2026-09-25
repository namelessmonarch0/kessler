import csv
import io
import logging
from collections.abc import Iterable, Mapping
from dataclasses import astuple, dataclass, fields
from datetime import UTC, datetime, timedelta

import psycopg

from app.config import Settings
from app.domain.orbits import parse_epoch
from app.ingest.runlog import last_success, run_log
from app.ingest.snapshot import SnapshotStore, write_snapshots
from app.ingest.sources import SourceError

log = logging.getLogger(__name__)
FALLBACK_AFTER = timedelta(hours=24)


@dataclass(frozen=True)
class GpRecord:
    norad_id: int
    epoch: datetime
    mean_motion: float
    eccentricity: float
    inclination: float
    raan: float
    arg_pericenter: float
    mean_anomaly: float
    bstar: float
    mean_motion_dot: float
    mean_motion_ddot: float


GP_COLUMNS = tuple(f.name for f in fields(GpRecord))


def parse_gp_records(items: Iterable[Mapping[str, str | None]]) -> list[GpRecord]:
    """Parses OMM mappings (Space-Track JSON objects or CelesTrak CSV rows share field names)."""
    out: list[GpRecord] = []
    skipped = 0
    for d in items:
        try:
            out.append(
                GpRecord(
                    norad_id=int(d["NORAD_CAT_ID"]),
                    epoch=parse_epoch(d["EPOCH"]),
                    mean_motion=float(d["MEAN_MOTION"]),
                    eccentricity=float(d["ECCENTRICITY"]),
                    inclination=float(d["INCLINATION"]),
                    raan=float(d["RA_OF_ASC_NODE"]),
                    arg_pericenter=float(d["ARG_OF_PERICENTER"]),
                    mean_anomaly=float(d["MEAN_ANOMALY"]),
                    bstar=float(d["BSTAR"]),
                    mean_motion_dot=float(d["MEAN_MOTION_DOT"]),
                    mean_motion_ddot=float(d["MEAN_MOTION_DDOT"]),
                )
            )
        except (KeyError, TypeError, ValueError):
            skipped += 1
    if skipped:
        log.warning("skipped %d malformed GP rows", skipped)
    return out


def parse_gp_csv(text: str) -> list[GpRecord]:
    return parse_gp_records(csv.DictReader(io.StringIO(text)))


def write_gp(
    conn: psycopg.Connection, records: list[GpRecord], source: str, *, replace: bool,
    minimum: int | None = None,
) -> int:
    """Writes parsed GP records, matched against known objects.

    When `minimum` is given (the Space-Track replace path), the *written* rowcount is
    checked against it before the transaction commits: the `WHERE norad_id IN (...)` join
    can drop far more rows than the parse-level floor ever sees (e.g. GP ingested before
    the first SATCAT ingest), which would otherwise silently replace gp_elements with an
    almost-empty table while the run still logs "ok".
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
        if replace:
            conn.execute("DELETE FROM gp_elements")
        cur = conn.execute(
            f"""
            INSERT INTO gp_elements ({cols}, source, fetched_at)
            SELECT DISTINCT ON (norad_id) {cols}, source, now() FROM gp_in
            WHERE norad_id IN (SELECT norad_id FROM objects)
            ORDER BY norad_id, epoch DESC
            ON CONFLICT (norad_id) DO UPDATE SET {updates}
            """
        )
        written = cur.rowcount
        dropped = len(records) - written
        if dropped:
            log.warning("dropped %d GP records for unknown norad_ids", dropped)
        if minimum is not None and written < minimum:
            raise SourceError(
                f"{source} GP write matched only {written} known objects, expected at "
                f"least {minimum}; keeping previous data"
            )
        return written


def fetch_gp(
    conn: psycopg.Connection, spacetrack, celestrak, now: datetime, min_spacetrack_rows: int
) -> tuple[str, list[GpRecord]]:
    """Fetches GP records, preferring Space-Track. The Space-Track row floor is applied
    here, inside the try, so a short/garbage payload (no HTTP error, just too few rows)
    goes through the same last-success/24h fallback rule as an outright fetch failure."""
    if spacetrack is not None:
        try:
            records = parse_gp_records(spacetrack.gp_all_on_orbit())
            if len(records) < min_spacetrack_rows:
                raise SourceError(
                    f"spacetrack returned {len(records)} GP records, expected at least "
                    f"{min_spacetrack_rows}; keeping previous data"
                )
            return "spacetrack", records
        except SourceError:
            last_ok = last_success(conn, "ingest_gp", "spacetrack")
            if last_ok is not None and now - last_ok < FALLBACK_AFTER:
                raise
            log.warning("Space-Track unavailable for over 24 h; falling back to CelesTrak")
    return "celestrak", parse_gp_csv(celestrak.gp_active_csv())


def run_ingest_gp(
    conn: psycopg.Connection,
    *,
    spacetrack,
    celestrak,
    store: SnapshotStore,
    settings: Settings,
    now: datetime | None = None,
) -> int:
    now = now or datetime.now(UTC)
    with run_log(conn, "ingest_gp") as run:
        source, records = fetch_gp(
            conn, spacetrack, celestrak, now, settings.min_gp_rows_spacetrack
        )
        run.source = source
        if source == "celestrak" and len(records) < settings.min_gp_rows_celestrak:
            raise SourceError(
                f"celestrak returned {len(records)} GP records, expected at least "
                f"{settings.min_gp_rows_celestrak}; keeping previous data"
            )
        # Space-Track is the full catalog: replace. CelesTrak is partial: upsert only.
        run.rows = write_gp(
            conn, records, source, replace=(source == "spacetrack"),
            minimum=settings.min_gp_rows_spacetrack if source == "spacetrack" else None,
        )
        write_snapshots(conn, store, now)
    return run.rows
