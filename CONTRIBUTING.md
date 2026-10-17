# 贡献指南

提交前运行 pnpm typecheck、pnpm test、pnpm test:integration、pnpm check:references、pnpm check:public，以及公开模板的 Wrangler dry-run。测试只使用合成数据和隔离数据库；不要提交真实提供方响应、付费调用回执或个人部署文件。

新增来源应提供来源类型、允许主机、日期行为、正文选择器与合成 fixture。候选记录默认 discovered/disabled；自己的 Worker 访问成功不代表所有部署者都可访问。不得通过修改 HTTPS、预算、访问控制或证据校验边界来让 fixture 通过。

功能变更同时说明触发条件、结果、验证方法和限制。修改状态机、投递、费用或不可变版本时，补充覆盖真实失败形态的测试，避免只重复实现细节。

贡献需有权在本项目 MIT 许可下提交。若包含第三方代码，保留其来源、版权和许可证声明。依赖变更要核对许可证和公开漏洞公告；更新构建发布前复核 THIRD_PARTY_NOTICES.md。
