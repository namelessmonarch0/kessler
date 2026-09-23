from dataclasses import dataclass

import psycopg
from psycopg import sql

from app.domain.orbits import OBJECT_TYPES, REGIMES
from app.errors import ApiError

FIRST_YEAR = 1957


@dataclass(frozen=True)
class Filters:
    owners: tuple[str, ...] | None
    types: tuple[str, ...] | None
    regimes: tuple[str, ...] | None

    def where(self) -> tuple[sql.Composable, dict]:
        """SQL condition over columns owner / object_type / regime (valid for both
        yearly_stats and objects)."""
        parts: list[sql.Composable] = [sql.SQL("TRUE")]
        params: dict = {}
        if self.owners:
            parts.append(sql.SQL("owner = ANY(%(f_owners)s)"))
            params["f_owners"] = list(self.owners)
        if self.types:
            parts.append(sql.SQL("object_type = ANY(%(f_types)s)"))
            params["f_types"] = list(self.types)
        if self.regimes:
            parts.append(sql.SQL("regime = ANY(%(f_regimes)s)"))
            params["f_regimes"] = list(self.regimes)
        return sql.SQL(" AND ").join(parts), params


def _split(value: str | None) -> tuple[str, ...] | None:
    items = tuple(dict.fromkeys(s.strip().upper() for s in (value or "").split(",") if s.strip()))
    return items or None


def _reject_control_chars(value: str | None) -> None:
    # psycopg/Postgres reject NUL bytes outright and would otherwise surface as a 500.
    if value and any(ord(c) < 32 for c in value):
        raise ApiError(422, "invalid_filter", "filter value contains invalid control characters")


def parse_filters(
    conn: psycopg.Connection, owners: str | None, types: str | None, regimes: str | None
) -> Filters:
    for value in (owners, types, regimes):
        _reject_control_chars(value)
    f = Filters(_split(owners), _split(types), _split(regimes))
    for t in f.types or ():
        if t not in OBJECT_TYPES:
            raise ApiError(422, "invalid_filter",
                           f"unknown object type '{t}' (expected one of {', '.join(OBJECT_TYPES)})")
    for r in f.regimes or ():
        if r not in REGIMES:
            raise ApiError(422, "invalid_filter",
                           f"unknown regime '{r}' (expected one of {', '.join(REGIMES)})")
    if f.owners:
        known = {
            row["code"]
            for row in conn.execute(
                "SELECT code FROM owners WHERE code = ANY(%s)", (list(f.owners),)
            ).fetchall()
        }
        unknown = [o for o in f.owners if o not in known]
        if unknown:
            raise ApiError(422, "invalid_filter", f"unknown owner code '{unknown[0]}'")
    return f


def parse_year_range(
    from_year: int | None, to_year: int | None, current_year: int
) -> tuple[int, int]:
    start = FIRST_YEAR if from_year is None else from_year
    end = current_year if to_year is None else to_year
    if not (FIRST_YEAR <= start <= current_year and FIRST_YEAR <= end <= current_year):
        raise ApiError(422, "invalid_range",
                       f"years must be between {FIRST_YEAR} and {current_year}")
    if start > end:
        raise ApiError(422, "invalid_range", f"'from' ({start}) is after 'to' ({end})")
    return start, end
