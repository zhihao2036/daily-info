# Cloudflare AI Digest Implementation Plan

> 本文保留最初的实施设计，任务勾选和 staging 名称不是当前部署状态。首次部署请使用 [当前部署说明](04-deployment-and-acceptance.md)，实现和验证以源码、测试及 CI 为准。


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 如果目标coding agent没有这些技能，按下述任务逐项实施、自测和审查即可，不将技能安装作为交付前提。

**Goal:** 实现一个部署在Cloudflare上的个人AI/Agent中文日报服务，能自动采集、冻结来源、生成并安全推送，具备可审计恢复能力。

**Architecture:** 一个Worker、两个Workflows和D1。Cron只负责登记及派发，业务状态由D1决定；模型只编辑资料，程序控制预算与发送。测试环境默认dummy且关闭发送。

**Tech Stack:** TypeScript、Workers、Workflows、D1、原生fetch、fast-xml-parser、Zod、Vitest、Wrangler、pnpm。

**Spec:** `01-spec.md`；执行时同时读取`../reference/contracts.ts`、`../reference/schema.sql`以及本任务涉及的03/04/05。

## Global Constraints

- Cloudflare 部署；AI/Agent 信息；中文早报；便于 coding agent 实现。
- 单用户personal；v1仅Asia/Shanghai；07:45补采、08:00冻结、08:25编辑截止、08:30发送、09:00关闭自动发送。
- 默认SEND_ENABLED=false，MVP实现dummy、Telegram私聊与兼容的cloudflare_email；production只启用Telegram，X/飞书属于后续可选扩展。
- SQL参数化；UTC毫秒；整数microUSD；来源正文不能修改任务指令或发送目标。
- 每源每轮最多3页×30条、20新正文；候选200、精读20、最终至多8事件。
- 不创建管理前端、不依赖外部服务器、不引入Queues/R2/KV/DO/vector作为MVP必需。
- 未配置真实模型/Telegram时必须能完成fixture与dummy流程，不伪造外部测试结果。

## Review Focus

1. 同一Cron或API请求并发到达：最多一份计划任务或一份scheduled日报；T01/T04验收。
2. 文章来源日期旧、日期缺失、A→B→A修订：保存真实版本并正确冻结；T02/T03验收。
3. 模型收到恶意正文、输出假URL或无证据数字：不越权且剔除无支撑事实；T05/T06验收。
4. 供应商已接受消息但回执丢失：uncertain且不自动重发；T07验收。
5. 模型调用超时、跨UTC账期结算、重试重复扣款：保留预留且同attempt不重复记账；T05/T08验收。

## 实施规则与任务依赖

这些是实施任务与关键算法样例，不是一个已经可运行的应用源码。测试代码定义预期行为；实现者必须补齐模块、依赖注入与测试夹具，保证实际测试运行。不得以复制函数签名、mock所有依赖或只跑typecheck代替集成验证。

T01→T02→T03→T04；T02→T05→T06；T02→T07；T03/T04/T05/T06/T07→T08。T03、T05、T07在T02契约稳定后可并行，但同一文件由单个任务持有。

每任务按“写具体失败用例→确认失败原因→完成实现→运行相关测试→审查diff→提交”执行。提交频率以完整可审查任务为单位。修复失败只扩大到相关风险，不对无关模块重构。各任务结束输出变更文件、命令、结果、剩余配置阻塞项。

## T01：工程、配置、API鉴权与幂等协议

**Files:** package.json、pnpm-lock.yaml、tsconfig.json、wrangler.staging.jsonc、src/index.ts、src/domain/contracts.ts、src/config/{schema,load}.ts、src/api/{router,auth,idempotency}.ts、tests/unit/{config,api}.test.ts。

**Consumes:** reference/contracts.ts与三个JSON配置样例。

**Produces:**

```ts
export function parseSendEnabled(raw: string): boolean;
export function validateConfig(input: unknown): AppConfig;
export function createHttpHandler(deps: ApiDeps): (request: Request) => Promise<Response>;
export interface ApiDeps {
  adminToken: string;
  collect(input: { sourceId: string }, key: string): Promise<RunAccepted>;
  preview(input: { date?: string }, key: string): Promise<RunAccepted>;
  read(path: string): Promise<Json | null>;
}
```

