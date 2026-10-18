# 运维

## 配置和凭据

个人部署文件为被 Git 忽略的 wrangler.production.jsonc。公开模板仅在初始化时复制，更新代码或重跑 configure 不会覆盖已存在的个人配置。不要用 git add -f 把个人配置、.env、.dev.vars、.private 或备份 bundle 放回版本控制。

远端密钥通过 Wrangler Secret 提供：ADMIN_TOKEN、可选 LLM_API_KEY/GITHUB_TOKEN、Telegram 的 TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID。本地 .env 供预览和发布脚本使用，.dev.vars 仅供本地 Worker 使用；两者都不会自动同步远端 Secret。非秘密的模型、来源和预算参数在 APP_CONFIG/SOURCES_CONFIG 中设置。

发布顺序：检查自己的资源名称和 D1 ID，运行本地测试与 doctor，再 pnpm deploy:checked -- production。该命令执行远端迁移、部署和健康检查，不改变来源/发送开关或主动发消息。默认 doctor 在个人文件存在时检查它，否则检查公开模板。

## 故障与投递

- uncertain：查原提供方回执与 D1，禁止盲目自动重发。
- 09:00 后未发送：旧日报过期，内容由后续窗口按规则处理。
- D1 恢复：先停 Cron 和发送，导出并核对投递回执；不把历史 sent 当作待发送任务重放。
- chat ID 或渠道变化：更改 destinationConfigRef，旧 outbox 不能改投新目标；核对 CONFIG_CHANGED 结果。
- Telegram 每条新闻一条文字消息，最多 10 条，每条不超过 4096 个 UTF-16 单元；不发送附件。单项过长会精简展示，完整报告仍保存在 D1。telegram_messages 保存逐条投递回执，重试跳过已成功的前序消息；未知结果不自动重发。消息间隔至少约 1 秒，正常发送完 10 条约需十余秒。部署前应用全部 D1 migrations。
- 模型使用账本预算上界管理；usage 缺失或调用结果不明可能以 uncertain 占用保守预算，不能当作发票金额。

诊断顺序为受保护 status/sources/run/digest API、D1 状态、Workflow steps、Workers 日志及 Telegram 客户端。示例：

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$WORKER_URL/api/status"
```

保留 cache-control:no-store；勿在日志、截图、issue 或公开验收文件输出 Token、chat ID、私聊消息或完整 getUpdates 响应。生产日志和 API 返回内容也不应直接作为公开示例。

## 本地验证与数据保留

本地迁移使用新的独立目录，不得复用生产数据或 Wrangler 默认状态：

```bash
TEST_STATE_ROOT=$(mktemp -d /tmp/daily-info-test-state.XXXXXX)
TEST_STATE_DIR="$TEST_STATE_ROOT/state" pnpm db:migrate:local
```

先运行 configure 生成个人本地配置，再执行以上命令；--local 不访问远端 DB。集成测试另有隔离的 Miniflare DB，不会使用个人配置中的 D1。

五分钟心跳在每次最多 100 行范围内清理过期键、租约和旧数据。陈旧普通采集记录按 180 天、终态 run 按 30 天、preview 按 90 天、scheduled 按 365 天条件渐进处理；被引用或 sending/uncertain 的记录不按普通终态清除，具体以仓库保留逻辑为准。

## 公开发布

公开版只含通用模板与合成示例。pnpm check:public 校验被跟踪文件和默认安全开关，不能替代完整安全审计。pnpm prepare:public 从已提交且干净的代码树生成一个没有旧历史、没有 remote 的 .private/public-release 仓库；原私有仓库和备份继续保留。只发布这个干净仓库，不把含旧生产历史的原仓库直接改成 public。
