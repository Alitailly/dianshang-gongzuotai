# 蓝鲸BI 真实数据设计参考（抓包整理）

> 来源：通过浏览器 MCP 实际登录 https://bykj.lingdongsz.com/uranus/#/ 逐页抓取。
> 用途：作为我们自建看板的数据设计蓝本。本文档字段名沿用蓝鲸原始命名。

## 1. 技术栈与登录

- 前端：Vue 2 + Element UI + ECharts + Vue Router（hash 路由）+ axios。
- 后端：`https://bykj.lingdongsz.com/app/*`，**全部 POST**，JSON body。
- 登录流程：`#/login`（账号+密码+同意协议）→ 平台选择页（进入美客多 / 进入亚马逊）→ `#/index`。
- 平台标识：`platform = "mei"`（美客多）｜亚马逊另用。

## 2. 请求/响应约定（通用）

### 请求 body 通用字段（POST JSON）
```json
{
  "platform": "mei",                    // 平台
  "user_id": "29",                      // 蓝鲸用户 id
  "site_id": "MLB",                     // 站点
  "seller_id": "",
  "seller_id_array": [],
  "market_user_id_array": ["卖家id示例1", "卖家id示例2"],  // 店铺的 ML 卖家 id，示例占位，不要填写真实编号
  "market_user_id": "",
  "start_date": "2026-08-14",           // 日期范围
  "end_date": "2026-08-14",
  "currency_id": "BRL",
  "logid": "010301202608141107120001",  // 请求流水号
  "sign": "80d194b5..."                 // MD5 签名（防篡改）
}
```

### 响应约定
```json
{ "msg": "成功", "code": 0, "logid": "...", "...业务数据..." }
```
- 列表接口：`{ msg, code, total, list: [...] }`（total=总数，list=当前页）。
- 汇总接口：`{ msg, code, data: {...} }`。
- 字段命名：**snake_case**；时间窗字段用 `day{N}_xxx` 前缀。

## 3. 菜单结构（左侧 menubar + 路由）

| 菜单 | 路由 | 备注 |
|---|---|---|
| 经营总览 | #/index | |
| 商品分析 | #/listing | |
| 交易分析 | （子菜单） | |
| 竞争力分析 | #/listingAnalysis | |
| 订单管理 | #/orderList | |
| 退货管理 | #/returnManage | |
| 库存管理 | #/stock | |
| FULL仓费用 | #/storage | |
| Listing优化 | （子菜单） | |
| 竞品监控 | #/competeTrack | |
| 经营决策 | （子菜单） | 利润/广告流量可能在此 |
| 售前消息 | （子菜单） | |
| 售后消息 | （子菜单） | 徽标数字=待处理数 |
| 投诉管理 | （子菜单） | |
| 客服机器人 | #/autoReply | |
| DOTD | #/dotdSeckill | 徽标=数量 |
| 评价管理 | #/reviews | |
| 店铺声誉 | #/storeReputation | |
| 个人中心 | （子菜单） | |
| 配置 | （子菜单） | 店铺管理/成本/汇率等 |

顶部栏：店铺筛选（全店铺/Brasil）、切换旧版、币种（巴西雷亚尔 BRL）、版本记录、视频教程、用户菜单。

## 4. 经营总览（#/index）

日期范围：今天/昨天/近7天/近30天/近60天/自定义。

### KPI 卡片
- 总销售额（BRL）— 环比 — 昨日销售额
- 总销量（件）— 环比 — 昨日销售量
- 退款数量（件）— 环比 — 昨日退款数量
- 访问量（次）— 环比
- 昨日动销率（%）— 昨日有售 listing — 昨日在售 listing

### 店铺表现（tab：店铺表现）
- 卡片：订单 / 访问量（次）/ 转化率（%）
- 表：序号 | 店铺名 | 销售额(BRL) | 订单数 | 访问量 | 转化率

### 库存信息
- 指标：近30天周转天数 / 近90天周转天数 / 急需补货商品 / 在售库存数量
- 表：急需补货商品(SKU) | 可售天数 | 补货数量

### 预警信息
- 差评预警 / PDD预警 / 店铺声誉预警 / listing配额预警（各显示数量）