- [ ] 创建工程和锁文件，将reference/contracts.ts复制到src/domain/contracts.ts。脚本至少有dev、typecheck、test、test:integration、deploy:staging、deploy:production、db:migrate:local、db:migrate:staging、db:migrate:production，具体命令见04。
- [ ] 写失败测试：字符串false不能启用发送；未知时区拒绝；未授权POST不能调用dispatch。

```ts
import { describe, it, expect, vi } from 'vitest';
import { parseSendEnabled } from '../../src/config/load';
import { createHttpHandler } from '../../src/api/router';
it('false is false and ambiguous inputs fail', () => {
  expect(parseSendEnabled('false')).toBe(false);
  expect(parseSendEnabled('true')).toBe(true);
  expect(() => parseSendEnabled('1')).toThrow();
});
it('rejects unauthorized dispatch before any side effect', async () => {
  const collect = vi.fn();
  const handle = createHttpHandler({adminToken:'test-token', collect, preview:vi.fn(), read:vi.fn()});
  const r = await handle(new Request('https://unit.test/api/collect', {method:'POST',body:'{"sourceId":"hf-blog"}'}));
  expect(r.status).toBe(401);
  expect(collect).not.toHaveBeenCalled();
});
```

- [ ] 执行`pnpm exec vitest run tests/unit/config.test.ts tests/unit/api.test.ts`，先确认因目标功能缺失失败。
- [ ] 实现严格布尔解析及Zod全配置schema；对每个POST先认证、限制8KiB、解析body和key，再调用ApiDeps。最低关键代码如下，其他错误也须映射ApiError。

```ts
export function parseSendEnabled(raw: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('CONFIG_INVALID:SEND_ENABLED');
}
```

- [ ] 幂等key完整SQL在T02接入；此任务用fake ApiDeps验证传参及409等错误映射，不声称已完成并发幂等。实现GET健康/状态路由，输出脱敏。
- [ ] 运行typecheck及unit tests；提交`feat: add validated config and protected API shell`。

## T02：D1持久化、租约、版本与冻结

**Files:** migrations/0001_initial.sql、src/db/repositories/{sources,items,digests,runs,requests}.ts、tests/integration/persistence.test.ts。

**Consumes:** schema.sql、Clock、RawItem、Lease、FrozenCandidate。

**Produces:**

```ts
export interface Persistence {
  acquireLease(sourceId: Id, ownerId: Id, now: EpochMs): Promise<Lease | null>;
  renewLease(lease: Lease, now: EpochMs): Promise<Lease | null>;
  commitPage(input: { runId: Id; pageNo: number; lease: Lease; items: RawItem[]; nextCursor: Json; complete: boolean }): Promise<void>;
  freezeCandidates(digestId: Id, generation: number): Promise<FrozenCandidate[]>;
  registerRequest(input: {scope:string; key:string; requestHash:string; params:Json; now:EpochMs}): Promise<RunAccepted>;
}
```

- [ ] 将schema.sql作为首个迁移；固定16张表与索引。准备D1测试fixture：一个源、两个互斥owner、一个scheduled digest、数条发布时间/入库时间不同的版本。04提供Workers测试环境配置方式。
- [ ] 写并运行失败用例，以下行为须在真实D1测试binding上验证，repo和DB不能同时mock：

```ts
// persistence fixture is created with real D1 migrations, not an in-memory JS map.
it('old lease cannot commit after another owner acquires', async () => {
  const old = await repo.acquireLease('hf-blog','run-a',clock.now());
  clock.advance(121_000);
  const fresh = await repo.acquireLease('hf-blog','run-b',clock.now());
  expect(fresh!.fencingToken).toBeGreaterThan(old!.fencingToken);
  await expect(repo.commitPage({runId:'run-a',pageNo:0,lease:old!,items:[article],nextCursor:null,complete:true})).rejects.toThrow('LEASE_LOST');
  expect(await countItemVersions()).toBe(0);
});
```

测试文件定义`repo`为Persistence实现，`clock`为可注入Clock并有advance(ms)，`article`为合法RawItem；`countItemVersions()`执行D1 `SELECT COUNT(*)`。这些夹具只负责准备数据，不实现被测算法。

