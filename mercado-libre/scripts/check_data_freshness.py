"""核实各数据源的实时性：订单 / 访客 / 广告（今天 vs 昨天 vs 前天）"""

import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.store import Store
from src.timeutil import br_now, br_date_str


def fmt(dt) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000-03:00")


def main():
    store = Store("ba05")
    store.refresh_token()
    uid = store.client.get_my_user()["id"]

    now = br_now()
    today = now.strftime("%Y-%m-%d")
    yest = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    two = (now - timedelta(days=2)).strftime("%Y-%m-%d")
    print(f"巴西现在: {now.isoformat()}  (今天={today}, 昨天={yest}, 前天={two})")
    print()

    # ---- 1) 订单：只查今天 —— 实时还是延时 ----
    today_start = f"{today}T00:00:00.000-03:00"
    today_end = fmt(now)
    try:
        data = store.client.get(
            "/orders/search",
            params={
                "seller": uid,
                "order.status": "paid",
                "order.date_created.from": today_start,
                "order.date_created.to": today_end,
                "limit": 50,
                "offset": 0,
            },
        )
        total = data.get("paging", {}).get("total", 0)
        print(f"[订单] 今天已支付订单数: {total}  -> {'实时' if total > 0 else '今天无单或延时'}")
    except Exception as e:
        print(f"[订单] 查询失败: {e}")

    # ---- 2) 访客：今天 / 昨天 / 前天 单日 ----
    try:
        item_ids = store.client.get(
            f"/users/{uid}/items/search", params={"limit": 3}
        ).get("results", [])
        for day, label in [(today, "今天"), (yest, "昨天"), (two, "前天")]:
            d = store.client.get(
                f"/items/{item_ids[0]}/visits",
                params={"date_from": day, "date_to": day},
            )
            print(f"[访客] {label}({day}): {d.get('total_visits')}  -> 原始返回: {d}")
    except Exception as e:
        print(f"[访客] 查询失败: {e}")

    # ---- 3) 广告：近3天按天查，对比今天是否为空/偏少 ----
    site_id = store.site_id
    adv = store.client.get(
        "/advertising/advertisers", params={"product_id": "PADS"}
    )
    advertiser_id = ""
    for a in adv.get("advertisers", []):
        if a.get("site_id") == site_id:
            advertiser_id = str(a.get("advertiser_id", ""))
    print(f"\n[广告] advertiser_id={advertiser_id}")

    for day, label in [(today, "今天"), (yest, "昨天"), (two, "前天")]:
        data = store.client.get(
            f"/marketplace/advertising/{site_id}/advertisers/{advertiser_id}/product_ads/ads/search",
            params={
                "metrics": "clicks,prints,ctr,cost,roas,total_amount,acos",
                "date_from": day,
                "date_to": day,
                "limit": 50,
                "offset": 0,
            },
            headers={"Api-Version": "2"},
        )
        results = data.get("results", [])
        n = len(results)
        cost = sum((r.get("metrics") or {}).get("cost") or 0 for r in results)
        clicks = sum((r.get("metrics") or {}).get("clicks") or 0 for r in results)
        sales = sum((r.get("metrics") or {}).get("total_amount") or 0 for r in results)
        print(
            f"[广告] {label}({day}): {n}条 花费={cost:.2f} 点击={clicks} 广告销售={sales:.2f}"
        )


if __name__ == "__main__":
    main()
