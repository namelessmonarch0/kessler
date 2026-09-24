from datetime import UTC, datetime

from skyfield.api import EarthSatellite, load, wgs84
from skyfield.framelib import itrs

_TS = load.timescale(builtin=True)


def _omm(record: dict) -> dict:
    epoch = datetime.fromtimestamp(record["epochMs"] / 1000, tz=UTC)
    return {
        "OBJECT_NAME": str(record["noradId"]), "OBJECT_ID": str(record["noradId"]),
        "EPOCH": epoch.strftime("%Y-%m-%dT%H:%M:%S.%f"),
        "MEAN_MOTION": record["meanMotion"], "ECCENTRICITY": record["eccentricity"],
        "INCLINATION": record["inclination"], "RA_OF_ASC_NODE": record["raan"],
        "ARG_OF_PERICENTER": record["argPericenter"], "MEAN_ANOMALY": record["meanAnomaly"],
        "EPHEMERIS_TYPE": 0, "CLASSIFICATION_TYPE": "U", "NORAD_CAT_ID": record["noradId"],
        "ELEMENT_SET_NO": 999, "REV_AT_EPOCH": 0, "BSTAR": record["bstar"],
        "MEAN_MOTION_DOT": record["meanMotionDot"], "MEAN_MOTION_DDOT": record["meanMotionDdot"],
    }


def satellite(record: dict) -> EarthSatellite:
    return EarthSatellite.from_omm(_TS, _omm(record))


def position(record: dict, time_ms: int) -> dict:
    sat = satellite(record)
    t = _TS.from_datetime(datetime.fromtimestamp(time_ms / 1000, tz=UTC))
    geo = sat.at(t)
    if sat.model.error:
        raise ValueError(f"sgp4 error {sat.model.error}")
    ecef = geo.frame_xyz(itrs).km
    gp = wgs84.geographic_position_of(geo)
    return {"ecefKm": [float(v) for v in ecef], "latDeg": gp.latitude.degrees,
            "lonDeg": gp.longitude.degrees, "altKm": gp.elevation.km}