- [ ] 追加以下数据库案例：同page重放不增版本；A→B→A为3个revision；旧日期但新发现进入late候选；cutoff之后版本不能入本期；重复freeze返回相同ID；相同API key+body同run，换body409，第6个新请求429。
- [ ] 领取租约用单statement原子upsert并RETURNING；仅过期可替换owner并递增token。续租条件owner/token/未过期全部匹配；每次写库重新校验，不能仅检查调用者Lease对象。

```sql
INSERT INTO source_leases(source_id,owner_id,fencing_token,expires_at)
VALUES (?1,?2,1,?3)
ON CONFLICT(source_id) DO UPDATE SET
 owner_id=excluded.owner_id,
 fencing_token=source_leases.fencing_token+1,
 expires_at=excluded.expires_at
WHERE source_leases.expires_at <= ?4
RETURNING source_id,owner_id,fencing_token,expires_at;
```

?3=now+120000，?4=now。结果为空表示不能领取，不是数据库失败。

- [ ] 每页中item/version写入和collection_pages committed、最终sources游标使用同一fencing条件，按参数上限拆小批；只有所有条目提交且全扫描完成才推进扫描高水位。最多3页仍未完整扫描时记录incomplete与nextCursor，保留旧安全水位。失败页面重放依赖ingest_key。
- [ ] 追加“第一小批暂存成功、第二小批失败时恰逢freeze”的测试，所有pending页版本均不可见，current_revision仍指向上个committed版本。freeze查询与写入按generation+frozen_at限定；事务中快照行和标记一起落库。应用外部时间不能冒充DB提交时间。
- [ ] 运行`pnpm exec vitest run tests/integration/persistence.test.ts`及typecheck，检查D1无BEGIN/COMMIT；提交`feat: persist fenced collection and immutable digest inputs`。

## T03：采集与正文提取

**Files:** src/collectors/{http,normalize,rss,github,html}.ts、src/extractors/html.ts、tests/unit/collection.test.ts、tests/integration/extraction.test.ts、tests/fixtures/。

**Consumes:** SourceConfig、Collector、RawItem、CollectionPage、Persistence.commitPage。

**Produces:**

```ts
export function canonicalizeUrl(raw: string, allowedHosts: string[]): string;
export function normalizeFeed(xml: string, source: SourceConfig): RawItem[];
export function createCollector(kind: SourceKind): Collector;
export function extractHtml(response: Response, source: SourceConfig): Promise<{text:string;quality:ContentQuality}>;
```

- [ ] 将包内fixtures用于最小parser测试，再补RSS缺日期、Atom、坏XML/DOCTYPE、Github分页、HTML文字分块。fixture不得含真实Secrets或整篇版权文章。
- [ ] 写URL规范化失败测试，不能删除具有业务意义的query。

```ts
it('removes tracking but preserves release identity', () => {
  expect(canonicalizeUrl('https://example.com/post?version=2&utm_source=x#top',['example.com']))
    .toBe('https://example.com/post?version=2');
  expect(() => canonicalizeUrl('https://attacker.test/post',['example.com'])).toThrow();
});
```

- [ ] 实现HTTPS和每次redirect的host检查；只删除明确追踪参数utm_*、fbclid、gclid，保留其他query；移除fragment；禁止用户名密码。canonical标签也必须通过host校验，不能以canonical外链扩大抓取范围。
- [ ] 使用AbortController与读取流逐块累计decoded字节，超过2MiB立即取消。每个request finally清理timeout。XML禁DOCTYPE/实体扩展；只接受实际RSS/Atom结构，HTML200不当RSS成功。
- [ ] RSS优先全文；GitHub按list releases+Link分页，排除draft，prerelease按配置；HTML使用配置选择器，消费transform响应到结束并验证正文长度/质量。
- [ ] 单源某正文失败生成metadata_only或partial，页面发现结果仍保存且覆盖计数失败；同时保留待重试状态，不能让条目因已经存在就永远不再提取。实现选择metadata_only且近期新条目的后续重试队列查询，最多20条/源/轮，退避和总尝试3次记录在metadata_json。
- [ ] 运行unit和Workers HTMLRewriter集成测试；手工检查至少每类2个fixture输出；提交`feat: collect bounded feeds releases and static articles`。

## T04：Cron、Workflows与恢复

