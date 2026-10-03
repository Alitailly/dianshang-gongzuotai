# Product Ads API 官方文档（中文翻译）

- 原文：Mercado Libre Global Selling 开发者站《Product Ads for Catalog and User Products》
- 原文 URL：https://global-selling.mercadolibre.com/devsite/new-product-ads （英文镜像 `/devsite/en_us/new-product-ads`）
- 原文更新时间：2026-07-03（页脚）
- 翻译日期：2026-09-04
- **说明**：官方无中文版（本站 `/zh/` 路径返回的仍是英文），此为中译本，字段与端点以官方英文原文为准。⚠️ 标注「译注」处为译者补充（含本项目实测对照），非官方内容。

---

## 0. 重要公告：旧版端点停用（官方原文）

> 过渡期于 2025 年 9 月结束后，下列 **legacy（旧版）Product Ads 端点** 将于 **2026 年 5 月 27 日永久弃用**。自该日起，对这些资源的调用将返回错误（404 Not Found）。如果你的应用仍在用这些端点，请立即调整开发，避免服务中断。**只有 Product Ads 文档中发布的端点受支持。**

将被停用的端点清单：

1. `GET /marketplace/advertising/product_ads/campaigns/$CAMPAIGN_ID/ads/metrics`
2. `GET /marketplace/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/ads/search`
3. `GET /marketplace/advertising/$ADVERTISER_SITE_ID/product_ads/ads/$ITEM_ID`
4. `PUT /marketplace/advertising/$ADVERTISER_SITE_ID/product_ads/ads/$ITEM_ID`
5. `PUT /marketplace/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/ads`

> 译注（实测对照）：本仓库正在使用的读端点正是清单第 2 条（`.../product_ads/ads/search`），但 2026-09-04 实测仍返回 200，未 404——下线公告与线上实际执行不一致（官方或分批执行/推迟，无公开说明）。另有次生下线：按 item 查 ad group 的旧方式与旧 ads metrics 端点至 **2026-06-30** 移除。

---

## 1. 广告分组类型（Ad grouping types）

Product Ads 现支持三种分组：

| 类型 | 适用 | `ad_group_external_id` 映射 |
|---|---|---|
| **CATALOG** | 通过 Catalog 发布的商品 | `parent_id` |
| **FAMILY** | 通过 User Products 发布的商品 | `family_id` |
| **ITEM** | 传统单个商品 | `item_id` |

## 2. 新版统一变体流程（New unified variant flow）

新版流程下，同一商品的所有变体（含 Catalog 发布）在**同一个** Product Ads campaign 内管理：

- **之前**：同一商品的不同变体（颜色/尺码）被分开投放、可能关联不同 campaign；User Products 与 Catalog 商品需各自独立 campaign。
- **现在**：所有变体统一进单个 campaign；表现最好的变体作为 campaign 基线；对 campaign 的操作（编辑/暂停/激活）同时作用于所有变体。
- Product Ads API 现以 `family_id` 和 `catalog_product_id` 为变体中心分组点；对商品的操作（如状态变更）自动复制到所有关联变体；新增变体不需要新建 campaign。

## 3. 新旧流程对照（官方推荐迁移路径）

| 功能 | 旧流程 | 新流程 |
|---|---|---|
| Check advertiser | Check advertiser | **不变** |
| Campaigns：创建/修改 | Create/Modify campaign | **不变** |
| Ads：广告详情 | Ad detail | **Search Ad Groups by items → Ad Group detail** |
| Ads：修改广告（单个/最多 1 万） | Modify ad | **Add, move and update ads in campaign**（单个 / 批量） |
| Ads：删除广告 | Delete ad | **Delete ad from campaign**（单个 / 批量） |
| Metrics：广告指标 | Ads metrics | 由 **Ad Group metrics** 取代 |
| Metrics：campaign 指标 | Campaign metrics | **不变** |

**推荐技术流程**：Check advertiser → Campaigns（Create → Modify）→ Ads/Ad Groups（按商品搜 Ad Group → Ad Group 详情 → 增/移/改广告 → 删广告）→ Metrics（Campaign metrics → Ad Group metrics）。

---

## 4. Check advertiser（查广告主 / 账户资质）

