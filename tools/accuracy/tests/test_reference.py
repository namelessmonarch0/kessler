from kessler_accuracy.reference import position

ISS = {
    "noradId": 25544, "owner": "ISS", "type": "PAY", "epochMs": 1790058637496,
    "meanMotion": 15.49224498, "eccentricity": 0.00047657, "inclination": 51.6312,
    "raan": 179.6046, "argPericenter": 167.6102, "meanAnomaly": 192.5004,
    "bstar": 0.0001364276, "meanMotionDot": 0.00007132, "meanMotionDdot": 0.0,
}


def test_iss_position_is_physical():
    p = position(ISS, ISS["epochMs"])
    assert 410 < p["altKm"] < 440
    assert -51.7 <= p["latDeg"] <= 51.7
    assert -180 <= p["lonDeg"] <= 180
    r = sum(c * c for c in p["ecefKm"]) ** 0.5
    assert 6700 < r < 6850