**Files:** src/scheduler/{time,dispatch,reconcile}.ts、src/workflows/{collect-source,daily-digest}.ts、tests/unit/schedule.test.ts、tests/integration/workflows.test.ts。

**Consumes:** Persistence、CollectParams、DigestParams；模型/编辑/投递通过service接口注入，后续任务接入真实实现。

**Produces:**

```ts
export function digestTimes(scheduledAt: EpochMs): DigestTimes;
export function stableJobId(jobKey: string): Promise<string>;
export function reconcile(now: EpochMs): Promise<void>;
// src/index.ts exports CollectSourceWorkflow and DailyDigestWorkflow.
```

- [ ] 写日期边界测试和同槽重复触发测试。

```ts
it('maps UTC evening to next local digest date', () => {
  const t = digestTimes(Date.parse('2026-09-20T23:45:00Z'));
  expect(t.localDate).toBe('2026-09-21');
  expect(new Date(t.cutoffAt).toISOString()).toBe('2026-09-21T00:00:00.000Z');
  expect(new Date(t.sendDeadlineAt).toISOString()).toBe('2026-09-21T01:00:00.000Z');
});
```

- [ ] 使用Intl.DateTimeFormat明确Asia/Shanghai获得YYYY-MM-DD，再构造带`+08:00`的明确时间；v1不接受其他时区。稳定ID使用jobKey的SHA256十六进制（可前缀collect/digest），仅字母数字和连字符，长度≤100，不使用随机id绕过duplicate。
- [ ] D1先登记runs pending_create，再调用binding.create；超时/已有实例时按相同workflow_id查询，现存实例不restart。heartbeat处理未过deadline的pending_create。每轮最多20个创建，分页处理待办。
- [ ] CollectSourceWorkflow分页步骤带sourceId/pageNo等确定名称；每次真实写入重新验证租约。DailyDigestWorkflow以digest_id和build_generation恢复已落库状态，wait使用step.sleepUntil；不要把整个流程放在一个step.do。
- [ ] 在08:25以CAS递增generation并走降级，旧生成者不能提交；08:35–08:55每五分钟只恢复可恢复状态，09:00禁止新发送。可能重复出现的cron条件分别幂等。
- [ ] 加入create成功但D1后续更新丢失、Workflow抛错恢复、generation落后、已经ready不重写、preview历史日期不因08:25过期等测试；使用fake clock或Workflows测试控制加速等待。
- [ ] 运行`pnpm exec vitest run tests/unit/schedule.test.ts tests/integration/workflows.test.ts`，确认不是只调用一次scheduled函数；提交`feat: orchestrate durable daily digest and bounded recovery`。

## T05：LLM适配、费用预算与缓存

**Files:** src/llm/{provider,budget,cache}.ts、tests/unit/llm.test.ts、tests/integration/budget.test.ts。

**Consumes:** LlmRequest/LlmResponse、AppConfig.llm/budget、llm_calls/budget_buckets。

**Produces:**

```ts
export function estimateCostMicrousd(inputUpper: number, outputCap: number, inputRate: number, outputRate: number): number;
export function createLlmProvider(config: AppConfig, apiKey: string): LlmProvider;
export function completeBudgeted(input: BudgetedCall): Promise<LlmResponse>;
```

- [ ] 写金额测试并测试missing价格禁止真实fetch；不以0免费价代替null。

```ts
it('uses micro-USD and rounds up once', () => {
  expect(estimateCostMicrousd(1000,500,1000000,2000000)).toBe(2000);
  expect(estimateCostMicrousd(1,0,1,1)).toBe(1);
});
```

- [ ] 实现安全整数校验和向上取整。大型乘积使用BigInt中间值；输入价格0允许但全0请求仍需记录ledger，reference SQL reserved>0要求至少预留1microUSD作为调用记账门槛，成功后可结算0。

```ts
const numerator = BigInt(inputUpper)*BigInt(inputRate) + BigInt(outputCap)*BigInt(outputRate);
const cost = Number((numerator + 999999n) / 1000000n);
```

- [ ] 按01预算协议实现同一个D1 batch检查两桶并预留；相同call id重复不得重复增额；结算从账本SUM重算两个桶。调用前转calling，实际发送网络前再次检查预算reservation和deadline。
- [ ] HTTP adapter仅对已知能力添加response_format等参数；异常解析为永久、可重试或未知已计费。最多3次真实调用，cache命中不发新调用。不能把SDK隐式retry叠加到Workflow retry之外。
- [ ] 并发预算验收代码的核心期望：两次各600000预留竞争750000日预算时最多一个成功；月额度不足时日额度不能已扣。

