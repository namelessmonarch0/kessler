import time
from collections.abc import Callable

import httpx

USER_AGENT = "leo-debris/0.1 (+https://leo.kudayyurter.dev)"

CELESTRAK_SATCAT_URL = "https://celestrak.org/pub/satcat.csv"
CELESTRAK_GP_ACTIVE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv"
SPACETRACK_LOGIN_URL = "https://www.space-track.org/ajaxauth/login"
# All on-orbit objects with an element set newer than 30 days: Space-Track's recommended
# bulk query. One request; never query per object.
SPACETRACK_GP_URL = (
    "https://www.space-track.org/basicspacedata/query/class/gp/decay_date/null-val"
    "/epoch/%3Enow-30/orderby/norad_cat_id/format/json"
)

CSV_HEADER_PREFIX = "OBJECT_NAME,"
ATTEMPTS = 3


class SourceError(RuntimeError):
    """An upstream data source failed or returned something we refuse to ingest."""


def _request(
    send: Callable[[], httpx.Response], what: str, sleep: Callable[[float], None]
) -> httpx.Response:
    last = ""
    for attempt in range(ATTEMPTS):
        try:
            response = send()
        except httpx.TransportError as exc:
            last = f"{type(exc).__name__}: {exc}"
        else:
            if response.status_code < 500:
                if response.status_code >= 400:
                    raise SourceError(f"{what}: HTTP {response.status_code}")
                return response
            last = f"HTTP {response.status_code}"
        if attempt < ATTEMPTS - 1:
            sleep(2.0 * (attempt + 1))
    raise SourceError(f"{what}: {last} after {ATTEMPTS} attempts")


class CelesTrakClient:
    def __init__(self, http: httpx.Client, sleep: Callable[[float], None] = time.sleep):
        self.http = http
        self.sleep = sleep

    def _csv(self, url: str, what: str) -> str:
        text = _request(lambda: self.http.get(url), what, self.sleep).text
        if not text.startswith(CSV_HEADER_PREFIX):
            raise SourceError(f"{what}: unexpected response starting {text[:80]!r}")
        return text

    def satcat_csv(self) -> str:
        return self._csv(CELESTRAK_SATCAT_URL, "CelesTrak SATCAT")

    def gp_active_csv(self) -> str:
        return self._csv(CELESTRAK_GP_ACTIVE_URL, "CelesTrak GP active")


class SpaceTrackClient:
    def __init__(
        self,
        http: httpx.Client,
        user: str,
        password: str,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.http = http
        self.user = user
        self.password = password
        self.sleep = sleep

    def gp_all_on_orbit(self) -> list[dict]:
        login = _request(
            lambda: self.http.post(
                SPACETRACK_LOGIN_URL, data={"identity": self.user, "password": self.password}
            ),
            "Space-Track login",
            self.sleep,
        )
        if "Failed" in login.text:
            raise SourceError("Space-Track login failed (check SPACETRACK_USER/SPACETRACK_PASS)")
        response = _request(lambda: self.http.get(SPACETRACK_GP_URL), "Space-Track GP", self.sleep)
        try:
            data = response.json()
        except ValueError as exc:
            raise SourceError("Space-Track GP: response was not JSON") from exc
        if not isinstance(data, list):
            raise SourceError(f"Space-Track GP: unexpected payload {str(data)[:200]}")
        return data
