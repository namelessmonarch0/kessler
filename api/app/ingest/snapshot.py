import gzip
import json
import logging
import re
import struct
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

import psycopg

from app.domain.orbits import OBJECT_TYPES
from app.ingest.runlog import GLOBE_LOCK, advisory_lock, run_log

log = logging.getLogger(__name__)

MAGIC = b"LEO1"
RECORD = struct.Struct("<IHBx10d")  # 88 bytes
FIELDS = [
    "norad_id", "owner_index", "type_index", "epoch_unix", "mean_motion", "eccentricity",
    "inclination", "raan", "arg_pericenter", "mean_anomaly", "bstar", "mean_motion_dot",
    "mean_motion_ddot",
]
SNAPSHOT_GROUPS: dict[str, tuple[str, ...]] = {"LEO": ("LEO",), "HIGH": ("MEO", "GEO", "HEO")}


class SnapshotStore(Protocol):
    def put(self, key: str, data: bytes) -> None: ...

    def get(self, key: str) -> bytes | None: ...

    def keys(self, prefix: str) -> list[str]: ...

    def delete(self, key: str) -> None: ...


class LocalSnapshotStore:
    def __init__(self, root: str | Path):
        self.root = Path(root)

    def put(self, key: str, data: bytes) -> None:
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)

    def get(self, key: str) -> bytes | None:
        path = self.root / key
        return path.read_bytes() if path.exists() else None

    def keys(self, prefix: str) -> list[str]:
        """Stored keys starting with `prefix`, sorted. Half-written `.tmp` files are not keys."""
        start = self.root / prefix[: prefix.rfind("/") + 1]
        if not start.is_dir():
            return []
        found = (p.relative_to(self.root).as_posix() for p in start.rglob("*") if p.is_file())
        return sorted(k for k in found if k.startswith(prefix) and not k.endswith(".tmp"))

    def delete(self, key: str) -> None:
        (self.root / key).unlink(missing_ok=True)


def snapshot_key(group: str) -> str:
    """Legacy single-file snapshot, served only until the first generation is published."""
    return f"globe/{group}.bin.gz"


POINTER_KEY = "globe/current.json"
GENERATIONS_PREFIX = "globe/gen/"
GENERATION_PATTERN = r"^\d{8}T\d{6}Z-r\d+$"


def generation_id(generated_at: datetime, run_id: int) -> str:
    t = generated_at.astimezone(UTC)
    return f"{t:%Y%m%dT%H%M%S}Z-r{run_id}"


def generation_key(generation: str, filename: str) -> str:
    return f"{GENERATIONS_PREFIX}{generation}/{filename}"


def snapshot_file(group: str) -> str:
    return f"{group}.bin.gz"


def names_file(group: str) -> str:
    return f"names-{group}.json.gz"


def read_pointer(store: SnapshotStore) -> dict | None:
    data = store.get(POINTER_KEY)
    return json.loads(data) if data is not None else None


def pack_snapshot(rows: list[dict], generated_at: datetime) -> bytes:
    owners = sorted({r["owner"] for r in rows})
    owner_index = {code: i for i, code in enumerate(owners)}
    header = json.dumps(
        {
            "version": 1,
            "generated_at": generated_at.isoformat(),
            "count": len(rows),
            "owners": owners,
            "types": list(OBJECT_TYPES),
            "record_size": RECORD.size,
            "fields": FIELDS,
        }
    ).encode()
    body = bytearray(MAGIC + struct.pack("<I", len(header)) + header)
    for r in rows:
        body += RECORD.pack(
            r["norad_id"], owner_index[r["owner"]], OBJECT_TYPES.index(r["object_type"]),
            r["epoch"].timestamp(), r["mean_motion"], r["eccentricity"], r["inclination"],
            r["raan"], r["arg_pericenter"], r["mean_anomaly"], r["bstar"],
            r["mean_motion_dot"], r["mean_motion_ddot"],
        )
    return gzip.compress(bytes(body), compresslevel=6)


