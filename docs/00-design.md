# 产品背景与架构摘要

用户希望每天早上收到一条中文AI/Agent动态，来源以LLM厂商博客、Agent框架/工具发布为基础，X可后续补充。部署约束已经确定为Cloudflare；本项目使用 TypeScript、Workers、Workflows 与 D1 实现采集、编辑和投递。

## 产品体验

每天北京时间08:30左右，提供最多10个值得关注的独立事件，目标800–1200中文字。内容优先模型与API变化、Agent工程、上下文管理、评估、部署、成本和开源工具。每条说明变化、意义和适用动作，并附实际采集过的原文链接。

没有足够新闻时少发；没有合格新闻时说明暂无重要更新；采集明显失败时说明覆盖异常。官方性能主张不写成独立验证结论。同一事件的转发与转载合并，已报道内容只有实质新进展才再次出现。

## Cloudflare资源

| 资源 | 作用 |
| --- | --- |
| Workers | HTTP管理入口、Cron调度入口 |
| Workflows | 单源采集与每日日报两类执行流程，分阶段恢复 |
| D1 | 来源、不可变文章版本、候选快照、事件与日报、投递和费用账本 |
| 外部LLM API | 结构化筛选、归并和中文编辑 |
| Telegram Bot API | production 的个人私聊推送；默认dummy预览 |

长期运行推荐Workers Paid；基础账户套餐及实际超额用量按[Workers定价](https://developers.cloudflare.com/workers/platform/pricing/)，工作流步骤/状态按[Workflows定价](https://developers.cloudflare.com/workflows/reference/pricing/)。模型与可选X调用单独计算，不承诺所有服务合计免费。

## 最小范围

MVP实现RSS、GitHub Releases、精选静态列表页面，dummy与Telegram私聊适配；Cloudflare邮件代码仅作兼容，不在production启用。飞书、X、管理前端、浏览器抓取、向量搜索属于后续扩展，不列为首版交付门槛。

实际模型、密钥、Telegram bot token 与个人私聊 chat ID 都是部署输入。coding agent应先完成工程、数据库、fixture测试与dummy预览；不要因没有外部凭据停在脚手架，也不能伪造真实连接成功。

## 时序与关键决定

07:45补采，08:00冻结，08:25停止付费编辑并必要时降级，08:30发送；08:35–08:55每五分钟恢复，09:00关闭新发送。三个UTC Cron为`0 * * * *`、`45 23 * * *`、`*/5 * * * *`，具体约束见01/05。

文章按revision保存，A→B→A保留三次版本。半页暂存数据在页面最终提交前不能进入日报。业务状态由D1唯一键与条件写入保证，Workflows步骤缓存只辅助恢复。消息accepted表示供应商受理；发送结果不明标记uncertain并暂停自动重发。

详细实现以01-spec、contracts.ts和schema.sql为准；历史方案中的Docker/Python、单次08:35检查和按全历史正文hash唯一去重已由本版替换。
