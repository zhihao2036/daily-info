# GitHub Actions 自动部署

`.github/workflows/ci.yml` 在 push、PR 和手动触发时运行公开文件检查、配置/文档校验、类型检查、单元/隔离集成测试和构建。只有 `main` 的 push 或手动运行、且仓库变量 `DEPLOY_ENABLED=true` 时，测试通过后才部署。Fork 默认没有这个变量和生产密钥，部署保持关闭。

## 一次性配置

在仓库 Settings → Environments 创建 `production`，将 Deployment branches and tags 设置为 Selected branches and tags，仅允许 **Branch: main**。这里不要求人工审批，因此通过测试的 main 可以自动部署；希望每次确认时，再添加 Required reviewers。

将以下内容保存为 **production Environment Secrets**，不要放进公开文件、PR、issue 或构建产物：

| 名称 | 内容 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 专用部署令牌；限定目标 Cloudflare 账户及 Workers Scripts、Workflows、D1 等实际需要的权限，不使用 Global API Key |
| `CLOUDFLARE_ACCOUNT_ID` | 目标账户 ID |
| `WRANGLER_PRODUCTION_CONFIG` | 本地完整 `wrangler.production.jsonc` 的 JSON 内容；保留原资源 ID、来源、预算、发送开关与 Cron |

ADMIN_TOKEN、LLM_API_KEY、Telegram 等运行时凭据继续保留在 Cloudflare Worker Secrets，部署流程无需将它们复制到 GitHub。配置恢复脚本会拒绝内嵌这些凭据的 vars；错误日志不回显配置内容。

可用 GitHub CLI 从 stdin 更新配置 Secret：

```bash
gh secret set WRANGLER_PRODUCTION_CONFIG --env production < wrangler.production.jsonc
```

若 `workers_dev=true`，另设置 production Environment variable `WORKER_URL`，供部署后的健康检查使用。`workers_dev=false` 的部署不开放公开健康接口，发布脚本会明确记录跳过该检查。

最后设置 **Repository variable** `DEPLOY_ENABLED=true`。在 Actions → ci 中对 main 执行 Run workflow 验证首次部署；之后推送到 main 即自动执行。取消该变量或设为 false 可关闭后续自动部署，已经开始的部署不会因此取消。

## Public repo 的权限边界

- PR 验证 job 没有生产 environment，也没有生产凭据。使用 `pull_request`，不通过 `pull_request_target` 执行外部代码，不使用不可信 PR 产物进入特权部署。
- 工作流 GITHUB_TOKEN 只有 contents:read；checkout 不持久化凭据。Action 固定到完整提交 SHA，依赖使用 frozen lockfile；升级 Action 和锁文件时需要审查。
- 部署使用新的 GitHub 托管 runner，在安装依赖后才向各步骤提供配置和 Cloudflare 令牌；生产配置不进入缓存或 artifact，部署后删除。
- public repo 的代码和 Actions 日志可公开读取。不要打印密钥或完整生产配置，不使用 shell tracing 调试凭据。GitHub 脱敏是补充措施，不能代替避免输出敏感数据。
- 建议保护 main，并审查 `.github/workflows/`、部署脚本、依赖锁文件和迁移 SQL。能修改受信任 main 部署代码的人，实际上也能使用部署令牌；Environment Secret 不会阻止已被合并的恶意代码。
- 同一生产环境的部署串行运行，新提交不会取消正在进行的迁移/部署。迁移应兼容旧代码；代码回滚不会自动回滚 D1 数据库。
- 定期轮换部署令牌并检查到期时间。API 无法读取令牌权限策略时，应在 Cloudflare 控制台核对其实际范围，不将“令牌有效”视为“已验证最小权限”。

## 日常更新

改代码后提交并推送 main，CI 会执行远端未应用的 D1 migrations，再部署 Worker 和调度。仅更改本地被忽略的生产配置不会更新 GitHub Secret：修改来源、预算、资源或 Cron 时，先同步 `WRANGLER_PRODUCTION_CONFIG`，再推送对应代码，否则下一次 CI 仍会使用旧配置。

测试不读生产 D1、不调用真实模型、不发送 Telegram。失败的 verify job 会阻止部署；生产令牌只在 deploy job 使用。
