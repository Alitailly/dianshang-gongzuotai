"""店铺列表接口"""

from __future__ import annotations

from typing import List

from fastapi import APIRouter

from src.store import Store, list_stores

router = APIRouter(prefix="/api/stores", tags=["stores"])


@router.get("")
def get_stores() -> List[dict]:
    result = []
    for name in list_stores():
        try:
            s = Store(name)
            result.append(
                {"name": s.name, "display_name": s.display_name, "site_id": s.site_id}
            )
        except Exception:  # noqa: BLE001
            continue
    return result