**资质要求（官方）**：使用 Product Ads 必须满足——
- 信誉黄牌及以上；
- 在 Mercado Libre 注册满 15 天；
- 有最低销量（公司 1 单 / 个人 10 单）；
- 无逾期账单。

`advertiser_id` 是投入预算做广告投放的主体。按产品类型查询用户可访问的广告主列表：

**必填参数**：`product_id`——产品类型。可选值：`PADS`（Product Ads）、`DISPLAY`、`BADS`（Brand Ads）。

```bash
curl -X GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'Content-Type: application/json' -H 'Api-Version: 1' \
  'https://api.mercadolibre.com/advertising/advertisers?product_id=PADS'
```

响应字段：`advertiser_id`（后续所有请求用）、`site_id`（站点国别）、`advertiser_name`、`account_name`。

> 注意（官方）：若收到错误 **404 - No permissions found for user_id**，说明该用户未开通 Product Ads。需在 Mercado Libre > My profile > Advertising 激活。

> 译注（实测对照）：本项目 BA05 / AW04 此接口均返回 200，说明账户层已开通。字段列表里出现多个 site 的 advertiser 是正常的。

---

## 5. 创建 campaign（Create campaign）—— 广告写的核心入口

> 官方注意：**自 2025 年 12 月起，`acos_target` 字段被 `roas_target` 取代**。系统现在以 Target ROAS 作为创建/更新 campaign 的标准指标。创建时必须发送全部 campaign 参数。

**字段全解**：

| 字段 | 说明 |
|---|---|
| `name` | Campaign 名称 |
| `status` | `active` 或 `paused` |
| `budget` | 平均每日预算，可逐日浮动 |
| `strategy` | `profitability`（盈利优先：少而精，适合成熟热销品）/ `increase`（增长：盈利与曝光平衡，适合有销量但非爆款）/ `visibility`（曝光优先：投更多钱给更多人看，适合新品） |
| `channel` | Campaign 渠道，默认 `marketplace` |
| `roas_target` | **目标 ROAS**：每投 1 单位货币带来的广告归属收入。取值 **≥1x 且 ≤35x**。低目标 → 更多销量更大曝光但单笔利润低；高目标 → 单笔利润高但广告竞争力弱、总销量/收入低 |

**每日预算上限说明（官方）**：最多可用到原始估算的 **2 倍（100%）透支**，用前几日未花完的余额。例：日预算估算 US$1,000，若前几天攒下 US$1,000 余额，当日最多可投 US$2,000。月中改预算 → 重新计算并取新值；整月暂停 → 不消耗该月预算。

```bash
curl -L -X POST 'https://api.mercadolibre.com/marketplace/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/campaigns' \
  -H 'Authorization: Bearer $ACCESS_TOKEN' \
  -H 'api-version: 2' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Main Campaign",
    "status": "active",
    "budget": 950,
    "strategy": "profitability",
    "channel": "marketplace",
    "roas_target": 19
  }'
```

响应示例：`{"id": 355328313, "name": "Main Campaign", "status": "active", "currency_id": "USD", "strategy": "PROFITABILITY", "acos_target": 5.26, "channel": "marketplace", "advertiser_id": 694824, "budget": 950.0, "roas_target": 19.0, ...}`

> `acos_target` 会临时保留为可选指标，按公式自动计算：**ACOS = (1/ROAS) × 100**。

---

## 6. 修改 campaign（Modify campaign）—— 改预算 / 暂停 / 改 ROAS 目标

> 更新时至少发送一个要修改的参数即可。

```bash
curl -L -X PUT 'https://api.mercadolibre.com/marketplace/advertising/$ADVERTISER_SITE_ID/product_ads/campaigns/$CAMPAIGN_ID' \
  -H 'Authorization: Bearer $ACCESS_TOKEN' \
  -H 'api-version: 2' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Main Campaign",
    "budget": 990,      # ← 改每日预算
    "status": "active", # ← 改 active / paused
    "roas_target": 25,  # ← 改目标 ROAS（1x–35x）
    "strategy": "profitability"
  }'
```

**响应参数**：`id`、`name`、`status`、`budget`（每日预算）、`currency_id`（预算币种，按站点）、`acos_target`（自动 = 1/ROAS×100）、`strategy`、`channel`、`roas_target`、`last_updated`、`date_created`。

---

## 7. 搜索 campaigns

> 注意：请求 `.../product_ads/campaigns` 现在必须以 **`/search`** 结尾，请更新集成。

