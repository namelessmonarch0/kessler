"""LEO1 snapshot decoder, mirroring api/app/ingest/snapshot.py::unpack_snapshot."""
import gzip
import json
import struct

MAGIC = b"LEO1"
RECORD = struct.Struct("<IHBx10d")  # 88 bytes


def unpack_snapshot(data: bytes) -> tuple[dict, list[dict]]:
    raw = gzip.decompress(data)
    if raw[:4] != MAGIC:
        raise ValueError("not a LEO1 snapshot")
    (header_len,) = struct.unpack_from("<I", raw, 4)
    header = json.loads(raw[8 : 8 + header_len])
    offset = 8 + header_len
    owners = header["owners"]
    types = header["types"]
    records = []
    for i in range(header["count"]):
        (norad_id, owner_index, type_index, epoch_unix, mean_motion, eccentricity, inclination,
         raan, arg_pericenter, mean_anomaly, bstar, mean_motion_dot,
         mean_motion_ddot) = RECORD.unpack_from(raw, offset + i * RECORD.size)
        records.append(
            {
                "noradId": norad_id,
                "owner": owners[owner_index],
                "type": types[type_index],
                "epochMs": epoch_unix * 1000,
                "meanMotion": mean_motion,
                "eccentricity": eccentricity,
                "inclination": inclination,
                "raan": raan,
                "argPericenter": arg_pericenter,
                "meanAnomaly": mean_anomaly,
                "bstar": bstar,
                "meanMotionDot": mean_motion_dot,
                "meanMotionDdot": mean_motion_ddot,
            }
        )
    return header, records