```ts
const results = await Promise.allSettled([reserve('call-a',600000), reserve('call-b',600000)]);
expect(results.filter(x => x.status === 'fulfilled')).toHaveLength(1);
expect((await readDayBucket()).reservedMicrousd).toBe(600000);
```

`reserve(callId,amount)`为预算repo测试辅助入口，仅登记预留不调用网络；`readDayBucket`直接查询DB。补充跨UTC月结算、calling崩溃不释放、成功无usage按预留结算、重复settle不重复扣款测试。

- [ ] 运行LLM单元测试与D1预算集成测试；提交`feat: add bounded LLM calls and idempotent budget ledger`。

## T06：编辑、去重、证据校验与渲染

**Files:** src/editorial/{filter,group,validate,render}.ts、src/prompts/、tests/unit/editorial.test.ts、tests/integration/editorial-pipeline.test.ts。

**Consumes:** FrozenCandidate、历史sent/uncertain digest_events、completeBudgeted；reference/prompts.md及03。

**Produces:**

```ts
export function scoreEvent(scores: EventCard['scores']): number;
export function validateEvidence(fact: Fact, versions: ItemVersion[]): boolean;
export function renderDigest(content: DigestContent): {text:string;html:string};
export function buildDigest(digestId: Id, generation: number): Promise<DigestContent>;
```

- [ ] 以包内合成文章做“同事件两源只一条、昨天没有新信息不重复、prompt注入不改变配置”的固定测试；禁止用真实在线LLM的不确定输出作为唯一CI断言。
- [ ] 证据测试先失败：引用不存在version或quote并非原文片段必须拒绝；HTML需要转义。

```ts
it('rejects invented evidence', () => {
  const fact = {text:'Speed doubled',evidence:[{itemVersionId:'v-missing',quote:'twice as fast'}]};
  expect(validateEvidence(fact,[])).toBe(false);
});
```

- [ ] 分数由程序计算`0.35*relevance + 0.25*impact + 0.20*evidence + 0.15*novelty + 0.05*actionability`，各维0–100，阈值60；模型不能自行修改权重。event identity由程序规范化字段并计算，低置信度不强行合并。
- [ ] quotes进行换行/空白标准化后验证连续片段包含，限每段240字符；该检查只能证明片段存在，不能证明语义正确。重要数字必须在证据或结构化来源中出现且归属清楚；缺证据剔除，来源不足输出限制说明。
- [ ] 用引用version IDs反查数据库URL；不渲染模型生成的未知链接。模板转义`& < > " '`，HTML只能来自程序模板；片段只保留内部审计，公开正文用摘要不复制大量原文。
- [ ] 生成降级版：按程序来源优先级列出冻结标题+链接和失败原因，不写模型未核实的解释。全部核心源失败时“采集异常”，非“暂无重要更新”。
- [ ] 运行编辑fixture测试与D1快照集成测试；提交`feat: generate cited non-duplicative Chinese digests`。

## T07：发送记录与消息适配

**Files:** src/delivery/{service,dummy,cloudflare-email}.ts、src/db/repositories/delivery.ts、tests/unit/sender.test.ts、tests/integration/delivery.test.ts。

**Consumes:** 已ready快照、DeliveryPayload、Sender、Clock、SEND_ENABLED。

**Produces:**

```ts
export function createDummySender(): Sender;
export function createCloudflareEmailSender(binding: unknown, config: AppConfig): Sender;
export function createTelegramSender(config: TelegramSenderConfig): Sender;
export function deliverDigest(digestId: Id, generation: number): Promise<SendResult>;
```

- [ ] 写disabled/preview/dummy三种情况下无真实发送的测试；mock只替换外部Sender，D1账本仍用真实binding。
- [ ] 写并发领取测试和“accepted但返回前断线”测试；同日报20并发调用Sender最多一次。

