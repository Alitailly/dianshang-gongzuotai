# Mercado Libre（美客多）广告 API 写能力调研

- 调研日期：2026-09-04
- 调研人：研究代理（纯桌面研究 + API 网关无鉴权行为实测；未使用真实卖家 token 做任何写操作）
- **一句话结论**：ML 官方**存在**一版「可写」的 Product Ads API——官方文档称为 *Product Ads for Catalog and User Products*（2025 起的新一代 ad-group 流程），明确支持创建 campaign、暂停/激活、改预算、设 ROAS 目标，但**旧版（legacy）Product Ads 端点自 2022-02-08 起禁写，至今仍禁写**（本仓库卖家用 `POST /advertising/product_ads/ads/{item}/pause|activate` 实测 401 `User does not have permission to write.` 即属此类）；卖家需迁移到新端点并满足账户资质才能写。

---

## 一、核心结论（逐项）

口径：**文档支持** = 官方第一手文档明确给出可写端点/请求体；**卖家实测** = 2026-09-04 真实 token 行为（任务背景给出）；**未证实** = 公开渠道无法确证（需卖家自己用 token 对新端点实测）。

| 能力 | 结论 | 说明 |
|---|---|---|
| 创建 campaign | **官方文档：支持**。对新端点仍未用真实 token 实测 → 对本项目卖家**未证实** | `POST /marketplace/advertising/{SITE}/advertisers/{ADV}/product_ads/campaigns`（请求头 `api-version: 2`），body：`name, status, budget, strategy, channel, roas_target` |
| 暂停/激活 campaign | 文档支持（改 `status: paused/active`） | 同 PUT campaign（见下） |
| 暂停/激活 单个广告 | 文档支持（改 ad-group status） | `PUT /marketplace/advertising/{SITE}/product_ads/ad_groups/{ad_group_id}`，body `{"status":"paused"/"active","campaign_id":...}` |
| 旧版暂停/激活端点 | **卖家实测：拒绝（401 "User does not have permission to write."）** | `POST /advertising/product_ads/ads/{item}/pause`、`/activate` —— 这是 2022 之前的旧一代路径，禁写仍有效 |
| 修改每日预算 budget | **官方文档：支持** | 合并进 `PUT /marketplace/advertising/{SITE}/product_ads/campaigns/{campaign_id}`，body `{"budget": N, ...}`；无独立 budget 子端点 |
| 修改出价 bid/CPC | **不支持直接改**（产品设计如此） | Product Ads 出价为算法自动：由目标 ROAS/ACOS + 转化历史自动算出最大 CPC（官方「bidding system」说明）。可写的只有 ROAS 目标 + 预算 |
| 设置 ROAS/ACOS 目标 | **官方文档：支持** | 2025-12 起 `acos_target` 字段被 `roas_target` 取代（范围 1x–35x）；`acos_target` 仍返回，自动 `ACOS=(1/ROAS)×100` |
| 账户余额为 0 时创建 campaign | 任务背景：会业务报错 —— 说明创建接口本身可达（与「写被平台层禁掉」不一致，暗示新端点可写） | 未经公开渠道复核，标**未证实** |
| 「广告写 = 平台层全局拒绝，与 scope 无关」 | 该结论对**旧版端点**成立；对**新版端点**不成立（官方文档有完整写流程） | 详见证据 |

> 关键推论：卖家实测拒写的那组路径（`/advertising/product_ads/ads/{item}/pause|activate`）既不在官方当前支持的端点列表里，也不在「仅文档内端点受支持」的范围内。官方明确说 *"Only the endpoints published in the Product Ads documentation are supported."* → 业务上应改用新端点（campaign / ad_group），而不是把 401 理解为「ML 全平台不允许广告写」。

---

## 二、证据与来源

### 2.1 第一手官方文档（最重要）

