"""Mercado Libre API 客户端"""

import time

import requests


class MLClient:
    """Mercado Libre API 封装，所有请求自动带 token；429/5xx 自动重试（退避）"""

    BASE_URL = "https://api.mercadolibre.com"
    MAX_RETRIES = 3

    def __init__(self, auth):
        self._auth = auth
        self._session = requests.Session()

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._auth.access_token}",
            "Content-Type": "application/json",
        }

    def get(self, path: str, params: dict = None, headers: dict = None) -> dict:
        return self._request("GET", path, params=params, headers=headers)

    def post(self, path: str, json: dict = None, params: dict = None, headers: dict = None) -> dict:
        return self._request("POST", path, params=params, headers=headers, json=json)

    def _request(self, method: str, path: str, *, params: dict = None, headers: dict = None, json: dict = None) -> dict:
        h = self._headers()
        if headers:
            h.update(headers)
        last_err = None
        for attempt in range(self.MAX_RETRIES + 1):
            try:
                resp = self._session.request(
                    method,
                    f"{self.BASE_URL}{path}",
                    headers=h,
                    params=params,
                    json=json,
                    timeout=30,
                )
                if resp.status_code == 429:
                    # 限流：按 Retry-After 或退避等待后重试（最多 MAX_RETRIES 次）
                    wait = self._retry_wait(resp, attempt)
                    last_err = f"429 Too Many Requests（等待 {wait}s 后重试）"
                    print(
                        f"[ml-client] 429 限流 {path[:70]}... {wait}s 后重试 ({attempt + 1}/{self.MAX_RETRIES})",
                        flush=True,
                    )
                    time.sleep(wait)
                    continue
                resp.raise_for_status()
                return resp.json()
            except requests.exceptions.HTTPError as e:
                code = e.response.status_code if e.response is not None else None
                last_err = str(e)
                # 5xx 服务端错误：退避重试；其他错误（4xx 非限流）直接抛
                if code in (500, 502, 503, 504) and attempt < self.MAX_RETRIES:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise
        raise RuntimeError(f"ML API 请求失败（重试 {self.MAX_RETRIES} 次后）: {path} | {last_err}")

    @staticmethod
    def _retry_wait(resp, attempt: int) -> float:
        ra = resp.headers.get("Retry-After")
        if ra and ra.isdigit():
            return min(float(ra), 60)
        return 5.0 * (attempt + 1)

    def get_my_user(self) -> dict:
        """获取当前授权用户信息"""
        return self.get("/users/me")
