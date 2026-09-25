import gzip
import json
import struct
from datetime import datetime
from pathlib import Path
from typing import Protocol

import psycopg

from app.domain.orbits import OBJECT_TYPES

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


def snapshot_key(group: str) -> str:
    return f"globe/{group}.bin.gz"


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


def write_snapshots(
    conn: psycopg.Connection, store: SnapshotStore, generated_at: datetime
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for group, regimes in SNAPSHOT_GROUPS.items():
        rows = conn.execute(
            """
            SELECT o.norad_id, o.owner, o.object_type, g.epoch, g.mean_motion, g.eccentricity,
                   g.inclination, g.raan, g.arg_pericenter, g.mean_anomaly, g.bstar,
                   g.mean_motion_dot, g.mean_motion_ddot
            FROM gp_elements g JOIN objects o USING (norad_id)
            WHERE o.decay_date IS NULL AND o.regime = ANY(%s)
            ORDER BY o.norad_id
            """,
            (list(regimes),),
        ).fetchall()
        store.put(snapshot_key(group), pack_snapshot(rows, generated_at))
        counts[group] = len(rows)
    return counts