```bash
curl -X GET -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' \
  'https://api.mercadolibre.com/marketplace/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/campaigns/search'
```

响应含 `paging`（offset/total/limit）+ `results[]`。示例 campaign 字段含 `id`、`name`、`status`、`strategy`、`acos_target`、`roas_target`、`budget`、`automatic_budget` 等。

### 7.1 带指标搜索

可选参数：`limit`、`offset`、`date_from`/`date_to`（YYYY-MM-DD，请求指标时必填）、`metrics`（逗号分隔：clicks, prints, ctr, cost, cpc, acos, roas, sov, cvr, organic_units_quantity, ...direct_amount, indirect_amount, total_amount 等）、`aggregation`（默认 sum）、`aggregation_type`（默认 campaign；加 `&aggregation_type=DAILY` 得每日指标）、`metrics_summary`（默认 false；`&metrics_summary=true` 返回汇总对象）。

筛选：`filters[campaign_ids]`、`filters[campaign_id]`、`filters[status]`（active/paused/deleted）、`filters[channel]`。

> 所有指标端点最多回溯 **90 天**；指标每日 **GMT-3 上午 10:00** 更新；一次只能请求一种 `aggregation_type`。

---

## 8. Campaign 指标

```bash
curl -X GET -H 'api-version: 2' -H 'Authorization: Bearer $ACCESS_TOKEN' \
  'https://api.mercadolibre.com/marketplace/advertising/$ADVERTISER_SITE_ID/product_ads/campaigns/$CAMPAIGN_ID?date_from=...&date_to=...&metrics=...'
```

指标含：clicks, prints, ctr, cost, cpc, acos, roas, sov, cvr, direct/indirect/total_amount, impression_share, top_impression_share, lost_impression_share_by_budget, lost_impression_share_by_ad_rank, acos_benchmark。加 `&aggregation_type=DAILY` 得每日数据。

---

## 9. 按商品搜 Ad Group（Search Ad Groups by items）

新版广告在 campaign 中由新标识 **`ad_group_id`** 识别；增、移、删广告都用它。

**现版**：用 `filters[item_ids]`（复数；单数 `filters[item_id]` 已不再支持）由 item_id 反查 ad_group_id：

```bash
curl -L -g -X GET 'https://api.mercadolibre.com/marketplace/advertising/$SITE/advertisers/$ADV/product_ads/ad_groups/search?filters[item_ids]=$ITEM_ID,$ITEM_ID' \
  -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2'
```

响应：`results[]` 含 `id`（ad_group_id）、`campaign_id`、`ad_group_external_id`、`status`（ACTIVE）、`ad_group_type`、`catalog_listing` 等。

**旧版（截至 2026-06-30）**：`GET .../product_ads/items?item_ids=` 或 `GET .../product_ads/ads/search?filters[item_id]=$ITEM_ID`——旧响应里每条含 `item_id`、`campaign_id`、`ad_group_id`、`price`、`title`、`status`、`catalog_listing`、`family_id` 等（本仓库 ads/search 用的即此类响应）。

## 10. Ad Group 详情

```bash
curl -L -X GET 'https://api.mercadolibre.com/marketplace/advertising/$SITE/product_ads/ad_groups/$AD_GROUP_ID?date_from=...&date_to=...&metrics=CLICKS,PRINTS,COST,CPC,CTR,...&filters[campaign_id]=...'
```

响应字段：`channel`、`catalog_listing`、`ad_group_type`（CATALOG/FAMILY/ITEM）、`ad_group_external_id`、`brand_value_id`、`status`、`metrics` 等。

---

## 11. 广告的增 / 移 / 改（Add, move and update ads）

**单个**：将广告加入 campaign、在 campaign 间移动、或改已在 campaign 中广告的状态：

```bash
curl -X PUT -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  'https://api.mercadolibre.com/marketplace/advertising/$SITE/product_ads/ad_groups/$AD_GROUP_ID' \
  -d '{"status": "active", "campaign_id": 111111111}'
```

（`status` 取值：active / paused）

**批量**（一次多广告，最多 1 万级）：

```bash
curl -X PUT -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  'https://api.mercadolibre.com/marketplace/advertising/$SITE/advertisers/$ADV/product_ads/ad_groups' \
  -d '{"ad_groups": [1237, 1286], "status": "active", "campaign_id": 750898624}'
```

