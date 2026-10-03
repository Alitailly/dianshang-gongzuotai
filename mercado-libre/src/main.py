"""连接测试 & CLI 入口"""

import sys

from src.store import Store, list_stores


def test_connection(store_name: str = "ba05"):
    """测试指定店铺的 API 连接"""
    store = Store(store_name)

    if not store.auth.access_token:
        print(f"⚠️  [{store.display_name}] 没有 ACCESS_TOKEN，需要 OAuth 授权")
        print(f"   {store.auth.get_auth_url()}")
        return

    try:
        user = store.client.get_my_user()
        print(f"✅ [{store.display_name}] 连接成功!")
        print(f"   用户 ID: {user['id']}")
        print(f"   昵称:    {user['nickname']}")
        print(f"   邮箱:    {user.get('email', 'N/A')}")
    except Exception as e:
        err = str(e)
        if any(code in err for code in ("401", "403", "expired")):
            print(f"⚠️  [{store.display_name}] Token 过期，尝试刷新...")
            print(f"   python -m src.main {store_name} --refresh")
        else:
            print(f"❌ [{store.display_name}] 连接失败: {e}")


def do_refresh(store_name: str):
    """刷新 token"""
    store = Store(store_name)
    try:
        data = store.refresh_token()
        print(f"✅ [{store.display_name}] Token 刷新成功!")
        print(f"   Access Token:  {data['access_token'][:50]}...")
        print(f"   Expires in:     {data.get('expires_in')}s")
    except Exception as e:
        print(f"❌ 刷新失败: {e}")
        print(f"   可能需要重新授权:")
        print(f"   {store.auth.get_auth_url()}")


if __name__ == "__main__":
    args = sys.argv[1:]

    if not args:
        # 默认测试 ba05
        test_connection("ba05")
    elif args[0] == "--list":
        print("已配置的店铺:")
        for s in list_stores():
            print(f"  - {s}")
    elif len(args) == 2 and args[1] == "--refresh":
        do_refresh(args[0])
    elif len(args) == 2 and args[1] == "--test":
        test_connection(args[0])
    else:
        print("用法:")
        print("  python -m src.main                  # 测试 ba05 连接")
        print("  python -m src.main <store> --test   # 测试指定店铺")
        print("  python -m src.main <store> --refresh # 刷新 token")
        print("  python -m src.main --list           # 列出所有店铺")
