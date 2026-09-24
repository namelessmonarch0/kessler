import struct
from datetime import UTC, datetime, timedelta, timezone

from app.ingest.gp import parse_gp_records
from app.ingest.snapshot import pack_snapshot, unpack_snapshot

ROW = {
    "norad_id": 25544, "owner": "ISS", "object_type": "PAY",
    "epoch": datetime(2026, 9, 22, 6, 30, 37, 496000, tzinfo=UTC),
    "mean_motion": 15.49224498, "eccentricity": 0.00047657, "inclination": 51.6312,
    "raan": 179.6046, "arg_pericenter": 167.6102, "mean_anomaly": 192.5004,
    "bstar": 0.0001364276, "mean_motion_dot": 0.00007132, "mean_motion_ddot": 0.0,
}


def test_every_element_round_trips_bit_identically():
    header, records = unpack_snapshot(pack_snapshot([ROW], datetime(2026, 9, 22, tzinfo=UTC)))
    (rec,) = records
    assert rec[0] == 25544 and header["owners"][rec[1]] == "ISS" and header["types"][rec[2]] == "PAY"
    expected = [ROW["epoch"].timestamp(), *(ROW[k] for k in (
        "mean_motion", "eccentricity", "inclination", "raan", "arg_pericenter", "mean_anomaly",
        "bstar", "mean_motion_dot", "mean_motion_ddot"))]
    assert [struct.pack("<d", v) for v in rec[3:]] == [struct.pack("<d", v) for v in expected]


def test_epoch_is_utc_even_when_given_another_offset():
    shifted = {**ROW, "epoch": ROW["epoch"].astimezone(timezone(timedelta(hours=-5)))}
    _, (rec,) = unpack_snapshot(pack_snapshot([shifted], datetime(2026, 9, 22, tzinfo=UTC)))
    assert rec[3] == ROW["epoch"].timestamp()


def test_gp_epoch_without_zone_is_read_as_utc():
    (gp,) = parse_gp_records([{
        "NORAD_CAT_ID": "25544", "EPOCH": "2026-09-22T06:30:37.496000", "MEAN_MOTION": "15.49224498",
        "ECCENTRICITY": "0.00047657", "INCLINATION": "51.6312", "RA_OF_ASC_NODE": "179.6046",
        "ARG_OF_PERICENTER": "167.6102", "MEAN_ANOMALY": "192.5004", "BSTAR": "0.0001364276",
        "MEAN_MOTION_DOT": "0.00007132", "MEAN_MOTION_DDOT": "0",
    }])
    assert gp.epoch == ROW["epoch"]
