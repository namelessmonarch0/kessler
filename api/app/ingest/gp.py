import csv
import io
import logging
from collections.abc import Iterable, Mapping
from dataclasses import astuple, dataclass, fields
from datetime import UTC, datetime, timedelta
from typing import NamedTuple

import psycopg

from app.config import Settings
from app.domain.orbits import parse_epoch
from app.history.archive import archive_gp
from app.ingest.runlog import GLOBE_LOCK, advisory_lock, last_success, run_log
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


class GpIngestResult(NamedTuple):
    written: int  # element sets written to gp_elements
    archived: int  # new element sets written to the history archive


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
            conn.execute(
                "DELETE FROM gp_elements WHERE norad_id NOT IN "
                "(SELECT norad_id FROM gp_in)"
            )
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
        log.info(
            "%s GP: %d records matched the catalog, %d written", source, matched, cur.rowcount
        )
        return cur.rowcount


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
    with run_log(conn, "ingest_gp") as run, advisory_lock(conn, GLOBE_LOCK):
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
