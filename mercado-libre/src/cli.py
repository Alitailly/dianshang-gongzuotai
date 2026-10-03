"""统一命令行入口"""

import json
import sys

from src.atoms import export, products
from src.store import Store, list_stores


def cmd_products(store: Store, args: list[str]) -> None:
    if not args or args[0] == "list":
        flat = products.flatten_products(store)
        print(f"商品变体总数: {len(flat)}")
        for v in flat:
            print(f"  {v.get('seller_sku', 'N/A'):12s} | {v['title'][:40]:40s} | R$ {v.get('price', 0)} | Qty: {v.get('available_quantity', 0)}")
    elif args[0] == "detail" and len(args) > 1:
        detail = products.get_detail(store, args[1])
        print(json.dumps(detail, ensure_ascii=False, indent=2))
    elif args[0] == "export":
        flat = products.flatten_products(store)
        enriched = products.enrich_products(store, flat)
        from pathlib import Path
        out_dir = Path.home() / "Desktop" / "美客多导出" / store.display_name
        csv_path = export.to_csv(enriched, store.display_name, "products", output_dir=out_dir)
        json_path = export.to_json(enriched, store.display_name, "products", output_dir=out_dir)
        print(f"CSV:  {csv_path}")
        print(f"JSON: {json_path}")
    else:
        _usage("products [list|detail <id>|export]")


def cmd_refresh(store: Store, _args: list[str]) -> None:
    try:
        data = store.refresh_token()
        print(f"[{store.display_name}] Token 刷新成功!")
        print(f"  Expires in: {data.get('expires_in')}s")
    except Exception as e:
        print(f"❌ 刷新失败: {e}")
        print(f"   授权链接: {store.auth.get_auth_url()}")


def _usage(commands: str = "") -> None:
    print(f"用法: python -m src.cli <store> {commands}")
    print()
    print("命令:")
    print("  products list            列出所有商品变体")
    print("  products detail <id>     查看单品详情")
    print("  products export          导出商品到 CSV+JSON")
    print("  --refresh                刷新 Access Token")
    print("  --list-stores            列出所有店铺")


COMMANDS = {
    "products": cmd_products,
    "--refresh": cmd_refresh,
}


def main() -> None:
    args = sys.argv[1:]

    if not args:
        _usage()
        sys.exit(1)

    if args[0] == "--list-stores":
        stores = list_stores()
        print(f"已配置店铺 ({len(stores)}):")
        for s in stores:
            store = Store(s)
            print(f"  {s}  →  {store.display_name}  ({store.site_id})")
        return

    store_name = args[0]
    rest = args[1:]

    try:
        store = Store(store_name)
    except FileNotFoundError as e:
        print(f"❌ {e}")
        print(f"可用店铺: {', '.join(list_stores()) or '(无)'}")
        sys.exit(1)

    action = rest[0] if rest else ""
    handler = COMMANDS.get(action)

    if handler:
        handler(store, rest[1:])
    else:
        print(f"未知命令: {action or '(空)'}")
        _usage()


if __name__ == "__main__":
    main()
