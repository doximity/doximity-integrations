"""Environment-driven configuration for the Ask API demo.

Every knob is an environment variable. A local .env file sitting next to this
module is also read, but real environment variables always win.
"""

import os
from dataclasses import dataclass

DEFAULT_DISCOVERY_URL = "https://auth.doximity.com/.well-known/openid-configuration"
DEFAULT_ASK_URL = "https://docs-gpt.doximity.com/api/v1/external_chat_completions"


def _load_dotenv(path: str) -> None:
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()
    except FileNotFoundError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("\"'")
        if key:
            os.environ.setdefault(key, value)


_load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))


@dataclass(frozen=True)
class Settings:
    client_id: str | None
    client_secret: str | None
    discovery_url: str
    ask_url: str
    default_npi: str | None


settings = Settings(
    client_id=os.environ.get("DOX_CLIENT_ID") or None,
    client_secret=os.environ.get("DOX_CLIENT_SECRET") or None,
    discovery_url=os.environ.get("DOX_AUTH_DISCOVERY_URL") or DEFAULT_DISCOVERY_URL,
    ask_url=os.environ.get("DOX_ASK_URL") or DEFAULT_ASK_URL,
    default_npi=os.environ.get("DOX_NPI") or None,
)
