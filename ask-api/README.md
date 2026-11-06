# Ask API Example

This is an example Python application that shows how to build a chat app using the Doximity Ask API.

## What it demonstrates

- **OAuth 2.0 Client Credentials flow** — the OpenID Connect discovery document is fetched dynamically to find the token endpoint, the bearer token is cached until shortly before expiry, and a 401 triggers minting a fresh token and retrying once (exactly as the Ask API docs describe).
- **Streaming answers** — the backend proxies the Ask API's server-sent-events stream straight through to the browser.
- **Multi-turn conversations** — follow-up questions work because the browser replays the full message history (OpenAI chat format) with every request. The backend keeps **no conversation state**; it is a pure proxy.
- **Rich rendering of the response** — reasoning narration (shown as collapsible "Research notes" while the answer streams), the markdown answer with inline numbered citations, a source bibliography, and artifact cards (drug dose tables, interaction warnings with severity badges, pill image strips, generated images).

## Layout

```
ask-api/
├── main.py           FastAPI app: serves the frontend + POST /api/ask proxy
├── auth.py           TokenManager: discovery + client-credentials token caching
├── config.py         Environment-variable configuration (.env supported)
├── requirements.txt
├── .env.example
└── static/
    ├── index.html    Chat UI shell
    ├── app.js        SSE parsing, rendering, conversation state
    └── styles.css
```

## Configuration

All configuration is via environment variables (copy `.env.example` to `.env`, or export them in your shell). `.env` values never override real environment variables, and `.env` is gitignored.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DOX_CLIENT_ID` | yes | — | OAuth client ID for your registered Doximity application |
| `DOX_CLIENT_SECRET` | yes | — | OAuth client secret — treat like a password, never commit it |
| `DOX_AUTH_DISCOVERY_URL` | no | `https://auth.doximity.com/.well-known/openid-configuration` | OpenID Connect discovery document; the token endpoint is read from it |
| `DOX_ASK_URL` | no | `https://query-router.doximity.services/v1/chat/external` | The Ask API endpoint the proxy forwards to |
| `DOX_NPI` | no | — | Default clinician NPI used for usage attribution (the frontend can also send one per request) |
| `PORT` | no | `8000` | Port the server listens on |

Your OAuth application must be provisioned with the client credentials grant and access to the Ask API — see the "Get started" page in the Doximity API docs.

## Run it

Requires Python 3.10+. Instructions below use [uv](https://docs.astral.sh/uv/); plain `pip` works too.

```bash
cd ask-api
uv venv                            # creates .venv
uv pip install -r requirements.txt
cp .env.example .env               # then fill in DOX_CLIENT_ID and DOX_CLIENT_SECRET
uv run python main.py              # or: uv run uvicorn main:app --reload
```

No activation needed — `uv run` uses the local `.venv` automatically. (pip equivalent: `python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`.)

Open <http://localhost:8000>, type a clinical question, and watch the answer stream in. Ask a follow-up to continue the conversation; use "New conversation" to reset.

## How the pieces fit

- `POST /api/ask` accepts `{ "messages": [...], "stream": true|false, "npi": "..." }`.
- With `stream: true` (what the UI uses), the SSE stream from the Ask API is piped through unmodified; the browser parses `reasoning_content` deltas, `content` deltas, `event: artifact` frames, the final `finish_reason: "stop"` chunk (which carries the `citations` array), and `data: [DONE]`.
- With `stream: false`, the full JSON chat completion (including `artifacts` and `citations`) is returned as-is. The API commits a 200 early and sends keepalive whitespace during long turns; the proxy parses the body tolerantly and passes it through.
- Errors are conventional HTTP statuses: `401` (retried once with a fresh token by the proxy), `403` (your app isn't provisioned for the Ask API), `400` (malformed request), `5xx` (safe to retry).

> **Known limitation (dev environment):** the Ask API's inline citation markers (`[1](#ref-…)`) arrive in the answer text, but the dev environment currently does not return the `citations` array (neither on the streaming final chunk nor in the blocking response). The UI handles both cases: full details in tooltips and the bibliography when `citations` is present, and a "Source details not provided by the API" placeholder when it is not.
