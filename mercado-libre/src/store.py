"""多店铺管理：加载 stores.d/ 下的店铺配置"""

import os
from pathlib import Path

from dotenv import dotenv_values

from src.auth import MLAuth
from src.client import MLClient

STORES_DIR = Path(__file__).parent.parent / "stores.d"


def list_stores() -> list[str]:
    """列出所有已配置的店铺名称"""
    if not STORES_DIR.exists():
        return []
    return sorted(
        f.stem for f in STORES_DIR.glob("*.env")
        if not f.name.startswith("store.example")
    )


class Store:
    """单个 Mercado Libre 店铺，包含认证和 API 客户端"""

    def __init__(self, name: str):
        env_path = STORES_DIR / f"{name}.env"
        if not env_path.exists():
            raise FileNotFoundError(f"店铺配置不存在: {env_path}")

        config = dotenv_values(str(env_path))
        self.name = name
        self.display_name = config.get("STORE_NAME", name)
        self.site_id = config.get("ML_SITE_ID", "MLB")
        self.user_id = config.get("USER_ID", "")

        self._env_path = env_path
        self.auth = MLAuth(
            client_id=config.get("CLIENT_ID", ""),
            client_secret=config.get("CLIENT_SECRET", ""),
            redirect_uri=config.get("REDIRECT_URI", ""),
            access_token=config.get("ACCESS_TOKEN", ""),
            refresh_token=config.get("REFRESH_TOKEN", ""),
            env_path=env_path,
        )
        self.client = MLClient(self.auth)

    def refresh_token(self) -> dict:
        """刷新 access token 并自动保存"""
        result = self.auth.refresh()
        self._save_tokens(result)
        return result

    def _save_tokens(self, data: dict) -> None:
        """把新 token 写回 store env 文件"""
        with open(self._env_path) as f:
            lines = f.readlines()

        mapping = {}
        mapping["ACCESS_TOKEN"] = f"ACCESS_TOKEN={data['access_token']}\n"
        if "refresh_token" in data:
            mapping["REFRESH_TOKEN"] = f"REFRESH_TOKEN={data['refresh_token']}\n"

        new_lines = []
        for line in lines:
            stripped = line.strip()
            replaced = False
            for key, new_line in mapping.items():
                if stripped.startswith(f"{key}="):
                    new_lines.append(new_line)
                    del mapping[key]
                    replaced = True
                    break
            if not replaced:
                new_lines.append(line)

        with open(self._env_path, "w") as f:
            f.writelines(new_lines)
