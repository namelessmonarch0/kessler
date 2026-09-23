from collections import defaultdict

import psycopg
from psycopg import sql

from app.services.filters import Filters

OTHER_KEY = "_other"
METRICS = ("in_orbit", "added", "reentered")
GROUP_COLUMNS = {"type": "object_type", "owner": "owner", "regime": "regime"}
NUMERIC_FIELDS = {"perigee": 50.0, "apogee": 50.0, "inclination": 2.0}


def _fold_top(values: dict[str, list[int]], top: int) -> dict[str, list[int]]:
    ranked = sorted(values, key=lambda k: (values[k][-1], sum(values[k])), reverse=True)
    keep, rest = ranked[:top], ranked[top:]
    out = {k: values[k] for k in keep}
    if rest:
        out[OTHER_KEY] = [sum(col) for col in zip(*(values[k] for k in rest), strict=True)]
    return out


def timeseries(
    conn: psycopg.Connection, *, metric: str, group_by: str, filters: Filters,
    from_year: int, to_year: int, top: int = 8,
) -> dict:
    where, params = filters.where()
    key = (
        sql.Identifier(GROUP_COLUMNS[group_by]) if group_by in GROUP_COLUMNS
        else sql.Literal("all")
    )
    query = sql.SQL(
        "SELECT year, {key} AS key, sum({metric})::bigint AS value FROM yearly_stats "
        "WHERE {where} AND year BETWEEN %(y0)s AND %(y1)s GROUP BY year, 2"
    ).format(key=key, metric=sql.Identifier(metric), where=where)
    rows = conn.execute(query, {**params, "y0": from_year, "y1": to_year}).fetchall()
    years = list(range(from_year, to_year + 1))
    values: dict[str, list[int]] = {}
    for r in rows:
        values.setdefault(r["key"], [0] * len(years))[r["year"] - from_year] = int(r["value"])
    values = {k: v for k, v in values.items() if any(v)}
    if group_by == "owner":
        values = _fold_top(values, top)
    order = sorted(values, key=lambda k: (k == OTHER_KEY, -values[k][-1], -sum(values[k])))
    return {
        "metric": metric,
        "group_by": group_by,
        "years": years,
        "series": [{"key": k, "values": values[k]} for k in order],
    }


def breakdown(
    conn: psycopg.Connection, *, at_year: int, by: str, filters: Filters, top: int = 8
) -> dict:
    where, params = filters.where()
    query = sql.SQL(
        "SELECT {key} AS key, object_type, sum(in_orbit)::bigint AS n FROM yearly_stats "
        "WHERE {where} AND year = %(at)s GROUP BY 1, 2 HAVING sum(in_orbit) > 0"
    ).format(key=sql.Identifier(GROUP_COLUMNS[by]), where=where)
    counts: dict[str, dict[str, int]] = defaultdict(dict)
    for r in conn.execute(query, {**params, "at": at_year}).fetchall():
        counts[r["key"]][r["object_type"]] = int(r["n"])
    rows = sorted(
        ({"key": k, "counts": c, "total": sum(c.values())} for k, c in counts.items()),
        key=lambda row: -row["total"],
    )
    if by == "owner" and len(rows) > top:
        other: dict[str, int] = defaultdict(int)
        for row in rows[top:]:
            for t, n in row["counts"].items():
                other[t] += n
        rows = rows[:top] + [{"key": OTHER_KEY, "counts": dict(other),
                              "total": sum(other.values())}]
    return {"at": at_year, "by": by, "rows": rows}


def distribution(
    conn: psycopg.Connection, *, field: str, filters: Filters, bin_width: float | None = None
) -> dict:
    where, params = filters.where()
    if field == "rcs_size":
        query = sql.SQL(
            "SELECT coalesce(rcs_size, 'UNKNOWN') AS key, NULL::float AS start, object_type, "
            "count(*) AS n FROM objects WHERE decay_date IS NULL AND {where} "
            "GROUP BY 1, 2, 3 ORDER BY 1"
        ).format(where=where)
        width = None
    else:
        width = float(bin_width or NUMERIC_FIELDS[field])
        query = sql.SQL(
            "SELECT floor({f} / %(w)s) * %(w)s AS start, object_type, count(*) AS n "
            "FROM objects WHERE decay_date IS NULL AND {f} IS NOT NULL AND {where} "
            "GROUP BY 1, 2 ORDER BY 1"
        ).format(f=sql.Identifier(field), where=where)
        params = {**params, "w": width}
    bins: dict[str, dict] = {}
    for r in conn.execute(query, params).fetchall():
        key = r["key"] if field == "rcs_size" else f"{r['start']:g}"
        b = bins.setdefault(key, {"key": key, "start": r["start"], "counts": {}, "total": 0})
        b["counts"][r["object_type"]] = int(r["n"])
        b["total"] += int(r["n"])
    return {"field": field, "bin_width": width, "bins": list(bins.values())}