## 12. 从 campaign 删除广告

**单个**：
```bash
curl -X DELETE -H 'Authorization: Bearer $ACCESS_TOKEN' \
  'https://api.mercadolibre.com/marketplace/advertising/$SITE/product_ads/campaigns/$CAMPAIGN_ID/ad_groups/$AD_GROUP_ID'
```

**批量**：
```bash
curl -X DELETE 'https://api.mercadolibre.com/marketplace/advertising/$SITE/product_ads/campaigns/$CAMPAIGN_ID/ad_groups' \
  -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'Content-Type: application/json' \
  -d '{"ad_groups": [1756, 1981]}'
```

---

## 13. 指标端点换代

- **Ads metrics（旧，截至 2026-06-30）**：`.../advertisers/$ADV/product_ads/ads/search?...`——由下方 Ad Group metrics 取代。
- **Ad Group metrics（现版）**：
  - campaign 内全部 ad group 指标：`GET /marketplace/advertising/$SITE/product_ads/campaigns/$CAMPAIGN_ID/ad_groups/metrics?date_from=&date_to=&metrics=...`（单日需 date_to=date_from；多日用 `filters[ad_group_ids]`）
  - 某 ad group 内全部广告指标：`GET /marketplace/advertising/$SITE/product_ads/ad_groups/$AD_GROUP_ID/ads?date_from=&date_to=&metrics=...`
  - 广告主维度全部 ad group：`GET /marketplace/advertising/$SITE/advertisers/$ADV/product_ads/ad_groups/search?...&metrics=CLICKS,PRINTS,...,ROAS&metrics_summary=true`

---

## 14. 词汇表（常用字段）

- `ad_group_id`：广告组标识，campaign 管理流程（增/移/删）都用它
- `ad_group_type`：CATALOG / FAMILY / ITEM
- `ad_group_external_id`：按商品类型的对外标识（Catalog→parent_id、User Product→family_id、传统→item_id）
- `status`：广告状态值含 active / paused / empty（ad group 的所有变体都被移除后）/ deleted（删除后系统保留 90 天，期间仍关联指标）
- `budget`：campaign 月度预算的每日平均，每日 GMT-3 4:00 更新
- `roas_target`：目标 ROAS，≥1x 且 ≤35x
- `acos_target`：目标 ACOS，自动 = (1/ROAS)×100，临时保留可见
- `strategy`：PROFITABILITY / INCREASE / VISIBILITY
- `metrics`：`clicks`（点击）、`prints`（展示）、`ctr`、`cost`（投入）、`cpc`、`acos`（广告销售成本占比）、`tacos`（含自然销售的总广告成本占比）、`roas`、`cvr`（转化率）、`sov`、`direct_amount`（广告直接销售额）、`indirect_amount`（广告助攻销售额）、`total_amount`（direct+indirect）、`units_quantity`、`organic_units_quantity`（自然单量）等；展示类：`impression_share`、`top_impression_share`、`lost_impression_share_by_budget`（预算不够导致未展示占比）、`lost_impression_share_by_ad_rank`、`acos_benchmark`

---

## 附：与本项目相关的三条要点（译注）

1. **广告「写」（投放/暂停/改预算/改 ROAS 目标）官方文档明确支持**，入口是 campaign（创建/修改）与 ad_group（暂停/激活/增删）两组端点，请求头 `api-version: 2`；查 advertiser 用 `Api-Version: 1`。
2. **本项目 BA05 / AW04 2026-09-04 实测**：读全通（campaigns/search 200、ads/search 200、advertiser 200），但**写全部 401** `User does not have permission to write.`（错误类 `mclics.campaigns.exceptions.UnauthorizedException`）——被拦在 mclics 广告业务系统授权层；对照实验证明 token 有 write scope（改假商品返回 404），问题不在 token，而在 app 的 **Advertising 功能模块授权** 或账户的 API 写开通（官方无自助入口时需联系商业顾问）。
3. **「出价 CPC」不由卖家直接设置**——Product Ads 为按目标 ROAS/ACOS + 转化历史自动计算的出价系统（官方 learning-center 说明：从卖家设定的目标 ACOS 推导最大 CPC，按第二价格扣费）。可改的只有 ROAS 目标 + 预算。
