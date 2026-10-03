"""一次性排查脚本：对比 广告流量 / 商品分析 / 快照孤儿广告 三个口径"""
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "backend"))
sys.path.insert(0, str(_ROOT))

from app import db, repository  # noqa: E402
from src.timeutil import br_latest_finalized_date, br_days_ago  # noqa: E402

cap = br_latest_finalized_date()
print(f"广告定档截止日 = {cap}, 今天 = {br_days_ago(0)}")

df, dt = br_days_ago(29), br_days_ago(0)
print(f"区间: {df} ~ {dt} (广告上界 {repository._ad_cap(dt)})\n")

# ---- 口径 1：广告流量页 ads_summary（daily_snapshot 全量，不 JOIN 商品）----
s = repository.ads_summary(None, df, dt)["current"]
print("[广告流量 /api/ads/summary]")
print(f"  cost={s['cost']:.2f} sales={s['sales']:.2f} clicks={s['clicks']} prints={s['impressions']} ad_items={s['ad_items']}")

conn = db.get_conn()
ad_to = repository._ad_cap(dt)

# ---- 口径 2：商品分析页 list_items（daily_snapshot JOIN product_variation）----
q = conn.execute(
    """
    SELECT COALESCE(SUM(a.ad_cost),0) AS cost,
           COALESCE(SUM(a.ad_sales),0) AS sales,
           COALESCE(SUM(a.ad_clicks),0) AS clicks,
           COALESCE(SUM(a.ad_impressions),0) AS prints,
           COUNT(*) AS n_items
    FROM (SELECT store, item_id,
                 SUM(COALESCE(ad_cost,0)) AS ad_cost,
                 SUM(COALESCE(ad_sales,0)) AS ad_sales,
                 SUM(COALESCE(ad_clicks,0)) AS ad_clicks,
                 SUM(COALESCE(ad_impressions,0)) AS ad_impressions
          FROM daily_snapshot WHERE date >= ? AND date <= ?
          GROUP BY store, item_id) a
    JOIN (SELECT DISTINCT store, item_id FROM product_variation) p
      ON p.item_id = a.item_id AND p.store = a.store
    """,
    (df, ad_to),
).fetchone()
print("[商品分析 /api/items —— 仅计入仍在 product_variation 的商品]")
print(f"  cost={q['cost']:.2f} sales={q['sales']:.2f} clicks={q['clicks']} prints={q['prints']} n_items={q['n_items']}")

print("\n[差额 = 广告流量 - 商品分析]")
print(f"  cost={s['cost']-q['cost']:.2f} sales={s['sales']-q['sales']:.2f} "
      f"clicks={s['clicks']-q['clicks']} prints={s['impressions']-q['prints']} "
      f"items={s['ad_items']-q['n_items']}")

# ---- 孤儿广告明细：daily_snapshot 有广告花费但 product_variation 里没有 ----
orphans = conn.execute(
    """
    SELECT a.store, a.item_id, a.ad_cost, a.ad_sales, a.ad_clicks, a.ad_impressions
    FROM (SELECT store, item_id,
                 SUM(COALESCE(ad_cost,0)) AS ad_cost,
                 SUM(COALESCE(ad_sales,0)) AS ad_sales,
                 SUM(COALESCE(ad_clicks,0)) AS ad_clicks,
                 SUM(COALESCE(ad_impressions,0)) AS ad_impressions
          FROM daily_snapshot WHERE date >= ? AND date <= ?
          GROUP BY store, item_id) a
    LEFT JOIN (SELECT DISTINCT store, item_id FROM product_variation) p
      ON p.item_id = a.item_id AND p.store = a.store
    WHERE p.item_id IS NULL AND (a.ad_cost > 0 OR a.ad_clicks > 0 OR a.ad_impressions > 0)
    ORDER BY a.ad_cost DESC
    """,
    (df, ad_to),
).fetchall()
print(f"\n[孤儿广告（快照里有、商品表里没有）共 {len(orphans)} 个 item]")
for r in orphans[:20]:
    print(f"  {r['store']} {r['item_id']}: cost={r['ad_cost']:.2f} sales={r['ad_sales']:.2f} "
          f"clicks={r['ad_clicks']} prints={r['ad_impressions']}")

# ---- 口径 3：daily_snapshot 里 ad_clicks 与 product_variation.has_ads 的对照 ----
n_has = conn.execute("SELECT COUNT(DISTINCT item_id) FROM product_variation WHERE has_ads=1").fetchone()[0]
n_clk = conn.execute(
    "SELECT COUNT(DISTINCT item_id) FROM daily_snapshot WHERE date>=? AND date<=? AND COALESCE(ad_clicks,0)>0",
    (df, ad_to),
).fetchone()[0]
n_cost = conn.execute(
    "SELECT COUNT(DISTINCT item_id) FROM daily_snapshot WHERE date>=? AND date<=? AND COALESCE(ad_cost,0)>0",
    (df, ad_to),
).fetchone()[0]
print(f"\n[商品数口径] product_variation.has_ads=1: {n_has} 个; 快照有花费: {n_cost} 个; 快照有点击: {n_clk} 个")

# ---- 检查 daily_snapshot 是否对同一 item+date 只有一行（多广告是否已累加）----
dup = conn.execute(
    "SELECT COUNT(*) FROM (SELECT store,item_id,date FROM daily_snapshot GROUP BY store,item_id,date HAVING COUNT(*)>1)"
).fetchone()[0]
print(f"[daily_snapshot 同(store,item,date)重复行组数] {dup}（主键保证应为 0）")
conn.close()
