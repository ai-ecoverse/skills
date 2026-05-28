Advanced Examples
2 quick links
Python Examples

Start from these Python examples for common API, continuation, OBO, and remote MCP tasks.

API Guide
MCP Guide

These examples are starting points for common FluffyJaws integration tasks. Use them as templates, then adapt the auth and payload details to your own workflow.

List FluffyPacks

Use this when you want to load the packs available to the current user or app.

Copy
import requests

BASE_URL = "https://api.fluffyjaws.adobe.com"
USER_TOKEN = "<user-token>"

response = requests.get(
    f"{BASE_URL}/api/v1/fluffypack/list",
    params={"scope": "discover", "limit": 24, "offset": 0},
    headers={"Authorization": f"Bearer {USER_TOKEN}"},
    timeout=30,
)
response.raise_for_status()
print(response.json())

Stream chat as a user

Use this when your application sends a direct user-scoped request and you want the streamed response events.

Copy
import json
import requests

BASE_URL = "https://api.fluffyjaws.adobe.com"
USER_TOKEN = "<user-token>"

payload = {
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Summarize the last deployment."}],
}

with requests.post(
    f"{BASE_URL}/api/v1/stream",
    headers={
        "Authorization": f"Bearer {USER_TOKEN}",
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
    },
    data=json.dumps(payload),
    stream=True,
    timeout=300,
) as response:
    response.raise_for_status()
    for line in response.iter_lines(decode_unicode=True):
        if line:
            print(line)

Continue a streamed thread

Use this when you want multi-turn continuity in your own application without relying on public server-managed conversation storage.

Copy
import json
import requests

BASE_URL = "https://api.fluffyjaws.adobe.com"
USER_TOKEN = "<user-token>"
previous_response_id = "<response-id-from-response.created-or-response.completed>"

payload = {
    "model": "gpt-5.4",
    "previousResponseId": previous_response_id,
    "messages": [{"role": "user", "content": "Now turn that into three bullets."}],
}

with requests.post(
    f"{BASE_URL}/api/v1/stream",
    headers={
        "Authorization": f"Bearer {USER_TOKEN}",
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
    },
    data=json.dumps(payload),
    stream=True,
    timeout=300,
) as response:
    response.raise_for_status()
    for line in response.iter_lines(decode_unicode=True):
        if line:
            print(line)

Make an on-behalf-of-user call

Use this when your service owns the integration but the request should run for a specific user.

Copy
import json
import requests

BASE_URL = "https://api.fluffyjaws.adobe.com"
SERVICE_TOKEN = "<service-token>"
USER_TOKEN = "<user-token>"

payload = {
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Summarize the last deployment."}],
}

response = requests.post(
    f"{BASE_URL}/api/v1/stream",
    headers={
        "Authorization": f"Bearer {SERVICE_TOKEN}",
        "X-User-Token": f"Bearer {USER_TOKEN}",
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
    },
    data=json.dumps(payload),
    timeout=300,
)
response.raise_for_status()
print(response.text)

Initialize remote MCP

Use this when your Python client talks to the HTTP MCP endpoint directly. Result: the response includes the Mcp-Session-Id you will reuse on later calls.

Copy
import requests

BASE_URL = "https://api.fluffyjaws.adobe.com"
SERVICE_TOKEN = "<service-token>"

response = requests.post(
    f"{BASE_URL}/api/v1/mcp",
    headers={
        "Authorization": f"Bearer {SERVICE_TOKEN}",
        "Content-Type": "application/json",
    },
    json={
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-11-05",
            "clientInfo": {"name": "python-client", "version": "0.1.0"},
        },
    },
    timeout=30,
)
response.raise_for_status()
print(response.headers.get("Mcp-Session-Id"))
print(response.json())

Reusable Okta service-token client

Use this helper when your application needs to fetch and refresh a service token before calling the API or remote MCP.

Copy
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import os
import requests


@dataclass
class CachedToken:
    access_token: str
    expires_at: datetime

    def is_usable(self, min_remaining_seconds: int = 300) -> bool:
        return datetime.now(timezone.utc) + timedelta(
            seconds=min_remaining_seconds
        ) < self.expires_at


