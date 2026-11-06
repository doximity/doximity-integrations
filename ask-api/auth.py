"""OAuth 2.0 Client Credentials flow for the Doximity Ask API.

Implements the integration described in the Ask API docs:

- Fetch the OpenID Connect discovery document dynamically (cached, re-fetched
  periodically) to find the token endpoint.
- Exchange the client id/secret for a bearer token, cache it until shortly
  before it expires, and let callers invalidate it (e.g. after a 401) so the
  next call mints a fresh token.
"""

import asyncio
import logging
import time
from typing import Any

import httpx

from config import settings

logger = logging.getLogger(__name__)

DISCOVERY_TTL_SECONDS = 3600.0
TOKEN_EXPIRY_SKEW_SECONDS = 60.0
DEFAULT_TOKEN_TTL_SECONDS = 300.0


class AuthError(RuntimeError):
    """Raised when discovery or token issuance fails."""


class TokenManager:
    """Fetches and caches an OAuth client-credentials access token."""

    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http
        self._lock = asyncio.Lock()
        self._discovery: dict[str, Any] | None = None
        self._discovery_expires_at = 0.0
        self._token: str | None = None
        self._token_expires_at = 0.0

    async def get_token(self) -> str:
        async with self._lock:
            if self._token and time.monotonic() < self._token_expires_at:
                return self._token
            token_endpoint = await self._token_endpoint()
            await self._fetch_token(token_endpoint)
            return self._token

    async def invalidate(self) -> None:
        """Drop the cached token so the next get_token() mints a fresh one."""
        async with self._lock:
            self._token = None
            self._token_expires_at = 0.0

    async def _token_endpoint(self) -> str:
        if self._discovery and time.monotonic() < self._discovery_expires_at:
            return self._discovery["token_endpoint"]
        try:
            response = await self._http.get(settings.discovery_url)
        except httpx.HTTPError as exc:
            raise AuthError(
                f"could not fetch discovery document from {settings.discovery_url}: {exc}"
            ) from exc
        if response.status_code != 200:
            raise AuthError(f"discovery document request returned {response.status_code}")
        discovery = response.json()
        token_endpoint = discovery.get("token_endpoint")
        if not token_endpoint:
            raise AuthError("discovery document has no token_endpoint")
        self._discovery = discovery
        self._discovery_expires_at = time.monotonic() + DISCOVERY_TTL_SECONDS
        logger.info("fetched OIDC discovery document (token_endpoint=%s)", token_endpoint)
        return token_endpoint

    async def _fetch_token(self, token_endpoint: str) -> None:
        try:
            response = await self._http.post(
                token_endpoint,
                data={
                    "grant_type": "client_credentials",
                    "client_id": settings.client_id or "",
                    "client_secret": settings.client_secret or "",
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        except httpx.HTTPError as exc:
            raise AuthError(f"token request to {token_endpoint} failed: {exc}") from exc
        if response.status_code != 200:
            # Never include the client secret (or token) in logs or errors.
            raise AuthError(f"token request returned {response.status_code}")
        body = response.json()
        token = body.get("access_token")
        if not token:
            raise AuthError("token response contained no access_token")
        try:
            ttl = float(body.get("expires_in")) - TOKEN_EXPIRY_SKEW_SECONDS
        except (TypeError, ValueError):
            ttl = DEFAULT_TOKEN_TTL_SECONDS
        ttl = max(ttl, TOKEN_EXPIRY_SKEW_SECONDS)
        self._token = token
        self._token_expires_at = time.monotonic() + ttl
        logger.info("fetched new access token (expires_in=%s)", body.get("expires_in"))