**A. 「Product Ads for Catalog and User Products」官方 API 文档**
- URL（Global Selling 开发者站，西班牙语 slug / 英文镜像）：
  - `https://global-selling.mercadolibre.com/devsite/new-product-ads`
  - `https://global-selling.mercadolibre.com/devsite/en_us/new-product-ads`
  - 页面 `<title>` = "Product Ads"；正文大标题 = "Product Ads for Catalog and User Products"；页脚 `Last update 03/07/2026`，`Copyright © 2026 MercadoLibre S.R.L.`（官方第一手）。
- 原文关键句（逐字摘录）：

  1. 下线公告：
     > "following the transition period that ended in September 2025, the legacy Product Ads endpoints listed below will be **permanently deprecated on May 27, 2026**. As of that date, calls to these resources will return an error (404 Not Found). If your application still uses any of these endpoints, immediately adapt your development to avoid service interruptions. **Only the endpoints published in the Product Ads documentation are supported.**"
  2. 被停用（legacy）端点清单：
     - `GET /marketplace/advertising/product_ads/campaigns/$CAMPAIGN_ID/ads/metrics`
     - `GET /marketplace/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/ads/search` ← **注意：这正是本仓库卖家正在使用的读端点**
     - `GET /marketplace/advertising/$ADVERTISER_SITE_ID/product_ads/ads/$ITEM_ID`
     - `PUT /marketplace/advertising/$ADVERTISER_SITE_ID/product_ads/ads/$ITEM_ID`
     - `PUT /marketplace/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/ads`
  3. 新分组模型：
     > "Product Ads currently supports three grouping types: **CATALOG** — items published via Catalog. The `ad_group_external_id` maps to the `parent_id`; **FAMILY** — items published via User Products. ... maps to the `family_id`; **ITEM** — traditional individual items. ... maps to the `item_id`"
  4. 账户资质（Check advertiser 一节）：
     > "To use Product Ads, a user must: Have a yellow reputation or higher. Have been registered on Mercado Libre for at least 15 days. Have a minimum number of sales on Mercado Libre (1 for companies, 10 for individuals). Have no overdue invoices on Mercado Libre."
  5. Product Ads 未开通错误码：
     > "If you receive error **404 - No permissions found for user_id**, the user does not have Product Ads enabled. The user must access Mercado Libre > My profile > Advertising to activate Product Ads."
  6. ROAS/ACOS 字段迁移：
     > "As of **December 2025**, the `acos_target` field was replaced by `roas_target`. The system now uses the Target ROAS (return on investment) as the standard metric for creating and updating campaigns." … "The `acos_target` field will remain temporarily visible as an optional metric. It is calculated automatically based on the ROAS sent using the following formula: **ACOS = (1/ROAS) × 100**."

- 文档给出的可写端点与请求体（curl 原样）：

  **Create campaign**（官方可写证据）：
  ```
  POST https://api.mercadolibre.com/marketplace/advertising/$ADVERTISER_SITE_ID/advertisers/$ADVERTISER_ID/product_ads/campaigns
  -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' -H 'Content-Type: application/json'
  -d '{ "name": "Main Campaign", "status": "active", "budget": 950,
        "strategy": "profitability", "channel": "marketplace", "roas_target": 19 }'
  ```

  **Modify campaign（改预算/暂停/ROAS 目标，官方可写证据）**：
  ```
  PUT https://api.mercadolibre.com/marketplace/advertising/$ADVERTISER_SITE_ID/product_ads/campaigns/$CAMPAIGN_ID
  -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'api-version: 2' -H 'Content-Type: application/json'
  -d '{ "name": "Main Campaign", "budget": 990, "status": "active", "roas_target": 25, "strategy": "profitability" }'
  ```
  参数说明原文：`status`（active 或 paused）、`budget`（平均每日预算，最多可透支原估算 2 倍、用前几日余额）、`strategy`（profitability/increase/visibility）、`roas_target`（≥1x 且 ≤35x）。

  **广告暂停/激活（官方可写证据）**：`PUT /marketplace/advertising/$SITE/product_ads/ad_groups/$AD_GROUP_ID`，body `{"status": "paused"|"active", "campaign_id": ...}`；支持批量 `PUT /marketplace/advertising/$SITE/advertisers/$ADV/product_ads/ad_groups`。
  **从 campaign 删除广告**：`DELETE /marketplace/advertising/$SITE/product_ads/campaigns/$CAMPAIGN_ID/ad_groups/$AD_GROUP_ID`。
  **item → ad_group 映射**：`GET /marketplace/advertising/$SITE/advertisers/$ADV/product_ads/ad_groups/search?filters[item_ids]=...`。

  **Check advertiser**（注意这里才是 `Api-Version: 1`）：
  ```
  GET https://api.mercadolibre.com/advertising/advertisers?product_id=PADS
  -H 'Authorization: Bearer $ACCESS_TOKEN' -H 'Api-Version: 1'
  ```
  `product_id` 可选值：PADS（Product Ads）、DISPLAY、BADS（Brand Ads）。

