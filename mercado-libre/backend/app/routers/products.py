"""商品详情接口"""

from __future__ import annotations

from fastapi import APIRouter

from .. import repository

router = APIRouter(prefix="/api/products", tags=["products"])


@router.get("/{item_id}")
def get_product(item_id: str):
    return repository.get_product(item_id)