def unpack_snapshot(data: bytes) -> tuple[dict, list[tuple]]:
    raw = gzip.decompress(data)
    if raw[:4] != MAGIC:
        raise ValueError("not a LEO1 snapshot")
    (header_len,) = struct.unpack_from("<I", raw, 4)
    header = json.loads(raw[8 : 8 + header_len])
    offset = 8 + header_len
    records = [RECORD.unpack_from(raw, offset + i * RECORD.size) for i in range(header["count"])]
    return header, records


GROUP_ROWS_SQL = """
    SELECT o.norad_id, o.name, o.owner, o.object_type, g.epoch, g.mean_motion, g.eccentricity,
           g.inclination, g.raan, g.arg_pericenter, g.mean_anomaly, g.bstar,
           g.mean_motion_dot, g.mean_motion_ddot
    FROM gp_elements g JOIN objects o USING (norad_id)
    WHERE o.decay_date IS NULL AND o.regime = ANY(%s)
    ORDER BY o.norad_id
"""


def pack_names(rows: list[dict], generated_at: datetime) -> bytes:
    body = {"generated_at": generated_at.isoformat(),
            "names": {str(r["norad_id"]): r["name"] for r in rows}}
    return gzip.compress(json.dumps(body, separators=(",", ":")).encode(), mtime=0)


def publish_generation(
    conn: psycopg.Connection, store: SnapshotStore, generated_at: datetime, run_id: int
) -> dict[str, int]:
    """Publishes the globe as one generation: both groups' snapshots and name lists, all read
    in one database snapshot, then the pointer switch. A failure before the switch leaves the
    previous generation live. Returns the object count per group."""
    generation = generation_id(generated_at, run_id)
    previous_pointer = read_pointer(store)
    previous = previous_pointer["generation"] if previous_pointer else None
    with conn.transaction():
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        groups = {
            group: conn.execute(GROUP_ROWS_SQL, (list(regimes),)).fetchall()
            for group, regimes in SNAPSHOT_GROUPS.items()
        }
    for group, rows in groups.items():
        snapshot_data = pack_snapshot(rows, generated_at)
        store.put(generation_key(generation, snapshot_file(group)), snapshot_data)
        store.put(generation_key(generation, names_file(group)), pack_names(rows, generated_at))
    counts = {group: len(rows) for group, rows in groups.items()}
    pointer = {
        "generation": generation, "generated_at": generated_at.astimezone(UTC).isoformat(),
        "groups": {group: {"count": n} for group, n in counts.items()},
    }
    store.put(POINTER_KEY, json.dumps(pointer, separators=(",", ":")).encode())
    try:
        remove_old_generations(store, generation, previous)
    except Exception:  # the new generation is live; the next publication retries the cleanup
        log.warning("could not remove old globe generations", exc_info=True)
    return counts


def remove_old_generations(store: SnapshotStore, current: str, previous: str | None) -> None:
    """Deletes every generation under `globe/gen/` except `current`, `previous` (the generation
    the pointer named just before this publication, kept for clients mid-load), and any
    generation newer than `current` (never touched). This also removes orphan generations that
    were written but never reached by the pointer, such as one left behind by a failed
    publication. A folder name under `globe/gen/` that does not match GENERATION_PATTERN is left
    alone. The legacy single-file snapshots are always deleted."""
    keys = store.keys(GENERATIONS_PREFIX)
    generation_of = {k: k[len(GENERATIONS_PREFIX):].split("/", 1)[0] for k in keys}
    keep = {current, *([previous] if previous is not None else [])}
    for key, generation in generation_of.items():
        if not re.fullmatch(GENERATION_PATTERN, generation):
            continue
        if generation not in keep and generation < current:
            store.delete(key)
    for group in SNAPSHOT_GROUPS:
        store.delete(snapshot_key(group))


def run_publish_globe(
    conn: psycopg.Connection, store: SnapshotStore, now: datetime | None = None
) -> int:
    """Republishes the globe from the database without fetching anything (after a deploy, or to
    repair a failed publication). Takes the same lock as GP ingests."""
    now = now or datetime.now(UTC)
    with run_log(conn, "publish_globe") as run, advisory_lock(conn, GLOBE_LOCK):
        run.source = "database"
        run.rows = sum(publish_generation(conn, store, now, run.id).values())
    return run.rows