### 消息通知
- 售后消息 / 售前消息 / 待卖家处理 / 调解中待处理（各显示数量）
- 列表：商品标题 + 订单编号 + 类型（售后）

### 排行榜（tab）
- 昨日销量暴涨榜 / 昨日销量暴跌榜 / 昨日退货骤增榜 / 前3天访问暴跌榜 / 近3天滞销商品榜
- 表头：排名 | 图片 | 商品标题 | 商品ID/SKU | 展出类型 | 昨日/近7天销量 | 销量趋势 | 昨日订单金额 | 昨日访问量 | 增幅比 | 操作

### 经营总览接口
```
POST /app/home_v2/authority          POST /app/home_v2/goodsSummary
POST /app/home_v2/stockSummary       POST /app/home_v2/urgentStocks
POST /app/home_v2/warningInformationCount / warningInformationList
POST /app/home_v2/messageBriefCount  / messageBrief
POST /app/home_v2/storeList          POST /app/home_v2/storeSummary
POST /app/home_v2/storeOrderHourTrend
POST /app/home_v2/top/salesUp        POST /app/home_v2/visitSummary
POST /app/immediate/summary
```
- `goodsSummary` 响应：`goodsMap: { goodsListing(在售listing), salesListing(有售listing), turnover_rate(动销率) }`
- 通用接口：`POST /app/module/tree`（菜单）、`/app/site/currencyList`、`/app/time/mexico`（平台时间）、`/app/developer/authList`、`/app/announcement/announcementDetail`（版本通告）。

## 5. 商品分析（#/listing）★ 核心

### 状态 Tab（筛选）
`Active` / `Paused` / `Under_review` / `Inactive` / `Closed`

### 接口
```
POST /app/listing/overview   # 顶部统计
POST /app/listing/find       # 商品列表（分页/筛选/搜索/排序）
```

### `listing/overview` 响应字段
`number`(总商品数) `high_pdd` `warning_pdd` `listing_num` `low_shopping_num`(购物体验分低数量) `claims_num`(投诉数)

### `listing/find` 请求字段
`user_id platform site_id shop_id seller_id_array market_user_id_array market_user_id currency_id type(0) keyword_sku keyword_mcd_id keyword_titlezn page rows(50) is_specs("no") status("active") sort logistic_type logid sign`

### `listing/find` 响应 list 元素字段（★ 完整商品数据模型）
| 字段 | 含义 |
|---|---|
| market_user_id / shop_id / shop_name | 店铺（ML卖家id / 店铺名） |
| mcd_id | 商品 ML id（如 MLB4352269743） |
| listing_cmd_id | catalog listing id |
| catalog_product_id | catalog 产品 id |
| sku | seller_sku |
| titlecn | 标题（原文/葡语） |
| titlezn | 标题（中文） |
| logo | 主图 URL |
| link | 商品链接（produto.mercadolivre.com.br） |
| platform / platform_name | mei / 美客多 |
| site_id / site_name | MLB / Brasil |
| status_tx | 状态文本（active 等） |
| listing_type_id | 展出类型（Premium / Classic） |
| logistic_type | 物流类型（FULL=官方仓等） |
| free_shipping | 是否包邮（"true"/"false"） |
| catalog_listing | 是否 catalog listing |
| specs | 变体数（0/1） |
| is_listing / is_gf_url | 标记 |
| price | 当前售价 |
| original_price / org_price_local | 原价（本币） |
| discount_price | 折扣价（本币） |
| org_price_usd / discount_price_usd | 原价/折扣价（USD） |
| currency_id | 币种（BRL） |
| quantity / online_num | 可用库存（在售数量） |
| count | 数量（累计） |
| exp_score | 购物体验分（0–100，对应 Listing 质量） |
| rating_average | 商品评分（如 "4.4"） |
| create_date / date_created | 创建时间 |
| day3/7/15/30_visist_num | 近3/7/15/30天访问量（注意原字段拼写 visist） |
| day3/7/15/30_sales_num | 近3/7/15/30天销量 |
| day60_order_num | 近60天订单数 |
| day60_sales_num | 近60天销量 |
| day60_cr_num | 近60天投诉问题数 |
| day60_cr_rate | CR率（"9.09%"） |
| day60_mediation_num / day60_mediation | 近60天调解数 |