**B. 「What is Mercado Ads?」页（Global Selling）**
- URL：`https://global-selling.mercadolibre.com/devsite/mercado-ads`（`Last update 12/12/2025`）
- 原文：> "**This feature is available only in Brazil, Mexico and Chile.**" …… "all your products become sponsored listings. You will automatically see a **daily recommended budget**."（指面向 Global Selling 卖家的自动式 Mercado Ads；可调整推荐预算。）

**C. Display Ads 页（Global Selling）**
- URL：`https://global-selling.mercadolibre.com/devsite/display-gs`（`Last update 13/02/2026`）
- 原文：> "Display is a service enabled by **Commercial Advisors** from Mercado Libre." …… "If you receive the error 404 - No permissions found for user_id, it means that the user has not enabled the product and should **contact their Commercial Advisor** to manage access to their advertisers."
- 文档只展示读操作（advertisers / campaigns / metrics / line items），未给 create/pause/budget 写端点；`Api-Version: 1`。

**D. 应用创建与权限页（Global Selling）**
- URL：`https://global-selling.mercadolibre.com/devsite/create-application`（`Last update 02/06/2026`）
- 原文（权限模块清单，含广告）：> "**Advertising** — This is a permission that allows your application to **access, create and manage advertising campaigns**. Allows access to Advertising resources."
- 同页说明 OAuth 只分两种：`Read only`（GET）/ `Read and write`（PUT/POST/DELETE）。
- 另见 `https://global-selling.mercadolibre.com/devsite/application-manager-gs`：应用/授权返回的 `scopes` 只有 `["write","read","offline_access"]` —— 印证：**OAuth 层面没有 `advertising/product_ads` 这类 scope**；广告写权限是「应用功能模块(Advertising) + 卖家广告账户资质」共同决定，与 scope 字符串无关（与任务背景的对照实验一致）。

**E. 卖家侧学习中心（官方，Global Selling）**
- `https://global-selling.mercadolibre.com/learning-center/news/how-to-create-advertising-campaigns-in-product-ads`：卖家 UI 里选 **"Custom" 管理模式**才能建多个 Product Ads campaign；流程含「设每日预算 + ACOS Target」。
- `https://global-selling.mercadolibre.com/learning-center/news/how-the-product-ads-bidding-system-works`：> "Each seller defines a target ACOS for their campaign. From that ACOS, Product Ads calculates the **maximum CPC** ... the winning sellers pay only the minimum necessary to beat their closest competitor."（证明「出价」不由卖家直接设，由目标 ACOS/ROAS 推导最大 CPC，且按第二价格付费。）

### 2.2 API 网关行为实测（无鉴权，第一手行为证据，2026-09-02 执行）

对 `https://api.mercadolibre.com` 无 token 探测，区分「路由存在」与「路由不存在」：

