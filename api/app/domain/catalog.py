from bisect import bisect_right
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date

FIRST_YEAR = 1957


class CatalogYearIndex:
    """Estimates when a catalog number was assigned.

    Catalog numbers are handed out in order, so the latest payload launch year among all
    payloads with a number <= n approximates the year object n entered the catalog.
    """

    def __init__(self, payloads: Iterable[tuple[int, date]]):
        pairs = sorted(payloads)
        self._ids: list[int] = []
        self._years: list[int] = []
        running = 0
        for norad_id, launched in pairs:
            running = max(running, launched.year)
            self._ids.append(norad_id)
            self._years.append(running)

    def year_for(self, norad_id: int) -> int | None:
        i = bisect_right(self._ids, norad_id) - 1
        return self._years[i] if i >= 0 else None


@dataclass(frozen=True)
class EventRef:
    id: str
    year: int


def parent_cospar(cospar_id: str | None) -> str | None:
    """'1999-025AC' -> '1999-025' (the launch the piece came from)."""
    if not cospar_id or len(cospar_id) < 8 or cospar_id[4] != "-":
        return None
    return cospar_id[:8]


def link_event(
    object_type: str,
    parent: str | None,
    catalog_year: int | None,
    events: Mapping[str, EventRef],
) -> EventRef | None:
    if object_type != "DEB" or parent is None or catalog_year is None:
        return None
    event = events.get(parent)
    # Catalog numbers lag launches by up to a year, so allow event_year - 1.
    if event is None or catalog_year < event.year - 1:
        return None
    return event


def first_seen_year(
    launch_year: int | None,
    catalog_year: int | None,
    event_year: int | None,
    decay_year: int | None,
) -> int:
    if event_year is not None:
        year = event_year
    else:
        candidates = [y for y in (launch_year, catalog_year) if y is not None]
        year = max(candidates) if candidates else FIRST_YEAR
    if decay_year is not None:
        year = min(year, decay_year)
    return year
