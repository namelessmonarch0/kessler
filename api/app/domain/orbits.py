from datetime import UTC, datetime

OBJECT_TYPES = ("PAY", "R/B", "DEB", "UNK")
REGIMES = ("LEO", "MEO", "GEO", "HEO", "OTHER")

TYPE_LABELS = {"PAY": "Payload", "R/B": "Rocket body", "DEB": "Debris", "UNK": "Unknown"}
REGIME_LABELS = {
    "LEO": "Low Earth orbit (apogee under 2,000 km)",
    "MEO": "Medium Earth orbit",
    "GEO": "Geostationary orbit",
    "HEO": "Highly elliptical orbit",
    "OTHER": "Beyond Earth orbit or unknown",
}
OPS_STATUS_LABELS = {
    "+": "Operational",
    "-": "Nonoperational",
    "P": "Partially operational",
    "B": "Backup",
    "S": "Spare",
    "X": "Extended mission",
    "D": "Decayed",
}
ATTRIBUTION = "Data: USSPACECOM via Space-Track.org; CelesTrak."

LEO_MAX_APOGEE_KM = 2000.0
GEO_PERIGEE_KM = (35000.0, 36500.0)


def parse_epoch(value: str) -> datetime:
    """An OMM epoch as a timezone-aware UTC datetime. Space-Track and CelesTrak send naive ISO-8601
    times that are UTC; explicit offsets and a trailing Z are honoured."""
    dt = datetime.fromisoformat(value)
    return dt.astimezone(UTC) if dt.tzinfo else dt.replace(tzinfo=UTC)


def classify_regime(apogee: float | None, perigee: float | None, orbit_center: str | None) -> str:
    if orbit_center not in (None, "", "EA") or apogee is None or perigee is None:
        return "OTHER"
    if apogee < LEO_MAX_APOGEE_KM:
        return "LEO"
    if GEO_PERIGEE_KM[0] <= perigee <= GEO_PERIGEE_KM[1]:
        return "GEO"
    if perigee >= LEO_MAX_APOGEE_KM:
        return "MEO"
    return "HEO"


def rcs_size(rcs: float | None) -> str | None:
    """Space-Track's radar cross-section classes (m²): small < 0.1 ≤ medium ≤ 1 < large."""
    if rcs is None:
        return None
    if rcs < 0.1:
        return "SMALL"
    if rcs <= 1.0:
        return "MEDIUM"
    return "LARGE"
