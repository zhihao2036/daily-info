# 验证与公开发布边界

公开仓库仅保留合成数据和可重复检查，不发布个人账户的 Worker 地址、D1/Workflow ID、真实采集文章、模型响应或投递回执。fixtures/ 和 examples/ 不是真实新闻，也不是第三方服务可用性证明。

```bash
pnpm install --frozen-lockfile
pnpm check:public
pnpm check:references
pnpm typecheck
pnpm test
pnpm test:integration
pnpm exec wrangler deploy --dry-run --config wrangler.example.jsonc
```

单元测试覆盖配置、采集、日期与正文边界、编辑证据、最多十条和来源多样性、费用、调度与发送适配器。Miniflare 集成测试覆盖真实本地 D1/HTMLRewriter/Workflows；外网、模型和发送使用合成 fixture，测试需要本机回环端口监听。

Wrangler dry-run 只证明可以构建和解析模板，不创建云资源，不说明个人账户已具备 D1、Workflow、Browser Run 权限或额度。首次云端验收需要部署者自己的账户和配置，步骤见 docs/04-deployment-and-acceptance.md。

公开检查只匹配有限的密钥格式、私人文件和生产域名，并校验模板的来源、Cron、预算和真实发送关闭。历史清理使用新的根提交导出，原私有历史不在公开发布仓库中；这不等于对所有依赖和所有安全问题作出保证。不要直接公开保留个人运维历史的原仓库。