### 表格列（前端展示顺序）
购物体验分 | 商品评分 | 库存类型 | 店铺 | 折扣价(BRL) | 原价(BRL) | 可用库存 | 近3/7/15/30天访问量 | 近3/7/15/30天销量 | 近60天投诉问题数 | CR率 | 创建时间 | 图片 | 商品信息 | 展出类型 | 分析

## 6. 店铺
- 卖家编号和店铺名称只保存在本机的 `stores.d/*.env`，不要写进文档或提交到仓库。

## 7. 完整菜单 + 路由表

| 一级 | 二级 | 路由 |
|---|---|---|
| 经营总览 | | #/index |
| 商品分析 | | #/listing |
| 交易分析 | 即时分析 | #/tradeAnalyze/realtimeAnalyze |
| | 历史分析 | #/tradeAnalyze/productAnalyze |
| | 广告流量 | #/tradeAnalyze/advertise |
| | 利润分析 | #/tradeAnalyze/historyAnalyze |
| 竞争力分析 | | #/listingAnalysis |
| 订单管理 | | #/orderList |
| 退货管理 | | #/returnManage |
| 库存管理 | | #/stock |
| FULL仓费用 | | #/storage |
| Listing优化 | 类目预测 | #/competeAnalyze/categoryAnalyze |
| | 选词助手 | #/competeAnalyze/selectWord/id |
| 竞品监控 | | #/competeTrack |
| 经营决策 | 店铺报表 | #/dataReport/shopReport |
| | 商品报表 | #/dataReport/productReport |
| 售前消息 | 待回复消息 / 模板 / 历史 | #/inquiryMessage/... |
| 售后消息 | 待回复 / 订单自动消息 / 模板 | #/afterMessage/... |
| 投诉管理 | 投诉消息 / 模板 | #/complaintManage/... |
| 客服机器人 | | #/autoReply |
| DOTD | | #/dotdSeckill |
| 评价管理 | | #/reviews |
| 店铺声誉 | | #/storeReputation |
| 个人中心 | 会员 / 视频 / 下载中心 | #/userCenter/... |
| 配置 | 成本管理 / 黑名单 / 微信授权 / 固定汇率 | #/configuration/... |

## 8. 广告流量（#/tradeAnalyze/advertise）

接口：`POST /app/flow/advert/summary`（KPI）、`/app/flow/advert/trends`（趋势）、`/app/flow/advert/padsList`（商品广告列表）。

### summary 字段（广告 KPI）
`amount`(销售额) `advert`(广告花费) `advertTax`(广告税) `impressions`(曝光) `click_num`(点击) `order_num`(订单数)
`roas`(8.73) `acos`(11.46) `acoas`(5.96) `cpc`(1.83) `cpc_click_rate`(0.24)
`natural_sales_num`(自然销量) `natural_sales_amount`(自然销售额) `natural_sales_amount_rate`(自然销售额占比)
`advert_slew_ratio`(广告占比) `advert_slew_rate`
所有 `up_*` 前缀 = 环比（如 up_advert、up_roas_rate、up_acos、up_cpc）。

### padsList 请求
`type time site_id market_user_id_array mcd_id item_id start_date end_date currency_id adtype(1) category_id keyword_sku/mcd_id/titlezn sort("impressions desc") page rows is_specs`

## 9. 利润分析（#/tradeAnalyze/historyAnalyze）

接口：`POST /app/summary/sales/overview2`（KPI）、`/app/summary/sales/report2`（明细表）、`/app/summary/sales/form?mcdID=`（单品）。

