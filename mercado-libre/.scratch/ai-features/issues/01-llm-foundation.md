# 01 — LLM 底座 + 测试地基

**What to build:** 后端可调用 DeepSeek 的共享模块（统一「给系统提示 + 消息列表 → 返回文本」接口；key 从环境变量读取、前端永不接触；超时/限流/解析失败有统一错误语义），以及自动测试的地基（pytest + 不花钱的假 LLM 替身）。广告助手与消息工作台都建立在这块之上。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 假 LLM 替身下，验证给 LLM 的 prompt 组装正确、回复解析正确
- [x] 真实 DeepSeek key 配置后，能返回文本（需用户提供 key 或已配置）
- [x] LLM 调用失败（超时/限流/解析）有统一错误语义，不崩溃
- [x] pytest 测试跑通，测试基建可用
- [ ] 实测并记录：现有 OAuth scope（read write）对消息 API 是否足够（待实测：需真实 ML 消息 API 验证）
