"""Mercado Libre OAuth 2.0 认证模块（PKCE 支持，多店铺兼容）"""

from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode

import requests

ML_AUTH_URL = "https://api.mercadolibre.com/oauth/token"


def _pkce_pair() -> tuple[str, str]:
    """生成 PKCE code_verifier 和 code_challenge (S256)"""
    verifier = secrets.token_urlsafe(64)[:128]
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


class MLAuth:
    """Mercado Libre 认证管理器"""

    def __init__(
        self,
        client_id: str = "",
        client_secret: str = "",
        redirect_uri: str = "",
        access_token: str = "",
        refresh_token: str = "",
        env_path: Path | None = None,
    ):
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self._access_token = access_token
        self._refresh_token = refresh_token
        self._expires_at = None
        self._code_verifier = None
        self._env_path = env_path

    @property
    def access_token(self) -> str | None:
        return self._access_token

    @property
    def refresh_token(self) -> str | None:
        return self._refresh_token

    def get_auth_url(self, state: str = "") -> str:
        """生成 PKCE 授权 URL"""
        verifier, challenge = _pkce_pair()
        self._code_verifier = verifier
        base = "https://auth.mercadolivre.com.br/authorization"
        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "scope": "offline_access read write",
        }
        if state:
            params["state"] = state
        return f"{base}?{urlencode(params)}"

    def exchange_code(self, code: str) -> dict:
        """用授权码 + PKCE verifier 换取 access token"""
        payload = {
            "grant_type": "authorization_code",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code": code,
            "redirect_uri": self.redirect_uri,
        }
        if self._code_verifier:
            payload["code_verifier"] = self._code_verifier
        return self._request_token(payload)

    def refresh(self) -> dict:
        """刷新 access token"""
        payload = {
            "grant_type": "refresh_token",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "refresh_token": self._refresh_token,
        }
        return self._request_token(payload)

    def _request_token(self, payload: dict) -> dict:
        resp = requests.post(
            ML_AUTH_URL,
            data=payload,
            headers={"Accept": "application/json"},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        self._access_token = data["access_token"]
        if "refresh_token" in data:
            self._refresh_token = data["refresh_token"]
        self._expires_at = datetime.now() + timedelta(seconds=data.get("expires_in", 21600))
        return data