class OktaServiceTokenClient:
    def __init__(
        self,
        token_url: str,
        client_id: str,
        client_secret: str,
        scope: str = "fluffyjaws",
        timeout: int = 30,
        min_remaining_seconds: int = 300,
    ) -> None:
        self.token_url = token_url
        self.client_id = client_id
        self.client_secret = client_secret
        self.scope = scope
        self.timeout = timeout
        self.min_remaining_seconds = min_remaining_seconds
        self._cached: CachedToken | None = None

    def get_access_token(self) -> str:
        if self._cached and self._cached.is_usable(self.min_remaining_seconds):
            return self._cached.access_token

        response = requests.post(
            self.token_url,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "scope": self.scope,
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        payload = response.json()
        expires_in = int(payload.get("expires_in", 3600))
        self._cached = CachedToken(
            access_token=payload["access_token"],
            expires_at=datetime.now(timezone.utc) + timedelta(seconds=expires_in),
        )
        return self._cached.access_token


okta = OktaServiceTokenClient(
    token_url=os.environ.get(
        "OKTA_TOKEN_URL",
        "https://adobe-stage.okta.com/oauth2/aus1exw340qLpDruL1d8/v1/token",
    ),
    client_id=os.environ["OKTA_CLIENT_ID"],
    client_secret=os.environ["OKTA_CLIENT_SECRET"],
)

service_token = okta.get_access_token()
print(service_token)

Reusable Okta user-token PKCE helper

Use this helper when your application needs to drive the browser sign-in once, exchange the code, and keep the resulting user token pair.

Copy
from __future__ import annotations

from base64 import urlsafe_b64encode
from dataclasses import dataclass
from hashlib import sha256
import os
import secrets
from urllib.parse import urlencode

import requests


def base64url(value: bytes) -> str:
    return urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


@dataclass(frozen=True)
class PkceChallenge:
    code_verifier: str
    code_challenge: str
    state: str


def build_pkce_challenge() -> PkceChallenge:
    code_verifier = secrets.token_urlsafe(64)
    return PkceChallenge(
        code_verifier=code_verifier,
        code_challenge=base64url(sha256(code_verifier.encode("ascii")).digest()),
        state=secrets.token_urlsafe(24),
    )


class OktaUserTokenClient:
    def __init__(
        self,
        issuer: str,
        client_id: str,
        redirect_uri: str,
        scope: str = "openid profile email offline_access",
        timeout: int = 30,
    ) -> None:
        self.issuer = issuer.rstrip("/")
        self.client_id = client_id
        self.redirect_uri = redirect_uri
        self.scope = scope
        self.timeout = timeout

    def build_authorize_url(self, pkce: PkceChallenge) -> str:
        return (
            f"{self.issuer}/v1/authorize?"
            + urlencode(
                {
                    "client_id": self.client_id,
                    "response_type": "code",
                    "response_mode": "query",
                    "scope": self.scope,
                    "redirect_uri": self.redirect_uri,
                    "state": pkce.state,
                    "code_challenge_method": "S256",
                    "code_challenge": pkce.code_challenge,
                }
            )
        )

    def exchange_code_for_tokens(
        self,
        authorization_code: str,
        code_verifier: str,
    ) -> dict:
        response = requests.post(
            f"{self.issuer}/v1/token",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "authorization_code",
                "client_id": self.client_id,
                "redirect_uri": self.redirect_uri,
                "code_verifier": code_verifier,
                "code": authorization_code,
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()


client = OktaUserTokenClient(
    issuer=os.environ["OKTA_ISSUER"],
    client_id=os.environ["OKTA_CLIENT_ID"],
    redirect_uri=os.environ["OKTA_REDIRECT_URI"],
)

pkce = build_pkce_challenge()
print("Open this URL in your browser:")
print(client.build_authorize_url(pkce))

authorization_code = input("Paste the ?code= value from the callback URL: ").strip()
token_payload = client.exchange_code_for_tokens(
    authorization_code=authorization_code,
    code_verifier=pkce.code_verifier,
)
print(token_payload["access_token"])
print(token_payload.get("refresh_token"))

Refresh a user token for OBO calls

Use this when you already have a refresh token and need a new user access token.

For a Native PKCE app, do not send a client secret in the refresh request.

Copy
import os
import requests


def refresh_user_token() -> dict:
    response = requests.post(
        os.environ["OKTA_USER_TOKEN_URL"],
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={
            "grant_type": "refresh_token",
            "client_id": os.environ["OKTA_CLIENT_ID"],
            "refresh_token": os.environ["OKTA_REFRESH_TOKEN"],
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


token_payload = refresh_user_token()
print(token_payload["access_token"])


Repo examples are also checked in under docs/examples/python/.
