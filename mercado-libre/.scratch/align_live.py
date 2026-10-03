"""对比 广告投放页（实时 ads/search）与 广告流量页（daily_snapshot 快照）的广告口径"""
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "backend"))
sys.path.insert(0, str(_ROOT))

from app import db, repository  # noqa: E402
from app.routers import ad_manage  # noqa: E402
from src.timeutil import br_days_ago  # noqa: E402

df, dt = br_days_ago(29), br_days_ago(0)
cap = repository._ad_cap(dt)
print(f"区间 {df} ~ {dt}（实时拉取上界 dt -> _ad_cap = {cap}）\n")

snap = repository.ads_summary(None, df, dt)["current"]
print("[广告流量 /api/ads/summary（快照）]")
print(f"  cost={snap['cost']:.2f} sales={snap['sales']:.2f} clicks={snap['clicks']:.0f} prints={snap['impressions']:.0f} items={snap['ad_items']}")

rows = ad_manage._load_ads(df, dt)
live_cost = sum(r["ad_cost"] for r in rows)
live_sales = sum(r["ad_sales"] for r in rows)
live_clicks = sum(r["ad_clicks"] for r in rows)
live_prints = sum(r["ad_impressions"] for r in rows)
print(f"\n[广告投放 /api/ad-manage/items（实时 ads/search）] 行数={len(rows)}")
print(f"  cost={live_cost:.2f} sales={live_sales:.2f} clicks={live_clicks:.0f} prints={live_prints:.0f} "
      f"去重item={len({r['item_id'] for r in rows})}")

print(f"\n[差额 实时 - 快照]")
print(f"  cost={live_cost-snap['cost']:.2f} sales={live_sales-snap['sales']:.2f} "
      f"clicks={live_clicks-snap['clicks']:.0f} prints={live_prints-snap['impressions']:.0f}")

# 逐 item 对比（快照 vs 实时）
conn = db.get_conn()
snap_rows = {
    r["item_id"]: dict(r)
    for r in conn.execute(
        """SELECT item_id, store, SUM(COALESCE(ad_cost,0)) AS cost, SUM(COALESCE(ad_sales,0)) AS sales,
                  SUM(COALESCE(ad_clicks,0)) AS clicks, SUM(COALESCE(ad_impressions,0)) AS prints
           FROM daily_snapshot WHERE date >= ? AND date <= ? GROUP BY store, item_id""",
        (df, cap),
    ).fetchall()
}
conn.close()

live_by_item: dict = {}
for r in rows:
    k = r["item_id"]
    d = live_by_item.setdefault(k, {"store": r["store"], "cost": 0.0, "sales": 0.0, "clicks": 0.0, "prints": 0.0, "n_ads": 0})
    d["cost"] += r["ad_cost"]
    d["sales"] += r["ad_sales"]
    d["clicks"] += r["ad_clicks"]
    d["prints"] += r["ad_impressions"]
    d["n_ads"] += 1

all_items = sorted(set(snap_rows) | set(live_by_item))
print(f"\n[逐 item 差异（只列 cost 或 clicks 不等，或只有一边有）]  共 {len(all_items)} 个 item")
diff_n = 0
for iid in all_items:
    s = snap_rows.get(iid, {"store": "-", "cost": 0.0, "sales": 0.0, "clicks": 0.0, "prints": 0.0})
    l = live_by_item.get(iid, {"store": "-", "cost": 0.0, "sales": 0.0, "clicks": 0.0, "prints": 0.0, "n_ads": 0})
    if abs(s["cost"] - l["cost"]) > 0.01 or s["clicks"] != l["clicks"]:
        diff_n += 1
        if diff_n <= 30:
            tag = ""
            if iid not in snap_rows:
                tag = "  ← 只实时有"
            elif iid not in live_by_item:
                tag = "  ← 只快照有"
            print(f"  {iid} [{s['store'] or l['store']}] 快照 cost={s['cost']:.2f}/clk={s['clicks']:.0f}"
                  f" | 实时 cost={l['cost']:.2f}/clk={l['clicks']:.0f} (ads={l['n_ads']}){tag}")
print(f"  差异 item 数 = {diff_n}")
