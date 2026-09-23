import csv
import io
from collections.abc import Mapping
from dataclasses import astuple, dataclass, fields
from datetime import date

import psycopg

from app.config import Settings
from app.domain.catalog import (
    CatalogYearIndex,
    EventRef,
    first_seen_year,
    link_event,
    parent_cospar,
)
from app.domain.orbits import OBJECT_TYPES, classify_regime, rcs_size
from app.ingest.runlog import run_log
from app.ingest.sources import SourceError
from app.seeds import load_seeds

REQUIRED_COLUMNS = {
    "OBJECT_NAME", "OBJECT_ID", "NORAD_CAT_ID", "OBJECT_TYPE", "OPS_STATUS_CODE", "OWNER",
    "LAUNCH_DATE", "LAUNCH_SITE", "DECAY_DATE", "PERIOD", "INCLINATION", "APOGEE", "PERIGEE",
    "RCS", "ORBIT_CENTER",
}


@dataclass(frozen=True)
class SatcatRow:
    norad_id: int
    cospar_id: str | None
    name: str
    object_type: str
    ops_status: str | None
    owner: str
    launch_date: date | None
    launch_site: str | None
    decay_date: date | None
    period: float | None
    inclination: float | None
    apogee: float | None
    perigee: float | None
    rcs: float | None
    orbit_center: str | None


@dataclass(frozen=True)
class ObjectRecord:
    norad_id: int
    cospar_id: str | None
    name: str
    object_type: str
    ops_status: str | None
    owner: str
    launch_date: date | None
    launch_site: str | None
    decay_date: date | None
    period: float | None
    inclination: float | None
    apogee: float | None
    perigee: float | None
    rcs_size: str | None
    regime: str
    orbit_center: str | None
    parent_cospar: str | None
    event_id: str | None
    first_seen_year: int


OBJECT_COLUMNS: tuple[str, ...] = tuple(f.name for f in fields(ObjectRecord))


def _s(value: str | None) -> str | None:
    value = (value or "").strip()
    return value or None


def _f(value: str | None) -> float | None:
    value = _s(value)
    return float(value) if value is not None else None


def _d(value: str | None) -> date | None:
    value = _s(value)
    return date.fromisoformat(value) if value is not None else None


def parse_satcat_csv(text: str) -> list[SatcatRow]:
    reader = csv.DictReader(io.StringIO(text))
    missing = REQUIRED_COLUMNS - set(reader.fieldnames or [])
    if missing:
        raise SourceError(f"SATCAT: missing columns {sorted(missing)}")
    rows: list[SatcatRow] = []
    for r in reader:
        norad_id = int(r["NORAD_CAT_ID"])
        object_type = _s(r["OBJECT_TYPE"]) or "UNK"
        rows.append(
            SatcatRow(
                norad_id=norad_id,
                cospar_id=_s(r["OBJECT_ID"]),
                name=_s(r["OBJECT_NAME"]) or f"NORAD {norad_id}",
                object_type=object_type if object_type in OBJECT_TYPES else "UNK",
                ops_status=_s(r["OPS_STATUS_CODE"]),
                owner=_s(r["OWNER"]) or "UNK",
                launch_date=_d(r["LAUNCH_DATE"]),
                launch_site=_s(r["LAUNCH_SITE"]),
                decay_date=_d(r["DECAY_DATE"]),
                period=_f(r["PERIOD"]),
                inclination=_f(r["INCLINATION"]),
                apogee=_f(r["APOGEE"]),
                perigee=_f(r["PERIGEE"]),
                rcs=_f(r["RCS"]),
                orbit_center=_s(r["ORBIT_CENTER"]),
            )
        )
    return rows


def load_event_index(conn: psycopg.Connection) -> dict[str, EventRef]:
    rows = conn.execute(
        "SELECT id, parent_cospar, extract(year FROM event_date)::int AS year FROM breakup_events"
    ).fetchall()
    return {r["parent_cospar"]: EventRef(r["id"], r["year"]) for r in rows}


def derive_objects(rows: list[SatcatRow], events: Mapping[str, EventRef]) -> list[ObjectRecord]:
    index = CatalogYearIndex(
        (r.norad_id, r.launch_date) for r in rows if r.object_type == "PAY" and r.launch_date
    )
    out: list[ObjectRecord] = []
    for r in rows:
        catalog_year = index.year_for(r.norad_id)
        parent = parent_cospar(r.cospar_id)
        event = link_event(r.object_type, parent, catalog_year, events)
        out.append(
            ObjectRecord(
                norad_id=r.norad_id,
                cospar_id=r.cospar_id,
                name=r.name,
                object_type=r.object_type,
                ops_status=r.ops_status,
                owner=r.owner,
                launch_date=r.launch_date,
                launch_site=r.launch_site,
                decay_date=r.decay_date,
                period=r.period,
                inclination=r.inclination,
                apogee=r.apogee,
                perigee=r.perigee,
                rcs_size=rcs_size(r.rcs),
                regime=classify_regime(r.apogee, r.perigee, r.orbit_center),
                orbit_center=r.orbit_center,
                parent_cospar=parent,
                event_id=event.id if event else None,
                first_seen_year=first_seen_year(
                    launch_year=r.launch_date.year if r.launch_date else None,
                    catalog_year=catalog_year,
                    event_year=event.year if event else None,
                    decay_year=r.decay_date.year if r.decay_date else None,
                ),
            )
        )
    return out


def upsert_objects(conn: psycopg.Connection, records: list[ObjectRecord]) -> None:
    """Must be called inside a transaction."""
    owners = sorted({r.owner for r in records})
    sites = sorted({r.launch_site for r in records if r.launch_site})
    conn.execute(
        "INSERT INTO owners (code, name) SELECT c, c FROM unnest(%s::text[]) AS c "
        "ON CONFLICT (code) DO NOTHING",
        (owners,),
    )
    conn.execute(
        "INSERT INTO launch_sites (code, name) SELECT c, c FROM unnest(%s::text[]) AS c "
        "ON CONFLICT (code) DO NOTHING",
        (sites,),
    )
    cols = ", ".join(OBJECT_COLUMNS)
    updates = ", ".join(f"{c} = EXCLUDED.{c}" for c in OBJECT_COLUMNS if c != "norad_id")
    conn.execute("CREATE TEMP TABLE objects_in (LIKE objects INCLUDING DEFAULTS) ON COMMIT DROP")
    with conn.cursor() as cur, cur.copy(f"COPY objects_in ({cols}) FROM STDIN") as copy:
        for r in records:
            copy.write_row(astuple(r))
    conn.execute(
        f"INSERT INTO objects ({cols}) SELECT {cols} FROM objects_in "
        f"ON CONFLICT (norad_id) DO UPDATE SET {updates}, updated_at = now()"
    )


def run_ingest_satcat(conn: psycopg.Connection, *, celestrak, settings: Settings) -> int:
    with run_log(conn, "ingest_satcat", source="celestrak") as run:
        rows = parse_satcat_csv(celestrak.satcat_csv())
        if len(rows) < settings.min_satcat_rows:
            raise SourceError(
                f"SATCAT returned {len(rows)} rows, expected at least "
                f"{settings.min_satcat_rows}; keeping previous data"
            )
        with conn.transaction():
            load_seeds(conn)
            records = derive_objects(rows, load_event_index(conn))
            upsert_objects(conn, records)
        run.rows = len(records)
    return run.rows
