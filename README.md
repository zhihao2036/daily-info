# Daily Info · AI / Agent 日报

一个可自行部署的中文 AI / Agent 日报工具，使用 TypeScript、Cloudflare Workers、Workflows 和 D1。它从 RSS/Atom、GitHub Releases 与公开 HTML 页面采集内容，筛选、归并并生成附来源的中文摘要，可通过 Telegram 私聊投递。

每天北京时间 08:00 冻结候选，08:30 发送；最多 10 条，合格内容不足时少发。评分兼顾相关性、影响、证据、新颖程度和可操作性，每个来源和组织最多两条。模型摘要和判断明确标注，RSS 摘要不冒充全文，未知发布日期不冒充新闻日期。

模板默认关闭来源、Cron、模型预算与真实发送。仓库不附带账户、数据库、API Key 或现成的在线服务。

## 快速开始

需要 Node.js 22.17+、锁定版本的 pnpm，以及部署时使用的 Cloudflare 账户。先安装并生成本地配置：

```bash
pnpm install --frozen-lockfile
pnpm configure
pnpm run doctor -- --config wrangler.example.jsonc
pnpm typecheck
pnpm test
```

`configure` 创建三个被 Git 忽略的个人文件：`wrangler.production.jsonc`、`.env`、`.dev.vars`。首次生成时自动创建随机管理 Token，不打印凭据；已有文件不会被覆盖。`.env` 用于运维脚本，`.dev.vars` 仅供本地开发；修改它们不会自动上传远端 Worker Secrets。

从 [首次部署指南](docs/04-deployment-and-acceptance.md) 继续创建自己的 D1、上传 Secrets、部署并验证预览。来源、模型和 Telegram 在验证后分别开启。完整配置模板是 [wrangler.example.jsonc](wrangler.example.jsonc)。

## 功能与边界

- 采集：RSS/Atom、GitHub Releases、HTML 列表；允许主机列表、HTTPS、响应大小和重试有明确边界。
- 编辑：最多 60 篇候选、10 篇深入处理、10 个最终事件；连续原文引用和数字支持校验、跨来源事件归并、近 30 天历史去重。
- 模型：兼容 Chat Completions 风格的结构化 JSON 接口；按自己的提供方配置模型、能力、费率与预算，支持可选 thinking 参数。
- 存储：不可变文章版本、冻结快照、Workflow 状态、租约、模型费用和投递账本保存在 D1。
- 投递：Telegram 单一私聊；未知发送结果不自动重发。preview 不发送，也不消耗已发送历史。
- 可选 Browser Run：普通请求成功但内容为空时渲染；有每日配额和访问控制冷却，不绕过登录、验证码或反爬封锁。

[来源目录](reference/sources.example.json) 是待验证候选，默认全部禁用；网站可读性会随地区、时间和页面改版变化。部分来源只提供摘要或更新时间，可能不满足日报门槛。模型归并和评分并非完整新闻覆盖或独立事实核查。

项目面向个人单用户，时区和发送时段目前固定；没有账号系统和公开阅读前端。Telegram 当前以一条纯文本发送，含主题最多 4096 字符，超长会拒绝，不截断事实或悄悄丢弃条目。所有自动化网络和模型调用都受配置限制，但云资源仍由部署者管理。

## 开发与验证

```bash
pnpm typecheck
pnpm test
pnpm test:integration
pnpm check:references
pnpm check:public
pnpm exec wrangler deploy --dry-run --config wrangler.example.jsonc
```

集成测试在隔离 Miniflare 中运行合成来源和模型，不写生产 D1、不调用真实模型、不发送 Telegram。测试需要允许本机回环端口监听。端到端云端验收需使用自己的账户，不能以本地测试通过代替。

目录：`src/collectors` 采集、`src/editorial` 编辑、`src/llm` 预算与调用、`src/workflows` 编排、`src/delivery` 投递、`migrations` 数据库迁移。参见 [采集和编辑规则](docs/03-editorial-and-sources.md)、[运维说明](docs/06-operations.md)、[贡献指南](CONTRIBUTING.md) 和 [验证边界](VALIDATION.md)。

[合成日报示例](examples/digest.txt) 只演示格式，不包含真实新闻或生产运行记录。安全问题见 [SECURITY.md](SECURITY.md)。

## 许可证

项目代码采用 [MIT](LICENSE)。第三方依赖的许可与声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。外部网站的文章、图片、商标和模型输出不因本项目的许可证而获得再分发授权。