| 探测 | 结果 | 解读 |
|---|---|---|
| `GET /advertising/advertisers?product_id=PADS` | 403 `PA_UNAUTHORIZED_RESULT_FROM_POLICIES` (PolicyAgent) | 路由存在，策略网关拦截 |
| `POST /marketplace/advertising/MLB/advertisers/694824/product_ads/campaigns`（新建） | 401 `Not granted` | 新创建端点路由存在，仅需鉴权 |
| `PUT /marketplace/advertising/MLB/product_ads/campaigns/123`（改预算） | 401 `Not granted` | 路由存在 |
| `PUT /marketplace/advertising/MLB/product_ads/ad_groups/123`（暂停/激活广告） | 403 PolicyAgent | 路由存在 |
| `DELETE /marketplace/advertising/MLB/product_ads/campaigns/123/ad_groups/456` | 403 PolicyAgent | 路由存在 |
| `GET /marketplace/advertising/MLB/advertisers/694824/product_ads/campaigns/search` | 403 PolicyAgent | 路由存在 |
| `GET /marketplace/advertising/MLB/advertisers/694824/product_ads/ads/search`（卖家在用） | 403 PolicyAgent | **即使官方公告称 2026-05-27 后停用，路由仍在**（与卖家 2026-09-04 实测 200 一致） |
| `GET /marketplace/advertising/product_ads/campaigns/123/ads/metrics`（下线清单 #1） | 403 PolicyAgent | 路由仍在，未实际移除 |
| `GET /marketplace/advertising/MLB/product_ads/ads/MLB123`（下线清单 #3） | 403 PolicyAgent | 路由仍在 |
| `PUT /marketplace/advertising/MLB/product_ads/ads/MLB123`（下线清单 #4） | 503（空 body） | 遗留写路由已不可用 |
| `PUT /marketplace/advertising/MLB/advertisers/1/product_ads/ads`（下线清单 #5） | 503（空 body） | 遗留写路由已不可用 |
| `POST /advertising/product_ads/ads/MLB1/pause`、`/activate`（卖家测的路径） | 403 PolicyAgent | 旧写路由仍在策略网关后被拒 |
| `POST /advertising/product_ads/campaigns`、`POST /advertising/product_ads/campaigns/1/budget`、`/pause` | 401 `Not granted` | 旧根路径的写路由仍注册 |
| `GET /nonexistent_resource_xyz`（对照） | 404 `resource not found` | 确认 404=路由不存在，403/401=路由存在 |

结论：**网关层面没有任何一条「已下线」端点到 404**——官方「2026-05-27 永久停用」的公告在实际路由上尚未执行/未全面执行（尤其是读端点）；写端点在旧路径上表现为 403 PolicyAgent / 503，即平台级禁写只作用于旧一代资源。

### 2.3 第三方来源

- **Macarta（墨西哥，2022-02 报道）**：`https://www.macarta.mx/mercado-libre-anuncia-ajustes-en-api-de-product-ads`
  - 检索索引摘录：> "Mercado Libre anunció que a partir del **8 de febrero del 2022** no se puede realizar ningún tipo de cambio en Product Ads a través de su API."（2022-02-08 起无法再通过 API 对 Product Ads 做任何更改。）
  - 页面本身有 Cloudflare 防护无法整页抓取，引用为搜索索引中的原文片段（第三方，单源）。
- **dltHub Mercado Ads context（2026-08-26 更新）**：`https://dlthub.com/context/source/mercado-ads`
  - 抓到的页面只列**读**资源：`advertising/advertisers/{adv}/product_ads/campaigns/search`、`.../ads/search`、`.../items`、`brand_ads/campaigns`、`display/campaigns`（均 GET），未记录任何写端点。
  - 提示 `Api-Version` 头、错误码处理：> "404 or 403 'No permissions found for user_id' indicates Product Ads not enabled ... Enable Product Ads in Mercado Libre account (**Listings management > Advertising campaign**)"。
  - 搜索索引的缓存版本还出现另一批路径（`/marketplace/advertising/{site_id}/advertisers/{adv}/product_ads/campaigns/search`）及「legacy `/marketplace/advertising/product_ads/campaigns/{id}/ads/metrics` deprecated, returns 404 after 2026-02-26」——与其落地页当前内容不一致，仅作参考，标第三方/间接。
  - 注意：dltHub 文案说需配置 "advertising/Product Ads (advertising/product_ads) scope"，与官方 OAuth scopes（仅 read/write/offline_access）不符，疑为 dltHub 概括错误——不应作为 scope 依据。
