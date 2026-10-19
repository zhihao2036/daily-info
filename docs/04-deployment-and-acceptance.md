# 首次部署与验收

从仓库根目录执行下列命令。配置中的 Worker、D1 和两个 Workflow 名称应属于自己的账户，并避免与同账户的其他部署重名。公开模板不含任何已有生产资源标识。

## 1. 安装并生成个人配置

```bash
pnpm install --frozen-lockfile
pnpm configure
pnpm exec wrangler login
```

也可以在自己的进程环境提供 Cloudflare API Token。使用仅能管理目标账户所需 Worker、D1 与 Workflow 的权限；不能把 API Token 写进 Wrangler vars 或提交到 Git。模板中的 Browser Run 绑定是可选兜底能力，启用前确认自己账户支持该服务及相应使用限制。

`wrangler.production.jsonc`、`.env` 和 `.dev.vars` 已被忽略。`configure` 不覆盖已有文件。检查模板的 `name`、D1 `database_name` 和两个 Workflow 名称；更名后同步 `.env` 的 `WORKER_URL`。

## 2. 创建 D1

```bash
pnpm exec wrangler d1 create daily-info-production
```

把命令返回的 `database_id` 写入个人 `wrangler.production.jsonc`，替换全零占位值；若自行改名，同时修改对应的 `database_name`。不要把这个文件重新加入 Git。

```bash
pnpm db:migrate:production
```

迁移命令操作个人配置所指向的远端 DB。验证已有部署前先核对配置，首次体验可以使用单独的新 D1。

## 3. 设置管理凭据并部署

`configure` 已在 `.env` 生成至少 32 随机字节的管理 Token。把同一值粘贴到下面命令的交互提示中，勿把 Token 直接写在命令行参数里：

```bash
pnpm exec wrangler secret put ADMIN_TOKEN --config wrangler.production.jsonc
pnpm deploy:checked -- production
```

首次设置 Secret 时 Wrangler 可能提示创建 Worker，确认后再由受检查部署发布正式代码。受检查部署会校验数据库占位符、管理 Secret、迁移、发布和 `/healthz`；不会自动开启来源或发送。

在 `.env` 填入实际 `WORKER_URL=https://<worker-name>.<your-subdomain>.workers.dev`。这是自己的 Worker 地址；`deploy:checked` 会校验它与配置中的 Worker 名称一致。`.env` 不会自动上传为 Worker Secrets。

此时全部来源禁用、Cron 为空、预算为零、channel=dummy、SEND_ENABLED=false；来源全部禁用时可能提示覆盖不足，这是尚未配置来源的状态，不是成功生成了模型新闻摘要。

```bash
pnpm preview
```

预览脚本使用 `.env` 中的 URL 和管理 Token，等待 Workflow 完成并打印日报。所有管理 API 除 `/healthz` 外都需要 Bearer 管理 Token；新增 POST 请求还要求幂等键。

## 4. 按需启用来源和模型

先对选定的官方订阅源或公开页面做少量、受控的 Workers 环境探测，确认目标 URL、允许主机、实际正文容器、日期和响应大小。不要绕过 401/403/429、登录、验证码或数据服务访问要求。探测成功后在个人配置中将该来源的 `verification` 设为 `worker_verified`、`enabled` 设为 true；首次用一个非核心来源验证，不要一次把所有候选都打开。

`SOURCES_CONFIG.defaults` 可共享操作字段；URL、ID、主机列表和选择器必须逐源声明。展开后的完整配置仍逐项验证，原始绑定 JSON 不得超过 5120 字节。`pnpm doctor -- --config wrangler.production.jsonc --check-sources` 只检查 HTTP 状态，不代替正文和日期验收。

要启用模型，在个人 `APP_CONFIG.llm` 填写自己核实过的 HTTPS baseUrl、模型名称、JSON 能力、maxOutputTokens、tokenizer，以及覆盖所有计费 token 的输入/输出费率；将 `pricingIncludesAllBillableTokens` 设为 true。费率单位为 microUSD / 百万 token；预算单位为 microUSD，1 USD = 1,000,000 microUSD。自己设定非零日/月预算，维持日预算不大于月预算。示例费率为空、预算为零，不能照抄为已计费验证。

```bash
pnpm exec wrangler secret put LLM_API_KEY --config wrangler.production.jsonc
pnpm deploy:checked -- production
```

部署后通过受保护的 `POST /api/collect` 验证实际采集，再运行 `pnpm preview` 检查模型、引用和日期。模型未启用或失败时可能生成标题链接降级版本；它不等于成功的模型摘要。

```bash
curl -X POST "$WORKER_URL/api/collect" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: first-source-check-0001" \
  -d '{"sourceId":"huggingface-blog"}'
```

上例的变量需事先在自己的终端环境设置；不要把 `.env` 当成可执行脚本直接 source。返回的 statusUrl 可用相同认证轮询。请求按分钟限流，重复同一操作应复用幂等键。

## 5. 接 Telegram

在 Telegram 官方 BotFather 创建 Bot，自己先向 Bot 私聊发送 Start 和一条消息，再通过官方 Bot API 的 getUpdates 确认该私聊的正整数 chat ID。不要把整个 getUpdates 响应、Token 或 chat ID 放进 issue 或提交。

```bash
pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN --config wrangler.production.jsonc
pnpm exec wrangler secret put TELEGRAM_CHAT_ID --config wrangler.production.jsonc
```

将个人配置的 delivery.channel 改为 telegram，并给 destinationConfigRef 设置仅用于版本识别的字符串，例如 personal-telegram-v1；不要在此填 chat ID。保持 SEND_ENABLED=false，部署并完成一次自有私聊的 Bot API sendMessage 测试。测试不要调用任意收件人，不把 preview 改成真实发送。

确认测试消息成功后，单独将 SEND_ENABLED 设为字符串 true，并配置 Cron：

```json
{"crons":["0 * * * *","45 23 * * *","*/5 * * * *","15 * * * *"]}
```

这些是 UTC Cron：小时采集检查、北京时间 07:45 日报任务、五分钟恢复心跳，以及每小时第 15 分钟的历史清理。内容于 08:00 截止，08:30 发送，09:00 后不补发旧日报。可选周报另加 `0 0 * * 1`，并设置 `APP_CONFIG.weeklyReport.enabled=true`，于每周一北京时间 08:00 汇总上周日报。最后执行 `pnpm deploy:checked -- production`。

首次正式发送仍需观察 Telegram 客户端和 D1 delivery 回执。API 接受消息只代表 Telegram 接收请求，不代表已经阅读；结果 uncertain 时禁止盲目重试。

## 官方参考

- [Cloudflare D1 入门](https://developers.cloudflare.com/d1/get-started/)
- [Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Telegram Bot 教程](https://core.telegram.org/bots/tutorial)
- [Telegram Bot API](https://core.telegram.org/bots/api)
