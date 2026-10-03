"""验证「数据对齐」改动：投放商品口径统一 + 区间截到定档日后派生列同窗

注意：repository.py 用 `from src.timeutil import br_latest_finalized_date` 绑定到自己的命名空间，
要模拟「巴西 0:00–10:00 定档日退回前天」必须 patch `repository.br_latest_finalized_date`，
patch `timeutil.br_latest_finalized_date` 不生效（会得到假通过）。
"""
import sys
from datetime import date, timedelta
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "backend"))
sys.path.insert(0, str(_ROOT))

from app import repository  # noqa: E402
from src import timeutil  # noqa: E402

ok = True


def check(name, cond, detail=""):
    global ok
    ok = ok and bool(cond)
    print(f"  [{'OK ' if cond else 'FAIL'}] {name} {detail}")


# ============ 1. 投放商品口径统一 ============
print("== 1. 投放商品：列表 total 与汇总 ad_items 同口径 ==")
to = timeutil.br_days_ago(1)
df = (date.fromisoformat(to) - timedelta(days=29)).isoformat()
sm = repository.ads_summary(None, df, to)["current"]
res = repository.list_items(ad_active="1", date_from=df, date_to=to, page_size=500)
allres = repository.list_items(date_from=df, date_to=to, page_size=500)
print(f"  区间 {df}~{to}")
check("列表 total == 汇总 ad_items", res["total"] == sm["ad_items"], f"{res['total']} vs {sm['ad_items']}")
check("列表返回行数 == total", len(res["items"]) == res["total"])
check("列表广告花费合计 == 汇总 cost",
      abs(sum(it["ad_cost"] for it in res["items"]) - sm["cost"]) < 0.01,
      f"{sum(it['ad_cost'] for it in res['items']):.2f} vs {sm['cost']:.2f}")
check("无广告数据的商品被排除在广告列表外", res["total"] < allres["total"],
      f"广告列表 {res['total']} < 全部商品 {allres['total']}")
zero = [it for it in res["items"]
        if not (it["ad_impressions"] or it["ad_cost"] or it["ad_clicks"])]
check("广告列表里没有零广告数据的商品", not zero, f"零数据商品数={len(zero)}")

# ============ 2. 巴西 0:00–10:00：区间截到定档日才同窗 ============
print("\n== 2. 模拟巴西 0:00–10:00（定档日退回前天）==")
real = repository.br_latest_finalized_date          # 必须 patch 这里
yday = timeutil.br_days_ago(1)
sim_cap = timeutil.br_days_ago(2)                   # 模拟：定档日 = 前天
repository.br_latest_finalized_date = lambda: sim_cap
try:
    print(f"  df={df}  昨天={yday}  模拟定档日={sim_cap}")

    def summary_vs_trend(dt):
        s = repository.ads_summary(None, df, dt)["current"]
        tr = repository.ads_trend(None, df, dt)
        return s["cost"], round(sum(r["cost"] for r in tr), 2), \
            [r["date"] for r in tr if not r["finalized"]]

    # 旧行为：区间结束日 = 昨天（> 定档日）→ 汇总截到定档日、趋势含未定档日 → 两张图对不上
    old_sum, old_tr, old_unf = summary_vs_trend(yday)
    # 新行为：区间结束日 = min(昨天, 定档日) = 前天 → 同窗
    new_sum, new_tr, new_unf = summary_vs_trend(sim_cap)
    print(f"  旧(区间到昨天): 汇总cost={old_sum:.2f} 趋势Σcost={old_tr:.2f} "
          f"差={old_sum-old_tr:.2f} 未定档日={old_unf}")
    print(f"  新(区间到定档日): 汇总cost={new_sum:.2f} 趋势Σcost={new_tr:.2f} "
          f"差={new_sum-new_tr:.2f} 未定档日={new_unf}")
    check("旧口径：汇总与趋势对不上（复现问题）", abs(old_sum - old_tr) > 0.5,
          f"差 {old_sum-old_tr:.2f}")
    check("旧口径：趋势里存在未定档日", bool(old_unf), f"{old_unf}")
    check("新口径：汇总与趋势一致", abs(new_sum - new_tr) < 0.01)
    check("新口径：区间内无未定档日", not new_unf)

    # 商品级：旧口径下自然销售额 = rev(全窗) − ad_sales(截断窗) → 混窗
    def nat(dt):
        rows = repository.list_items(date_from=df, date_to=dt, page_size=500)["items"]
        return {it["item_id"]: (it["revenue"], it["ad_sales"], it["natural_sales"]) for it in rows}

    old_items, new_items = nat(yday), nat(sim_cap)
    mixed = [k for k in new_items
             if k in old_items and abs(old_items[k][2] - new_items[k][2]) > 0.01]
    print(f"  商品级：自然销售额『未截断 vs 截断』不同 = {len(mixed)} / {len(new_items)}")
    if mixed:
        k = mixed[0]
        print(f"    例 {k}: 未截断 rev={old_items[k][0]:.2f} ad_sales={old_items[k][1]:.2f} "
              f"natural={old_items[k][2]:.2f} | 截断后 natural={new_items[k][2]:.2f}")
    check("旧口径：部分商品自然销售额混窗（复现问题）", bool(mixed))
    check("新口径：商品级广告/订单同窗（natural == revenue − ad_sales）",
          all(abs(t[2] - (t[0] - t[1])) < 0.01 for t in new_items.values()))
finally:
    repository.br_latest_finalized_date = real

# ============ 3. 含未定档日时趋势仍有标记（供图表判断）============
print("\n== 3. 趋势接口定档标记 ==")
tr = repository.ads_trend(None, df, yday)
t = repository.trend(None, df, yday)
check("ads_trend 每天有 finalized", all("finalized" in r for r in tr))
check("trend 每天有 finalized", all("finalized" in r for r in t))

from app import db  # noqa: E402

conn = db.get_conn()
conn.close()
print(f"\n{'全部通过' if ok else '存在失败项'}")
sys.exit(0 if ok else 1)