- **ROAS 替代 ACOS 的行业报道（2025）**：`https://algoritmodigital.com.ar/fin-del-acos-en-mercado-libre-2025-optimizacion-por-roas`；`https://gobots.ai/es/blog/roas-vs-acos-cual-es-la-metrica-correcta-para-la-rentabilidad-en-mercado-ads`（均第三方，佐证官方文档里 ROAS 迁移）。

### 2.4 未证实/待复核的来源

- 任务背景提到「有人声称旧版 2026-05-27 下线、新版请求头必须 `Api-Version: 1`、且支持创建 campaign/改预算」。
  - 「旧版 2026-05-27 下线」「新版支持创建/改预算」→ 与官方文档**方向一致**（见 2.1-A）。
  - 「新版请求头必须 `Api-Version: 1`」→ **与官方文档不符**。官方 curl 示例：`/advertising/advertisers` 用 `Api-Version: 1`；而 marketplace 下的 campaign/ad-group 端点都用 **`api-version: 2`**（HTTP 头大小写不敏感，但值不同）。

---

## 三、「Product Ads for Catalog and User Products」调查

- **真实存在。** 官方（Global Selling 开发者站）文档页 URL：`https://global-selling.mercadolibre.com/devsite/new-product-ads`（英文镜像 `/devsite/en_us/new-product-ads`），页脚更新于 2026-07-03。
- **文档位置**：不在 `developers.mercadolibre.com.ar` 主站普通导航里（主站该路径 `.../es_ar/api-docs/es/advertising/product-ads/...` 旧链接已 404）；而是挂在 ML 官方 Global Selling（CBT/跨境）开发者站 `global-selling.mercadolibre.com/devsite/` 下，归入导航「Mercado Ads > Product Ads」。与项目「MLB 跨境 Global Selling」场景直接对应。
- **写能力**：有。官方文档给出 create/modify campaign（含 budget、status、roas_target、strategy）、ad-group 的 add/move/update（含 status=paused/active）、delete 广告的完整 curl。
- **路径与版本头**：
  - advertiser 查询：`GET /advertising/advertisers?product_id=PADS` → 头 `Api-Version: 1`
  - campaign 写/读：`/marketplace/advertising/{SITE}/advertisers/{ADV}/product_ads/campaigns`（POST 建）、`.../campaigns/{id}`（PUT 改）、`.../campaigns/search`（GET 搜）→ 头 `api-version: 2`
  - ad-group 写/读：`/marketplace/advertising/{SITE}/product_ads/ad_groups/{id}`（PUT/DELETE）、`.../ad_groups/search?filters[item_ids]=...`（GET）→ 头 `api-version: 2`
- **上线/下线时间**：文档描述「transition ended in September 2025」，legacy marketplace 端点 **2026-05-27 起永久停用**；页内另有两处次生下线：ads metrics 旧搜（`.../ads/search?...metrics=...`）与「按 item_id 查 ad group 的旧方式」**至 2026-06-30** 移除。**日期口径混乱**，且实测路由未真正 404 → 下线公告与执行不一致。
- **「旧版 2026-05-27 下线」的说法**：半真。被点名的旧端点是 `/marketplace/advertising/...` 一代；而卖家在用的 `.../product_ads/ads/search` 恰好在名单里，但 2026-09-04 实测仍 200。官方与实测矛盾，无法从公开渠道定论原因。

---

## 四、权限授予路径（怎么写才能过）

广告**写**权限 = 三层叠加（按官方文档 + 实测推断，未逐层实测）：

1. **App 层（应用功能模块）**：创建/配置应用时必须勾选 **Advertising** 权限。官方原文：> "Advertising — This is a permission that allows your application to access, create and manage advertising campaigns."（`/devsite/create-application`）
   - 注意 OAuth scopes 只有 read/write/offline_access，**没有** `advertising/product_ads` scope；token 的通用 write 不代表广告资源放行（与卖家对照实验吻合）。