### overview2 字段（利润模型）
`sale_amount`(销售额) `sale_number`(销量) `effective_sales`(有效销售额) `effective_num`(有效销量)
`gross_profit`(毛利润) `net_interest`(净利润) `net_interest_rate`(净利率) `roi`/`roi_ratio`
`commission`(平台佣金 9.70%) `commission_rate`(佣金率) `advert_fee`(广告费) `advert_tax_fee`(广告税)
`purchasing_cost`/`total_purchasing_cost`(采购成本) `freight_cost`(头程物流) `shipping_fee`(配送费) `custom_cost`(其他成本)
`refund_fee`(退款金额) `refund_number`(退款数量) `shop_fee`(店铺费) `seller_coupon`(卖家券) `iva_taxes`(IVA税)
全部带 `up_*` 环比字段。

### 利润表头
店铺 | 商品状态 | 销售(BRL) | 利润(BRL) | 平台费用(BRL) | 采购成本(BRL) | 头程物流(BRL) | 其他成本(BRL) | 商品信息

> 利润公式 = 销售 − 平台佣金 − 广告费 − 采购成本 − 头程物流 − 配送费 − 其他成本 − 退款 − 税。
> 其中「采购成本/头程物流/其他成本」为人工录入（配置→成本管理），其余来自 ML API。

## 10. 订单管理（#/orderList）

接口：`POST /app/orders/query/list`（列表）、`/app/orders/query/stat`（统计）。

### 请求字段
`filter("all") order_id search_text order_status[] ship_status[] logistic_type[] from_date/to_date("2026-08-14 00:00:00") order_by("o2.date_created_mxn desc") page_num page_size date_type("date_created")`

### stat 字段
`sales_num_sum`(销量) `real_sales_num_sum`(实际销量) `sales_amount_sum`(销售金额) `settlement_amount_sum`(结算金额) `ship_amount_sum`(发货金额) `plat_fee_sum`(平台费)

### 表头
收件人 | 订单状态 | 取消原因 | 物流状态 | 配送方式 | 销售单价(BRL) | 销售数量 | 实际发货数量 | 结算金额(BRL) | 收支明细(BRL) | 订单日期 | 订单编号 | 商品信息

## 11. 库存管理（#/stock）

表头：库存趋势 | 商品名称 | 商品ID/SKU | ML code | 商品规格 | 商品尺寸 | 店铺名称 | 商品状态 | 库存类型 |
日均销量(手动) | 日均销量 | 近7/15/30/60天销量 | 可售天数 | 7月结余库存 | 本月结余库存 | 总库存 | 在库金额(RMB) |
可用库存 | 不可用库存 | 转移中库存 | 当前在途库存 | 在途库存金额(RMB) | 自定义库存 | 促销预留 |
补货周期(天) | 安全库存系数 | 预警天数 | 补货建议 | 补货数量 | 备注信息 | 图片 | 操作

> 「日均销量(手动)/补货周期/安全库存系数/自定义库存/在库金额」为人工配置；其余（可用库存、销量）来自 ML API。

## 12. 与 ML API 的对应关系（关键结论）

| 蓝鲸数据 | 来源 |
|---|---|
| 商品信息（mcd_id/sku/title/price/原价/折扣价/库存/图片/链接/状态/展出类型） | ML `GET /items/{id}` + `GET /users/{id}/items/search` |
| 各时间窗访问量（day3/7/15/30_visist_num） | ML `GET /items/{id}/visits/time_window` + 本地每日快照累计 |
| 各时间窗销量/订单（dayN_sales_num、day60_order_num） | ML `GET /orders/search` 聚合 + 本地快照 |
| 购物体验分 exp_score | ML `GET /item/{id}/performance`（score） |
| 商品评分 rating_average | ML `GET /reviews/search` 聚合（或 item 公开评分） |
| 广告指标（roas/acos/acoas/cpc/曝光/点击/花费） | ML 广告 API（product_ads metrics: clicks/prints/ctr/cost/roas） |
| 平台佣金 commission | ML 类目费率 / `sale_terms` |
| 订单明细 | ML `GET /orders/search` + `GET /orders/{id}` |
| 物流状态/配送方式 | ML `GET /shipments/{id}` |
| 评价 | ML `GET /reviews/search` |
| 店铺声誉 | ML `GET /users/{id}` → seller_reputation |
| 采购成本/头程物流/其他成本/汇率/补货参数 | **人工录入**（配置模块） |
| 历史趋势 | **本地每日快照**（ML 不给历史） |