```ts
it('does not resend an ambiguous accepted request', async () => {
  sender.send.mockResolvedValueOnce({kind:'uncertain',code:'CONNECTION_LOST'});
  await deliver();
  await recoverAt('2026-09-21T00:35:00Z');
  expect(sender.send).toHaveBeenCalledTimes(1);
  expect(await deliveryState()).toBe('uncertain');
});
```

fixture中`deliver`调用deliverDigest，`recoverAt`注入Clock并执行真实reconcile，`deliveryState`查D1；测试不能在recoverAt里直接返回。

- [ ] 原子claim示意如下，production实现还须加入digest.mode/generation/time窗口校验，并在同batch创建attempt记录。

```sql
UPDATE deliveries SET status='sending', attempt_id=?1,
 attempt_count=attempt_count+1, claimed_at=?2, updated_at=?2
WHERE id=?3 AND attempt_count<3 AND
 (status='pending' OR (status='failed' AND retryable=1 AND next_attempt_at<=?2))
RETURNING id;
```

- [ ] 持久化calling后进行唯一一次外部调用。Telegram适配器固定调用官方Bot API `sendMessage`，只接受配置中的私聊chat ID，纯文本不得超过4096字符；兼容的Cloudflare Email适配器保留。unknown状态不当明确failed。
- [ ] send步骤与HTTP客户端自动重试都关闭；failed可重试由reconcile管理，每次新attemptId；过期sending→uncertain，延迟回执只CAS同attempt。
- [ ] 所有路径实测：09:00不新发、08:59发送在09:00后收到真实accepted可补记、配置关闭立即停发、chat ID变化抑制、数据库恢复后不自发旧日报。
- [ ] 运行sender和D1 delivery测试；提交`feat: send digest with auditable delivery outcomes`。

## T08：集成、部署与运维交付

**Files:** README.md、wrangler.{staging,production}.jsonc、tests/integration/end-to-end.test.ts、scripts/doctor.ts、scripts/preview.ts、.github/workflows/ci.yml（仓库使用GitHub时）、运维说明。

**Consumes:** T01–T07全部service与04验收矩阵。

**Produces:** 可重复安装/测试/部署的仓库，staging预览证据、明确配置清单和如获授权后的生产运行记录。

- [ ] 将DailyDigestWorkflow接到真实collect/editorial/delivery；本地端到端用fixture HTTP和dummy，D1+Workflow逻辑保持真实。用固定时间和源数据完成从采集到ready/suppressed的验证。
- [ ] 添加合成端到端断言：三篇来源、两篇同事件、一个无关广告，最终一条或两条有证据事件且providerCalls=0；再次执行同run不重复创建scheduled日报。
- [ ] 实现doctor：配置schema、binding存在性、数据库迁移、enabled源真实响应、LLM最小调用（仅显式启用且预算充分）、所选消息渠道静态检查分开显示。doctor默认不发任何消息。
- [ ] CI执行`pnpm install --frozen-lockfile`、`pnpm typecheck`、`pnpm test`、`pnpm test:integration`、`pnpm exec wrangler deploy --dry-run --config wrangler.staging.jsonc`。网络源验证作为显式部署任务，CI使用fixture。
- [ ] 按04在staging应用迁移并部署，调用受保护preview，查看实际Workflow状态/D1快照。测试环境Cron为空且发送关闭；验证后才配置生产三个Cron、真实渠道与发送开关。
- [ ] 完成04全部MVP验收；记录环境/日期/命令/结果，云端未能验证的单独列出。不以“请用户自行测试”代替已经有授权、凭据且可完成的验证。
- [ ] 提交`docs: add deployment runbook and acceptance evidence`。最终报告只列真实完成项，提供仓库、部署地址、最近一次预览、费用概要及仍缺配置。

## 最终交付检查

- [ ] 所有类型、SQL列、JSON键与接口一致，源码没有把示例invalid endpoint当真实模型。
- [ ] 锁文件、迁移、配置schema、source配置、完整prompt和README齐全。
- [ ] 不把OpenAI/RSS网页入口“发现”当作Workers环境采集成功；真实验证状态逐源记录。
- [ ] 本地静态验证、D1/Workflow集成验证、staging远端验证分开陈述。
- [ ] 未选择推送渠道时完成dummy、Telegram和兼容邮件适配实现，默认关闭；不凭空填收件人或chat ID。
- [ ] 文档不要求实现X或三种聊天渠道才算MVP完成。
