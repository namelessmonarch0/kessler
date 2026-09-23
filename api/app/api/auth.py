import hmac

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.api.errors import error_body

OPEN_PATHS = {"/api/health"}


def install_origin_auth(app: FastAPI, secret: str | None) -> None:
    """Only the Vercel proxy knows the secret; it keeps the Lambda URL from being a public
    back door. Disabled when no secret is configured (local development)."""
    if not secret:
        return
    expected = secret.encode()

    @app.middleware("http")
    async def check_origin(request: Request, call_next):
        if request.url.path in OPEN_PATHS:
            return await call_next(request)
        supplied = request.headers.get("x-origin-auth", "").encode()
        if not hmac.compare_digest(supplied, expected):
            return JSONResponse(
                error_body("forbidden", "missing or invalid origin credentials"), status_code=403
            )
        return await call_next(request)
