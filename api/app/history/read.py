"""Reads the orbit-history archive back (see app.history.archive for the
layout)."""
from collections.abc import Iterator
from datetime import date, datetime, timedelta

from app.history.archive import day_prefix, decode_records, element_set_id
from app.ingest.snapshot import SnapshotStore


def read_history(store: SnapshotStore, start: date, end: date) -> Iterator[dict]:
    """Element sets archived on UTC days start..end (inclusive), in archive
    order.

    A record is yielded only if its epoch is later than the last one yielded
    for its NORAD ID: the recorder only archives epochs newer than the stored
    one, so repeats (a retried run, an object not yet in the catalogue) always
    carry an epoch already seen. Memory stays one entry per object however
    long the range."""
    last: dict[int, datetime] = {}
    day = start
    while day <= end:
        for key in store.keys(day_prefix(day)):
            data = store.get(key) if key.endswith(".jsonl.gz") else None
            if data is None:
                continue
            for record in decode_records(data):
                ident = element_set_id(record)
                if ident is None:
                    continue
                norad_id, epoch = ident
                previous = last.get(norad_id)
                if previous is not None and epoch <= previous:
                    continue
                last[norad_id] = epoch
                yield record
        day += timedelta(days=1)
