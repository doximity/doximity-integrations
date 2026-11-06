"""Doximity Ask iframe demo — mint launch URLs and embed the Ask session.

The backend does one thing: mint a launch by calling the Doximity Partner
Login API with an OAuth client-credentials bearer token, and return the
single-use magic sign-in URL to the page. The frontend embeds that URL in an
iframe; Doximity hosts and runs the entire Ask experience inside it.

The launch URL is a secret while it lives (single-use, expires in five
minutes): it is minted just-in-time, handed straight to the iframe, and never
logged or persisted.
"""

import logging
import os
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from auth import AuthError, TokenManager
from config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("ask-iframe")

HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=30.0, pool=30.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http = httpx.AsyncClient(timeout=HTTP_TIMEOUT)
    app.state.tokens = TokenManager(app.state.http)
    logger.info(
        "iframe demo ready (partner_login_url=%s, discovery_url=%s)",
        settings.partner_login_url,
        settings.discovery_url,
    )
    yield
    await app.state.http.aclose()


app = FastAPI(title="Doximity Ask iframe demo", lifespan=lifespan)


# Example practitioner identity sent with every launch. In a real
# integration these come from the practitioner using your product:
#
#   practitioner_id  their id in YOUR system — Doximity creates the linked
#                    account on first launch
#   first_name / last_name
#   npi              usage attribution
#   email            recorded on the account
#
# The backend always forces destination: "ask" and embedded: true, then
# merges the per-variant params from LAUNCH_VARIANTS (see below).
EXAMPLE_LAUNCH = {
    "practitioner_id": "your-internal-practitioner-id",
    "first_name": "Dana",
    "last_name": "Kim",
    "npi": "1234567890",
    # "email": "dana@example.com",
}

# One example per launch button, showing the different Partner Login shapes:
#
# "blank"   create_chat: false — no chat is created ahead of time; the
#           practitioner lands on the embedded Ask new-chat page and their
#           first message creates the chat.
# "patient" a patient-context chat: demographics render the patient banner
#           and patient_context rides along as an attachment. No prompt —
#           an empty patient-anchored chat.
# "prompt"  a plain chat (patient_context_chat: false) with an ask question
#           — the answer is already streaming when the page loads.
LAUNCH_VARIANTS = {
    "blank": {
        "create_chat": False,
    },
    "patient": {
        "patient_name": "Jane Doe",
        "patient_age": "55",
        "patient_gender": "female",
        "patient_mrn": "MRN-0042",
        "patient_context": (
            "Type 2 diabetes on metformin 500mg BID, A1c 8.4%, eGFR 72. "
            "Hypertension on lisinopril 20mg daily. Penicillin allergy (rash)."
        ),
    },
    "prompt": {
        "patient_context_chat": False,
        "ask": (
            "What is the first-line treatment for hypertension in a "
            "55 year old with no comorbidities?"
        ),
    },
}

VALID_VARIANTS = set(LAUNCH_VARIANTS)


class LaunchOptions(BaseModel):
    # Which example launch to mint: "blank", "patient", or "prompt".
    variant: str = "blank"


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {"message": message}})


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.post("/api/launch")
async def launch(options: LaunchOptions | None = None):
    if not (settings.client_id and settings.client_secret):
        return _error(
            503, "Server is not configured: set DOX_CLIENT_ID and DOX_CLIENT_SECRET"
        )

    variant = (options.variant if options else "blank") or "blank"
    if variant not in VALID_VARIANTS:
        return _error(400, f"Unknown variant {variant!r}; expected one of {sorted(VALID_VARIANTS)}")

    payload = {**EXAMPLE_LAUNCH, "destination": "ask", "embedded": True, **LAUNCH_VARIANTS[variant]}

    http: httpx.AsyncClient = app.state.http
    tokens: TokenManager = app.state.tokens

    response = None
    for attempt in range(2):
        try:
            token = await tokens.get_token()
        except AuthError as exc:
            logger.error("authentication with Doximity failed: %s", exc)
            return _error(502, f"Authentication with Doximity failed: {exc}")
        try:
            response = await http.post(
                settings.partner_login_url,
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
            )
        except httpx.HTTPError as exc:
            logger.error("could not reach the Partner Login API at %s: %s", settings.partner_login_url, exc)
            return _error(502, f"Could not reach the Partner Login API at {settings.partner_login_url}: {exc}")
        if response.status_code == 401 and attempt == 0:
            logger.info("Partner Login API returned 401; refreshing token and retrying once")
            await tokens.invalidate()
            continue
        break

    if response.status_code != 200:
        detail = response.text.strip()[:500]
        logger.error("Partner Login API responded with status %s", response.status_code)
        return _error(
            response.status_code,
            f"Partner Login API returned {response.status_code}: {detail}",
        )

    launch_url = response.json().get("url")
    if not launch_url:
        return _error(502, "Partner Login API returned no launch url")

    # The launch URL authenticates the practitioner — log its existence, never its value.
    logger.info("minted launch (practitioner_id=%s)", EXAMPLE_LAUNCH["practitioner_id"])
    return {"url": launch_url}


class NoCacheStaticFiles(StaticFiles):
    """A demo with actively edited assets — never let the browser cache them."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-store"
        return response


app.mount(
    "/",
    NoCacheStaticFiles(
        directory=os.path.join(os.path.dirname(__file__), "static"), html=True
    ),
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