2. **卖家账户/广告主层**：
   - 账户须开通 Product Ads（官方：Mercado Libre > My profile > **Advertising** 激活；dltHub 提示路径：Listings management > Advertising campaign）。未开通会报 404 `No permissions found for user_id`（注意：与卖家遇到的 401 "User does not have permission to write." 是不同报错）。
   - 资质门槛：信誉黄牌及以上、注册 ≥15 天、最低销量（公司 1 单/个人 10 单）、无逾期账单。
   - 有合法 `advertiser_id`（`GET /advertising/advertisers?product_id=PADS` 查询）。
3. **端点代际层**：必须用当前受支持的新一代端点（campaign + ad_group），旧一代（`/advertising/product_ads/ads/{item}/pause|activate` 等）平台层禁写。
4. 其它广告产品：Display Ads 需 ML **Commercial Advisor** 开通；Brand Ads（BADS）同走 `advertising/advertisers` 查询。

---

## 五、市场差异（现有证据内）

| 产品 | 证据 | 市场 |
|---|---|---|
| 自动式 Mercado Ads for Global Selling（Fully Managed 式，推荐预算自动投放） | `/devsite/mercado-ads`：> "This feature is available only in Brazil, Mexico and Chile." | **MLB、MLM、MLC** |
| Product Ads 自助 campaign API（含写） | 官方示例含 MLB/MLM/MLC 广告主；campaign metrics 示例为 ARS → 亦有 MLA 广告主 | MLB/MLM/MLC（示例）+ MLA（ARS）等，站点以 `site_id` 参数区分，未见仅限某国 |
| Display Ads | `/devsite/display-gs` 示例 advertiser 含 MLB/MLM/MLA/MLC；需 Commercial Advisor 开通 | 多国 |
| 卖家端可用性 | 说明文档 `Mercado Ads for Global Selling` 可用性为 Brazil/Mexico/Chile | MLB/MLM/MLC |

> 说明：以上是「官方文档表述」层面的市场差异；MLA 等国的广告 API 版本是否与 MLB 完全同代、写权限是否同级，公开文档未直接对比 → 列为未证实。

---

## 六、尚未解决的问题（公开渠道无法确认）

1. **卖家账号用新版可写端点能否成功**：需要真实 token 对 `POST .../product_ads/campaigns`、`PUT .../campaigns/{id}`、`PUT .../ad_groups/{id}` 逐一实测；官方文档支持 ≠ 该卖家账户实际放行（可能受 app Advertising 模块、卖家资质、Global Selling/Full 模式限制）。
2. **为何官方公告 2026-05-27 停用的 legacy 端点（含卖家在用的 `ads/search`）至今仍 200**：下线是否按账户/站点分批执行、是否已推迟，无公开说明。
3. **2022-02-08 禁写公告的官方原文与当前效力**：只有第三方（macarta 2022）转述；官方 2025-2026 文档已重新开放「新一代」写端点，但对旧一代没有明确「已恢复」的官方声明，旧一代实测仍是禁写/503 → 推断「禁写只对旧 API 世代仍有效，新世代已恢复」，属推断。
4. **`Api-Version` 头（1 vs 2）的真实必要性**：官方示例各端点版本头不一致（advertiser=1，campaign/ad_group=2），且卖家读端点不带版本头也 200；写端点是否强制校验某版本值未证实。
5. **App「Advertising」功能模块与 401 "User does not have permission to write." 的因果关系**：推测缺该模块会导致此类报错，但没有官方错误码对照表。
6. **余额 0 时创建 campaign 的业务报错**是否意味着创建接口放行（暗示写已开）：只有任务背景一条观测，未找到公开佐证。

---

### 附：方法与工具
- WebSearch 可用；WebFetch 对 SPA/Cloudflare 站点返回空。
- 官方 dev 站为 SPA + WAF：`curl -A "<Chrome UA>"` 直连 `global-selling.mercadolibre.com/devsite/...` 可拿到完整 SSR HTML（正文在 `Last update` 之后）。
- ML 主开发者站 `developers.mercadolibre.com.ar` 的广告文档入口已从公开导航消失（旧路径 404）；广告 API 文档现挂在 Global Selling 站点。
- Wayback CDX 全局限流（429），未能取旧版官方 Product Ads 文档存档比对。
