# Ask iframe Example

This is an example Python application that shows how to embed the full Doximity Ask experience in your product using the iframe integration.

## What it demonstrates

- **Server-side launch minting** — the backend exchanges your OAuth client credentials for a bearer token (same client-credentials flow as the Ask API example: OIDC discovery, token caching, one retry on 401) and calls the Partner Login API to mint a launch.
- **Just-in-time magic links** — the single-use, five-minute launch URL is minted when you click Launch, handed straight to the iframe, and never logged or persisted.
- **Embedding** — the frontend embeds the launch URL in an iframe; Doximity hosts the entire Ask experience inside it (multi-turn chat, attachments, enterprise templates, patient banner, citation rendering). There is no chat UX, streaming, or rendering to build.
- **Three example launches** — one button per Partner Login shape (payloads in `LAUNCH_VARIANTS` in `main.py`; swap in your real data there):
  - **Blank chat** (`create_chat: false`) — no chat is created ahead of time; the practitioner lands on the embedded Ask new-chat page and their first message creates the chat.
  - **Patient context** — a patient-context chat with example demographics (patient banner) and fake clinical history passed as the `patient_context` attachment; no prompt.
  - **Chat with prompt** — a plain chat (`patient_context_chat: false`) with an `ask` question, so the answer is already streaming when the page loads.
- **Launch lifecycle** — every launch mints a fresh single-use magic link and opens a fresh chat (a new patient or encounter should always mint a fresh one). A stale or consumed link means the iframe fails to authenticate — launching again fixes it.

## Layout

```
ask-iframe/
├── main.py           FastAPI app: serves the frontend + POST /api/launch
│                       (EXAMPLE_LAUNCH holds the example launch parameters)
├── auth.py           TokenManager: discovery + client-credentials token caching
├── config.py         Environment-variable configuration (.env supported)
├── requirements.txt
├── .env.example
└── static/
    ├── index.html    Header with Launch Ask button + iframe
    ├── app.js        Mint launch, swap empty state/iframe panels
    └── styles.css
```

## Configuration

All configuration is via environment variables (copy `.env.example` to `.env`, or export them in your shell). `.env` values never override real environment variables, and `.env` is gitignored.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DOX_CLIENT_ID` | yes | — | OAuth client ID for your registered Doximity application |
| `DOX_CLIENT_SECRET` | yes | — | OAuth client secret — treat like a password, never commit it |
| `DOX_AUTH_DISCOVERY_URL` | no | `https://auth.doximity.com/.well-known/openid-configuration` | OpenID Connect discovery document; the token endpoint is read from it |
| `DOX_PARTNER_LOGIN_URL` | no | `https://ehr-connect.doximity.com/api/v1/partners/login` | The Partner Login API endpoint that mints launches |
| `PORT` | no | `8000` | Port the server listens on |

Your OAuth application must be provisioned for partner launches — see the "Get started" page in the Doximity API docs.

## Run it

Requires Python 3.10+. Instructions below use [uv](https://docs.astral.sh/uv/); plain `pip` works too.

```bash
cd ask-iframe
uv venv                            # creates .venv
uv pip install -r requirements.txt
cp .env.example .env               # then fill in DOX_CLIENT_ID and DOX_CLIENT_SECRET
uv run uvicorn main:app --ssl-certfile localhost.pem --ssl-keyfile localhost-key.pem              # or: uv run uvicorn main:app --reload
```

### HTTPS (recommended for the iframe flow)

The embedded session sets `Secure`/`Partitioned` cookies (CHIPS), and your
CSP `frame-ancestors` will likely list `https://localhost` — so run the demo
over TLS. A throwaway localhost cert is checked in (`localhost.pem` /
`localhost-key.pem`, self-signed for `localhost` / `127.0.0.1` — regenerate
with `openssl req -x509 -newkey rsa:2048 -keyout localhost-key.pem -out
localhost.pem -days 825 -nodes -subj "/CN=localhost" -addext
"subjectAltName=DNS:localhost,IP:127.0.0.1"`; never reuse it anywhere real):

```bash
uv run uvicorn main:app --ssl-certfile localhost.pem --ssl-keyfile localhost-key.pem --reload
```

Then open <https://localhost:8000>. Note that a CSP source without a port
(`https://localhost`) only matches port 443 (CSP3 §6.7.2.11) — if you serve
on a non-default port, list the port explicitly in your `frame-ancestors`
(e.g. `https://localhost:8000`).

Open <http://localhost:8000> and click **Launch Ask**. The Ask session loads in the iframe.

## How it works

- `POST /api/launch` takes `{ "variant": "blank" | "patient" | "prompt" }` and forwards the matching example parameters from `LAUNCH_VARIANTS` (`main.py`) to the Partner Login API with the bearer token, forcing `destination: "ask"` and `embedded: true`.
- The API returns `{ "url": "https://auth.doximity.com/magic_link?..." }` — a single-use magic sign-in link that expires in five minutes. The demo mints it only when you click Launch, hands it straight to the iframe, and never logs its value.
- The clinician's session persists in their browser, so returning to the iframe later does not re-prompt — but each new launch context (new patient, new encounter) mints a fresh launch and opens a fresh chat.

## Security and privacy notes

- Launch URLs authenticate a specific Doximity account and cannot be reused, shared, or replayed after consumption — treat them like session credentials.
- **Domain allowlisting**: browsers only frame Doximity from registered domains. Your production, staging, *and local development* domains must be registered with Doximity when your integration is provisioned — if the iframe stays blank or refuses to load, your domain isn't allowlisted yet.
- Patient context sent in a launch is handled under Doximity's HIPAA program: send patient data only for launches where your agreement covers it, and never log or persist launch URLs alongside patient data.

## Ask iframe vs Ask API

The iframe integration gives you the full Doximity Ask product with no UX to build; the Ask API (see `../ask-api/`) gives you a fully custom experience. Both can be mixed — they use the same Doximity accounts and the same attribution.
