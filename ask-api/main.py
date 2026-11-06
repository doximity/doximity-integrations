"""Doximity Ask API demo — a thin, stateless proxy in front of the Ask API.

The browser owns all conversation state: every request carries the full
message history in OpenAI chat format. This backend adds the OAuth 2.0
Client Credentials flow (token caching + one retry on 401, per the docs) and
forwards the call to Doximity — streaming the server-sent-events answer back
to the browser untouched.
"""

import json
import logging
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from auth import AuthError, TokenManager
from config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("ask-api")

# A turn can run one to two minutes; the Ask API writes a keepalive byte
# every 15s to defeat idle timeouts, so a generous read timeout is enough.
HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=30.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(timeout=HTTP_TIMEOUT)
    app.state.tokens = TokenManager(app.state.http)
    logger.info(
        "Ask API proxy ready (ask_url=%s, discovery_url=%s)", settings.ask_url, settings.discovery_url
    )
    yield
    await app.state.http.aclose()


app = FastAPI(title="Doximity Ask API demo", lifespan=lifespan)


class Message(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str


class AskBody(BaseModel):
    messages: list[Message]
    stream: bool = True
    npi: str | None = None


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"message": message}})


def _proxy_payload(body: AskBody) -> dict:
    payload: dict = {
        "messages": [{"role": m.role, "content": m.content} for m in body.messages],
        "stream": body.stream,
    }
    npi = (body.npi or settings.default_npi or "").strip()
    if npi:
        payload["npi"] = npi
    return payload


async def _send_ask(
    http: httpx.AsyncClient, tokens: TokenManager, payload: dict, *, stream: bool
) -> httpx.Response:
    """POST to the Ask API. On 401, mint a fresh token and retry once."""
    for attempt in range(2):
        token = await tokens.get_token()
        request = http.build_request(
            "POST",
            settings.ask_url,
            json=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "text/event-stream" if stream else "application/json",
            },
        )
        response = await http.send(request, stream=stream)
        if response.status_code == 401 and attempt == 0:
            logger.info("Ask API returned 401; refreshing token and retrying once")
            await response.aclose()
            await tokens.invalidate()
            continue
        return response
    raise RuntimeError("unreachable")  # pragma: no cover


def _safe_json(text: str) -> dict:
    """Parse an upstream body tolerantly — the API may send keepalive leading
    whitespace before the JSON, or an error body on a 200 response."""
    try:
        parsed = json.loads(text)
    except ValueError:
        return {"error": {"message": text.strip()[:500] or "Upstream error"}}
    return parsed if isinstance(parsed, dict) else {"error": {"message": str(parsed)[:500]}}


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.post("/api/ask")
async def ask(body: AskBody):
    if not body.messages:
        return _error(400, "messages must not be empty")
    if not (settings.client_id and settings.client_secret):
        return _error(
            503, "Server is not configured: set DOX_CLIENT_ID and DOX_CLIENT_SECRET"
        )

    payload = _proxy_payload(body)
    http: httpx.AsyncClient = app.state.http
    tokens: TokenManager = app.state.tokens

    try:
        response = await _send_ask(http, tokens, payload, stream=body.stream)
    except AuthError as exc:
        logger.error("authentication with Doximity failed: %s", exc)
        return _error(502, f"Authentication with Doximity failed: {exc}")
    except httpx.HTTPError as exc:
        logger.error("could not reach the Ask API at %s: %s", settings.ask_url, exc)
        return _error(502, f"Could not reach the Ask API at {settings.ask_url}: {exc}")

    if body.stream and response.status_code == 200:
        return StreamingResponse(
            _stream_sse(response),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    raw = (await response.aread()).decode("utf-8", "replace")
    await response.aclose()
    logger.info("Ask API responded with status %s", response.status_code)
    return JSONResponse(status_code=response.status_code, content=_safe_json(raw))


async def _stream_sse(response: httpx.Response):
    try:
        async for chunk in response.aiter_bytes():
            yield chunk
    finally:
        await response.aclose()


app.mount(
    "/",
    StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static"), html=True),
    name="static",
)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        reload=True,
    )
