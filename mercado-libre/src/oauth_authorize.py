"""OAuth 授权脚本 — 生成授权链接，用户授权后换取 token 并保存到店铺 env"""

import sys
from urllib.parse import urlparse, parse_qs

from src.store import Store


def authorize(store_name: str) -> None:
    store = Store(store_name)
    auth = store.auth

    # 1. 生成授权 URL（code_verifier 会保存在 auth 实例内存里）
    url = auth.get_auth_url()
    print("=" * 60)
    print("请用浏览器打开下面的链接，登录美客多并授权：")
    print()
    print(url)
    print()
    print("授权完成后，浏览器会跳转到 google.com 并带一个 ?code= 参数。")
    print("把完整的跳转地址粘贴到这里（或直接粘贴 code= 后面的内容）：")
    print("=" * 60)

    raw = input("> ").strip()
    code = raw
    if "code=" in raw:
        parsed = urlparse(raw)
        code = parse_qs(parsed.query).get("code", [""])[0]

    if not code:
        print("❌ 没有拿到授权码")
        sys.exit(1)

    # 2. 用授权码换 token
    try:
        data = auth.exchange_code(code)
    except Exception as e:
        print(f"❌ 换 token 失败: {e}")
        sys.exit(1)

    # 3. 保存到 env 文件
    store._save_tokens(data)
    print("✅ 授权成功，token 已保存")
    print(f"   Access Token:  {data['access_token'][:20]}...")
    print(f"   Expires in:    {data.get('expires_in')}s")
    if "refresh_token" in data:
        print(f"   Refresh Token: 已保存")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("用法: python -m src.oauth_authorize <store-name>")
        sys.exit(1)
    authorize(sys.argv[1])
