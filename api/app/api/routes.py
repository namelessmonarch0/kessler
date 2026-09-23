import hashlib
from datetime import UTC, datetime
from typing import Literal

import psycopg
from fastapi import APIRouter, Depends, Path, Query, Request, Response

from app.errors import ApiError
from app.ingest.runlog import last_success
from app.ingest.snapshot import SNAPSHOT_GROUPS, snapshot_key
from app.services import stats
from app.services.events import list_events
from app.services.filters import parse_filters, parse_year_range
from app.services.meta import get_meta
from app.services.objects import get_object, search_objects

router = APIRouter(prefix="/api")


def get_conn(request: Request):
    yield from request.app.state.db.conn()


def cache(response: Response, seconds: int) -> None:
    response.headers["Cache-Control"] = f"public, max-age=60, s-maxage={seconds}"


def this_year() -> int:
    return datetime.now(UTC).year


@router.get("/health")
def health(conn: psycopg.Connection = Depends(get_conn)) -> dict:
    conn.execute("SELECT 1")
    last_gp = last_success(conn, "ingest_gp")
    age = (datetime.now(UTC) - last_gp).total_seconds() / 3600 if last_gp else None
    return {"status": "ok", "gp_age_hours": age}


@router.get("/meta")
def meta(response: Response, conn: psycopg.Connection = Depends(get_conn)) -> dict:
    cache(response, 600)
    return get_meta(conn)


@router.get("/stats/timeseries")
def timeseries(
    response: Response,
    metric: Literal["in_orbit", "added", "reentered"] = "in_orbit",
    group_by: Literal["none", "type", "owner", "regime"] = "type",
    owners: str | None = None,
    types: str | None = None,
    regimes: str | None = None,
    from_year: int | None = Query(None, alias="from"),
    to_year: int | None = Query(None, alias="to"),
    top: int = Query(8, ge=1, le=30),
    conn: psycopg.Connection = Depends(get_conn),
) -> dict:
    filters = parse_filters(conn, owners, types, regimes)
    y0, y1 = parse_year_range(from_year, to_year, this_year())
    cache(response, 3600)
    return stats.timeseries(conn, metric=metric, group_by=group_by, filters=filters,
                            from_year=y0, to_year=y1, top=top)


@router.get("/stats/breakdown")
def breakdown(
    response: Response,
    by: Literal["owner", "type", "regime"] = "owner",
    at: int | None = None,
    owners: str | None = None,
    types: str | None = None,
    regimes: str | None = None,
    top: int = Query(8, ge=1, le=30),
    conn: psycopg.Connection = Depends(get_conn),
) -> dict:
    filters = parse_filters(conn, owners, types, regimes)
    year, _ = parse_year_range(at, at, this_year()) if at is not None else (this_year(), None)
    cache(response, 3600)
    return stats.breakdown(conn, at_year=year, by=by, filters=filters, top=top)


@router.get("/stats/distribution")
def distribution(
    response: Response,
    field: Literal["perigee", "apogee", "inclination", "rcs_size"] = "perigee",
    bin_width: float | None = Query(None, gt=0, le=10000),
    owners: str | None = None,
    types: str | None = None,
    regimes: str | None = None,
    conn: psycopg.Connection = Depends(get_conn),
) -> dict:
    filters = parse_filters(conn, owners, types, regimes)
    cache(response, 3600)
    return stats.distribution(conn, field=field, filters=filters, bin_width=bin_width)


@router.get("/events")
def events(response: Response, conn: psycopg.Connection = Depends(get_conn)) -> list[dict]:
    cache(response, 3600)
    return list_events(conn)


@router.get("/objects/search")
def objects_search(
    response: Response,
    q: str = Query(..., max_length=100),
    limit: int = Query(20, ge=1, le=50),
    conn: psycopg.Connection = Depends(get_conn),
) -> list[dict]:
    cache(response, 600)
    return search_objects(conn, q, limit)


@router.get("/objects/{norad_id}")
def object_detail(
    response: Response,
    norad_id: int = Path(..., ge=1, le=999_999_999),
    conn: psycopg.Connection = Depends(get_conn),
) -> dict:
    obj = get_object(conn, norad_id)
    if obj is None:
        raise ApiError(404, "not_found", f"no object with NORAD catalog number {norad_id}")
    cache(response, 600)
    return obj


@router.get("/globe/snapshot")
def globe_snapshot(request: Request, group: Literal["LEO", "HIGH"] = "LEO") -> Response:
    assert group in SNAPSHOT_GROUPS
    data = request.app.state.store.get(snapshot_key(group))
    if data is None:
        raise ApiError(404, "not_found", f"no globe snapshot for group {group} yet")
    etag = '"' + hashlib.sha1(data).hexdigest() + '"'
    headers = {"ETag": etag, "Cache-Control": "public, max-age=300, s-maxage=21600"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(content=data, media_type="application/octet-stream", headers=headers)
