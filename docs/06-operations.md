# 运维

## 配置和凭据

个人部署文件为被 Git 忽略的 wrangler.production.jsonc。公开模板仅在初始化时复制，更新代码或重跑 configure 不会覆盖已存在的个人配置。不要用 git add -f 把个人配置、.env、.dev.vars、.private 或备份 bundle 放回版本控制。

启用 [GitHub Actions](07-github-actions.md) 后，CI 从 production Environment Secret `WRANGLER_PRODUCTION_CONFIG` 恢复生产配置。以后修改本地来源、预算或 Cron 时也要更新该 Secret，避免下次自动部署覆盖成旧配置。运行时模型和 Telegram 凭据仍由 Cloudflare Worker Secrets 管理。

远端密钥通过 Wrangler Secret 提供：ADMIN_TOKEN、可选 LLM_API_KEY/GITHUB_TOKEN、Telegram 的 TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID。本地 .env 供预览和发布脚本使用，.dev.vars 仅供本地 Worker 使用；两者都不会自动同步远端 Secret。非秘密的模型、来源和预算参数在 APP_CONFIG/SOURCES_CONFIG 中设置。

发布顺序：检查自己的资源名称和 D1 ID，运行本地测试与 doctor，再 pnpm deploy:checked -- production。该命令执行远端迁移、部署和健康检查，不改变来源/发送开关或主动发消息。默认 doctor 在个人文件存在时检查它，否则检查公开模板。

## 故障与投递

- uncertain：查原提供方回执与 D1，禁止盲目自动重发。
- 09:00 后未发送：旧日报过期，内容由后续窗口按规则处理。
- D1 恢复：先停 Cron 和发送，导出并核对投递回执；不把历史 sent 当作待发送任务重放。
- chat ID 或渠道变化：更改 destinationConfigRef，旧 outbox 不能改投新目标；核对 CONFIG_CHANGED 结果。
- Telegram 每条新闻一条文字消息，最多 10 条，每条不超过 4096 个 UTF-16 单元；不发送附件。单项过长会精简展示，完整报告仍保存在 D1。telegram_messages 保存逐条投递回执，重试跳过已成功的前序消息；未知结果不自动重发。消息间隔至少约 1 秒，正常发送完 10 条约需十余秒。部署前应用全部 D1 migrations。
- 模型使用账本预算上界管理；usage 缺失或调用结果不明可能以 uncertain 占用保守预算，不能当作发票金额。

## 每周回顾

`APP_CONFIG.weeklyReport.enabled=true` 开启 Telegram 周报，Cron `0 0 * * 1` 对应每周一北京时间 08:00。范围为上周一至周日的日报日期，仅汇总投递状态为 sent 的 scheduled 日报；preview、uncertain、未发送日报不进入周报。每条为原日报标题加一个主要来源链接，同一事件或链接保留最新一次，不额外调用模型。没有可汇总内容时发送一条空周报说明。

周报消息按完整新闻块分段，每段小于 4096 字符，并关闭链接预览。日报最多 10 条新闻；周报汇总整周，最多分成 10 条 Telegram 消息，异常超长内容会报错而非丢弃新闻。`digests.report_kind='weekly'` 标识周报，`local_date` 为发送周一的日期；日报仍为 daily。周报快照冻结后不再重建，复用 deliveries / telegram_messages 的持久回执、最多三次明确失败重试、未知结果停止策略；五分钟心跳可在 08:00–09:00 补建并恢复投递。周报不会改变日报的采集窗口或去重历史。上线前应用 migrations/0004_weekly_reports.sql。

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

历史清理由独立 Cron `15 * * * *` 每小时执行一次，每次最多 100 行；部署时保留此 Cron。五分钟心跳继续检查任务与投递恢复。陈旧普通采集记录按 180 天、终态 run 按 30 天、preview 按 90 天、scheduled 按 365 天条件渐进处理；被引用或 sending/uncertain 的记录不按普通终态清除，具体以仓库保留逻辑为准。

来源配置在每次入口准备时用一次查询与数据库核对，仅新增、修改或移除来源时写入；配置不变不写 updated_at，也不重置游标与健康状态。采集提交按当次 `(collection_run_id, collection_page_no)` 定位版本和文章，清理按时间范围查询，并通过反向引用索引保护历史快照。上线前应用 `0005_d1_query_efficiency.sql`。可用 `wrangler d1 insights DB --config wrangler.production.jsonc --timePeriod=1d --sort-type=sum --sort-by=reads --limit=10 --json` 对照长期扫描量；发布后的短期统计仍包含旧版本查询。

## 公开发布

公开版只含通用模板与合成示例。pnpm check:public 校验被跟踪文件和默认安全开关，不能替代完整安全审计。pnpm prepare:public 从已提交且干净的代码树生成一个没有旧历史、没有 remote 的 .private/public-release 仓库；原私有仓库和备份继续保留。只发布这个干净仓库，不把含旧生产历史的原仓库直接改成 public。
