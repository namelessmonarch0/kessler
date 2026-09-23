import httpx
import pytest
import respx

from app.ingest.sources import (
    CELESTRAK_GP_ACTIVE_URL,
    CELESTRAK_SATCAT_URL,
    SPACETRACK_GP_URL,
    SPACETRACK_LOGIN_URL,
    CelesTrakClient,
    SourceError,
    SpaceTrackClient,
)

NO_SLEEP = lambda _s: None  # noqa: E731
SATCAT_HEAD = "OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID\nISS (ZARYA),1998-067A,25544\n"


@respx.mock
def test_celestrak_satcat_ok():
    respx.get(CELESTRAK_SATCAT_URL).mock(return_value=httpx.Response(200, text=SATCAT_HEAD))
    with httpx.Client() as http:
        assert CelesTrakClient(http, sleep=NO_SLEEP).satcat_csv() == SATCAT_HEAD


@respx.mock
def test_celestrak_rejects_html_error_page():
    respx.get(CELESTRAK_SATCAT_URL).mock(
        return_value=httpx.Response(200, text="<html>Service unavailable</html>")
    )
    with httpx.Client() as http, pytest.raises(SourceError, match="unexpected"):
        CelesTrakClient(http, sleep=NO_SLEEP).satcat_csv()


@respx.mock
def test_celestrak_retries_server_errors_then_succeeds():
    route = respx.get(CELESTRAK_GP_ACTIVE_URL)
    route.side_effect = [
        httpx.Response(503),
        httpx.Response(200, text="OBJECT_NAME,OBJECT_ID,EPOCH\n"),
    ]
    with httpx.Client() as http:
        assert CelesTrakClient(http, sleep=NO_SLEEP).gp_active_csv().startswith("OBJECT_NAME")
    assert route.call_count == 2


@respx.mock
def test_celestrak_gives_up_after_three_attempts():
    respx.get(CELESTRAK_SATCAT_URL).mock(return_value=httpx.Response(500))
    with httpx.Client() as http, pytest.raises(SourceError, match="HTTP 500"):
        CelesTrakClient(http, sleep=NO_SLEEP).satcat_csv()


@respx.mock
def test_spacetrack_logs_in_then_fetches_gp():
    login = respx.post(SPACETRACK_LOGIN_URL).mock(return_value=httpx.Response(200, text='""'))
    respx.get(SPACETRACK_GP_URL).mock(
        return_value=httpx.Response(200, json=[{"NORAD_CAT_ID": "25544"}])
    )
    with httpx.Client() as http:
        data = SpaceTrackClient(http, "me@example.com", "pw", sleep=NO_SLEEP).gp_all_on_orbit()
    assert data == [{"NORAD_CAT_ID": "25544"}]
    assert b"identity=me%40example.com" in login.calls[0].request.content


@respx.mock
def test_spacetrack_login_failure_raises():
    respx.post(SPACETRACK_LOGIN_URL).mock(
        return_value=httpx.Response(200, json={"Login": "Failed"})
    )
    with httpx.Client() as http, pytest.raises(SourceError, match="login failed"):
        SpaceTrackClient(http, "me", "bad", sleep=NO_SLEEP).gp_all_on_orbit()


@respx.mock
def test_spacetrack_non_list_payload_raises():
    respx.post(SPACETRACK_LOGIN_URL).mock(return_value=httpx.Response(200, text='""'))
    respx.get(SPACETRACK_GP_URL).mock(
        return_value=httpx.Response(200, json={"error": "query limit"})
    )
    with httpx.Client() as http, pytest.raises(SourceError, match="unexpected"):
        SpaceTrackClient(http, "me", "pw", sleep=NO_SLEEP).gp_all_on_orbit()
