"""全页面广告口径对账：经营总览 / 商品分析 / 广告流量 / 广告投放 + 趋势"""
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "backend"))
sys.path.insert(0, str(_ROOT))

from app import db, repository  # noqa: E402
from src.timeutil import br_date_str, br_days_ago  # noqa: E402

# 前端默认「近30天」实际取值：to = 巴西昨天，from = to-29
to = br_days_ago(1)
from datetime import date, timedelta
df = (date.fromisoformat(to) - timedelta(days=29)).isoformat()
print(f"前端默认近30天区间: {df} ~ {to}   巴西今天={br_date_str()}  广告定档={repository._ad_cap(to)}\n")

ov = repository.overview(None, df, to)
sm = repository.ads_summary(None, df, to)["current"]

print(f"{'口径':<34} {'广告花费':>12} {'广告销售额':>12}")
print("-" * 62)
print(f"{'经营总览 /api/overview':<34} {ov['total_ad_cost']:>12.2f}")
print(f"{'广告流量 /api/ads/summary':<34} {sm['cost']:>12.2f} {sm['sales']:>12.2f}")

conn = db.get_conn()
ad_to = repository._ad_cap(to)
r = conn.execute(
    """SELECT COALESCE(SUM(ad_cost),0) c, COALESCE(SUM(ad_sales),0) s FROM daily_snapshot
       WHERE date>=? AND date<=?""", (df, ad_to)).fetchone()
print(f"{'快照直取 (daily_snapshot 全量)':<34} {r['c']:>12.2f} {r['s']:>12.2f}")

r = conn.execute(
    """SELECT COALESCE(SUM(a.ad_cost),0) c FROM
       (SELECT store,item_id,SUM(COALESCE(ad_cost,0)) ad_cost FROM daily_snapshot
        WHERE date>=? AND date<=? GROUP BY store,item_id) a
       JOIN (SELECT DISTINCT store,item_id FROM product_variation) p
         ON p.store=a.store AND p.item_id=a.item_id""", (df, ad_to)).fetchone()
print(f"{'商品分析口径 (JOIN product_variation)':<34} {r['c']:>12.2f}")

# 趋势合计（trend 不封顶；ads_trend 也不封顶）
t1 = sum(x["ad_cost"] or 0 for x in repository.trend(None, df, to) if x["date"] <= ad_to)
t2 = sum(x["cost"] or 0 for x in repository.ads_trend(None, df, to) if x["date"] <= ad_to)
t2_all = sum(x["cost"] or 0 for x in repository.ads_trend(None, df, to))
print(f"{'广告流量·趋势(定档日内合计)':<34} {t2:>12.2f}")
print(f"{'广告流量·趋势(含未定档日)':<34} {t2_all:>12.2f}  ← 图上线末点")
print(f"{'经营总览·趋势(trend)':<34} {t1:>12.2f}")

print("\n===== 投放商品数：两个定义 =====")
n_spend = conn.execute(
    """SELECT COUNT(DISTINCT item_id) FROM daily_snapshot WHERE date>=? AND date<=?
       AND (COALESCE(ad_cost,0)>0 OR COALESCE(ad_clicks,0)>0)""", (df, ad_to)).fetchone()[0]
n_obj = conn.execute("SELECT COUNT(DISTINCT item_id) FROM product_variation WHERE has_ads=1").fetchone()[0]
n_all = conn.execute("SELECT COUNT(DISTINCT item_id) FROM product_variation").fetchone()[0]
print(f"广告流量 ad_items（有花费或点击）      = {n_spend}")
print(f"商品分析 has_ads=1 / 广告投放 商品总数 = {n_obj}")
print(f"商品总数（product_variation）          = {n_all}")

zero = conn.execute(
    """SELECT a.item_id, a.store, a.ad_prints FROM
       (SELECT store,item_id,SUM(COALESCE(ad_impressions,0)) ad_prints,SUM(COALESCE(ad_cost,0)) ad_cost
        FROM daily_snapshot WHERE date>=? AND date<=? GROUP BY store,item_id) a
       WHERE a.ad_cost=0 ORDER BY a.ad_prints DESC LIMIT 20""", (df, ad_to)).fetchall()
print(f"\n[近30天 有曝光但零花费 的商品 {len(zero)} 个（前20）]")
for z in zero:
    print(f"  {z['item_id']} [{z['store']}] 曝光={z['ad_prints']:.0f} 花费=0")
conn.close()
