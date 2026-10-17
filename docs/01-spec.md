# Cloudflare AI / Agent 日报实施规格 v1

日期：2026-09-21。本文、`../reference/contracts.ts` 与 `../reference/schema.sql` 是实现的规范；`00-design.md` 解释产品背景。本文明确的细节覆盖旧设计里的概括性表述。交付内容是规格与参考素材，尚无完整应用、生产资源或已启用的定时推送。

## 1. 目标、已确定项和默认值

每天早上给一个个人用户发送中文 AI / Agent 简报，减少刷消息的时间，帮助发现会影响模型选择、Agent 开发、评估、上下文、部署和成本的变化。每条可追溯到实际抓取过的来源。正式版直接运行于用户自己的 Cloudflare 账户。

| 分类 | 结论 |
| --- | --- |
| 已确定要求 | Cloudflare 部署；AI/Agent 信息；中文早报；便于 coding agent 实现 |
| 实施默认值 | 单用户 personal；Asia/Shanghai；08:30发送；优先工程实践；最多10事件、800–1200中文字符 |
| 尚需部署者提供 | Cloudflare账户与授权；LLM endpoint/model/key和价格；实际推送渠道与目标 |
| 缺少上述配置 | 可完成代码、fixture测试和dummy预览；不伪造真实接入成功 |
| MVP推送实现 | dummy、Telegram 私聊与兼容的 cloudflare_email；默认dummy、SEND_ENABLED=false；production 只启用 Telegram |
| 后续扩展 | 飞书、X；只预留接口，不列为MVP必做 |

少于5条合格新闻可以直接少发；“没有重要更新”与“采集失败”必须区分。官方性能宣传必须保留“厂商宣称”等归属。无证据的重要事实不出刊。程序决定时间、预算、来源、发送目标，LLM没有系统修改或发送权限。来源authority与覆盖core分开：官方身份来自已验证的发布主体，聚合社区内容默认community，不能因为来源重要就把文章当官方公告。

## 2. 系统边界与依赖

一个 TypeScript Worker 项目，两个 Workflow 类：CollectSourceWorkflow、DailyDigestWorkflow，一个D1数据库。原生fetch和HTTP路由、fast-xml-parser、Zod；Wrangler负责开发与部署，Vitest负责测试。所有包按实现当日兼容版本锁定，提交pnpm-lock.yaml；默认开发基线Node.js 22+、pnpm 10+，若锁定工具要求更高Node版本，统一调整并在README说明，不混用包管理器。

不建设管理前端、账号体系、向量库或多Agent对话，不依赖进程常驻、本地文件持久化或外部服务器。不引入Queues/R2/KV/DO作为MVP运行必需资源。调用外部LLM与可选消息API不改变Cloudflare部署约束。

| 部件 | 输入 | 输出 | 失败边界 |
| --- | --- | --- | --- |
| scheduler | scheduledTime、配置、runs | 确定ID的workflow创建请求 | create不确定时保留pending并查询，不换ID重建 |
| collectors | SourceConfig、SourceCursor | CollectionPage | 单源失败，其他源继续 |
| persistence | 页面、租约token | 不可变ItemVersion、分页checkpoint | 旧租约禁止写，未完成页不推进游标 |
| editorial | FrozenCandidate[]、历史已曝光快照 | DigestContent | 模型/结构失败降级为可核实链接列表 |
| delivery | 已提交的快照和配置引用 | accepted/rejected/uncertain/suppressed | 模糊结果不自动重发 |

Cloudflare CPU、步骤、子请求和存储额度按当前官方限制与账户计划执行，详见04。架构不依赖免费层能承载所有文章解析。[Workflows限制](https://developers.cloudflare.com/workflows/reference/limits/)

## 3. 目录及依赖方向

| 实现路径 | 职责 | 依赖 |
| --- | --- | --- |
| src/index.ts | 导出Worker handlers和两个Workflow类 | api、scheduler、workflows |
| src/domain/contracts.ts | 复制并扩充规范类型 | 无业务基础设施依赖 |
| src/config/schema.ts、load.ts | Zod校验、Secrets解析、配置快照 | domain |
| src/api/router.ts、auth.ts、idempotency.ts | 路由、鉴权、请求去重 | db、scheduler |
| src/db/schema.ts、repositories/ | 参数化SQL，所有权威状态转换 | D1 binding、domain |
| src/scheduler/time.ts、dispatch.ts、reconcile.ts | 计划时间、run登记、补偿 | repositories、Workflow binding |
| src/workflows/collect-source.ts、daily-digest.ts | 阶段编排、持久化等待 | 各业务service |
| src/collectors/rss.ts、github.ts、html.ts | 标准化来源输入 | fetch、XML |
| src/collectors/http.ts、normalize.ts | 限流、响应上限、URL规范化 | Web API |
| src/extractors/html.ts | HTMLRewriter正文提取 | Web API |
| src/llm/provider.ts、budget.ts、cache.ts | HTTP能力适配、调用记账 | repositories |
| src/editorial/filter.ts、group.ts、validate.ts、render.ts | 事件质量与呈现 | llm、domain |
| src/delivery/service.ts、runtime.ts、dummy.ts、telegram.ts、cloudflare-email.ts | outbox领取、一次外部调用、回执 | repositories、运行时渠道binding |
| migrations/0001_initial.sql | 参考schema落地迁移 | 无运行时代码 |
| config/app.json、sources.json | 非秘密配置 | 由schema验证 |
| tests/unit、tests/integration、tests/fixtures | 可重复fixture与Workers集成验证 | fixtures、test bindings |

模块只通过已定义的types和service函数通信，不在extractor里调LLM，不在LLM adapter里发消息，不在HTTP handler里同步执行全流程。D1字段使用snake_case，TypeScript使用camelCase；repository负责唯一映射。

## 4. 配置与启动校验

参考 `app.config.example.json`、`sources.example.json`、`wrangler.example.jsonc`。示例模型域名为`.invalid`且价格为null，这是防误调用的部署输入，不是可用endpoint。真实开发不能把示例配置成功解析误报为模型连接成功。

全局配置校验：

- timezone在v1仅接受Asia/Shanghai；改时区属于后续明确变更，禁止静默固定加8小时处理其他时区。
- enabled来源最多20个，source.id唯一且匹配`^[a-z0-9][a-z0-9-]{0,62}$`；intervalHours为1–24整数；priority为0–100整数。
- 只允许https来源URL，host必须出现在源allowedHosts中。github owner/repo不得为空。html_list必须有明确选择器。
- fetchTimeoutMs=15000，llmTimeoutMs=60000，decoded响应最多2MiB，清洗正文最多128KiB UTF-8。截断必须变成partial。
- 默认每源每轮最多3页×30条、最多20个新正文抓取；单实例同时HTTP最多2个；模型调用串行；阶段最多3次真实调用，repair最多1次且包含在3次中。
- 每天最多200候选、20篇精读、10个最终事件。正文送模型每篇最多12000 Unicode code points，截断不能在文本边界伪称全文。
- LLM baseUrl不可由API调用者提供；只在配置文件指定，HTTPS、不带用户名密码。只有ADMIN_TOKEN、LLM_API_KEY等Secrets可以提供认证。
- SEND_ENABLED只能解析字面`true`/`false`，不能使用Boolean("false")。true时要求APP_ENV=production，且所选渠道配置齐全：Telegram 需要合法 bot token 和正整数私聊 chat ID；兼容邮件渠道需要 EMAIL binding 和个人收件配置。
- 非秘密配置以排序键canonical JSON计算config_hash；持久化快照不含密钥，不含Webhook完整URL。正在运行的日报使用自己的非秘密配置快照；发送前仍检查实时SEND_ENABLED与APP_ENV。

生产Secrets：ADMIN_TOKEN（至少32随机字节编码）、LLM_API_KEY、可选GITHUB_TOKEN，以及 Telegram 所需 TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID；兼容邮件渠道另需EMAIL_FROM/EMAIL_TO。实际目标与outbox的destination_key校验一致；中途 chat ID 或邮件目标变化则suppressed并报CONFIG_CHANGED，不能把旧日报改发其他人。

## 5. API契约

除GET /healthz返回`{"ok":true}`外，其余接口先验证`Authorization: Bearer ADMIN_TOKEN`。401不说明token差在哪里。响应JSON及`Cache-Control: no-store`。错误统一ApiError，不回显原始供应商错误正文或Secrets。

| 方法与路径 | 请求 | 响应 | 限制 |
| --- | --- | --- | --- |
| GET /api/status | 无 | 200：lastCollectAt、lastAcceptedAt、sourceHealth、todayDigest、budgetSummary | 不返回密钥、正文或目的地址 |
| GET /api/sources | 无 | 200：来源状态列表 | URL仅公开源URL，剔除认证参数 |
| GET /api/runs/:runId | 无 | 200：RunStatus，含kind/state/phase/digestId/resultUrl/errorCode/timestamps | 不包含llm原始提示和响应 |
| GET /api/digests/:digestId | 无 | 200：mode、status、content、coverage、deliveryStatus | 仅授权访问，HTML内容已转义 |
| POST /api/collect | `{"sourceId":"hf-blog"}` | 202：RunAccepted | 必须Idempotency-Key；源必须在目录且启用 |
| POST /api/preview | `{"date":"2026-09-21"}`或`{}` | 202：RunAccepted | 必须Idempotency-Key；只读已有原文，永不发送 |

POST主体最大8KiB；sourceId必须指向一个启用来源；Idempotency-Key长度16–128，仅可打印ASCII；保存scope+key+requestHash，有效24小时。相同key与相同规范化请求返回原run；相同key不同body返回409。管理POST限额严格定义为每个UTC分钟最多5个新任务：request_keys增加minute_slot与slot_number，唯一(scope,minute_slot,slot_number)且slot_number为0–4；在同一D1 batch中尝试占用0到4的空槽并登记run，冲突重试其他槽，全满返回429。重复key匹配成功直接返回，不占新槽，不重新创建或收费。token校验在限额写入之前完成。

批次顺序先建run，再建request_keys；slot/key冲突会让整个D1 batch回滚，不留孤儿run。重复key冲突读取原hash：一致返回原run，不一致409；槽冲突但key不存在则尝试下一槽。

POST /api/collect每次仅接受一个sourceId并启动一个CollectSourceWorkflow；需要手动采集多个源时由调用端逐源请求，各用独立Idempotency-Key。每小时Cron仍批量派发所有启用源，避免为管理端批量请求引入额外父任务语义。

statusUrl为`/api/runs/{runId}`相对路径；RunStatus.phase取runs.checkpoint_json.phase或null，digestId取runs.digest_id，resultUrl在有digest时为`/api/digests/{digestId}`否则null。预览终态后通过resultUrl读取mode/content/deliveryStatus，以及已保存的renderedText/renderedHtml快照，其中包含冻结来源的原文链接；未构建时渲染字段为null。novelty没有被消耗通过D1只读查询验证。

preview date仅允许今天或过去30天；未来/无效日期422。今天的preview截止于请求创建时刻，可查看刚采集的内容；历史日期截止于目标日北京时间08:00。preview读取目标cutoff前的历史版本，不触发网络补采；首次未有内容返回带缺口说明的预览。preview具有独立digestId，不占用scheduled唯一键，不改变报道历史。scheduled日报仍固定在08:00冻结，不受preview影响。

错误码：400 INVALID_REQUEST；401 UNAUTHORIZED；404 NOT_FOUND；409 IDEMPOTENCY_CONFLICT；422 CONFIG_INVALID/DATE_OUT_OF_RANGE；429 RATE_LIMITED；503 DATABASE_UNAVAILABLE。错误中requestId由服务生成；不得返回stack。

## 6. 数据库规范与原子性

SQL完整定义在`reference/schema.sql`，共16张表，所有时间都是UTC毫秒整数，金额是整数micro-USD。NULL明确表示未知，不把未知发布时间填为抓取时间后冒充原文时间。source禁用不删除历史。所有外部字符串走prepared parameters。

| 数据域 | 表 | 必须成立的约束 |
| --- | --- | --- |
| 来源和采集 | sources、source_leases、collection_pages | 单源持有者token有效；分页提交与游标推进可重放 |
| 文章 | items、item_versions | source+external_key唯一；revision递增；ingest_key防页面重放 |
| 事件 | events、event_versions | event_key唯一；fact snapshot不变 |
| 日报 | digests、digest_candidates、digest_events | 同用户/时区/当地日期最多一份scheduled；候选冻结后不改 |
| 投递 | deliveries、delivery_attempts | 同日报/渠道/目标只一个outbox；attempt控制外部调用权限 |
| 调度/请求 | runs、request_keys | 计划job_key唯一；HTTP幂等key不能换body |
| 模型费用 | budget_buckets、llm_calls | 日/月同时预留，未知费用不释放 |

sources.cursor_json固定为对象{highWater:JSON,resume:JSON,scanStartedAt:number|null}：resume每个完整页后推进；只有完整扫描结束才推进highWater并清空resume。命中3页上限时保留resume，下一轮从该位置续扫，不能把中间位置当新的完整水位。适配器按来源实现高水位含义，RSS无分页时resume=null。

每页允许分小批暂存items/item_versions，此时collection_pages仍pending，items.current_revision不动。revision在该item全部版本中分配递增值，ingest_key控制重放。最终小型batch将page改committed、将其涉及items.current_revision切到本页版本，并更新source resume/cursor_version；这三者必须一同成功。租约失效后新owner可重新采集，旧pending版本保持不可见；哈希去重只比较current_revision指向的已提交版本，不能让孤立暂存版本阻止重新入库。

正文版本hash包括规范title、canonicalUrl、正文、quality及与事实有关的源元数据；排除fetch时间和ETag。只在新内容hash不同于当前版本时追加。A→B→A必须追加第三个revision，不能用hash全局唯一约束吞掉修订。

同一批SQL用D1 batch；禁止执行BEGIN/COMMIT实现交互事务，也不假设本地SQLite事务就是远端D1事务API。D1 batch任一statement报错会回滚整批。statement影响0行不是错误：依赖“有权写”的每条写语句必须用相同fencing条件，或设置数据库约束使失权整批失败。[D1接口](https://developers.cloudflare.com/d1/worker-api/d1-database/)

Persistence必须提供renewLease(lease, now): Promise<Lease|null>；续租以source_id+owner_id+fencing_token+expires_at>now条件UPDATE，仅延长expires_at，不改变token。acquireLease只新建或过期接管才递增token。单源领取建议有效期120秒，每次真实网络请求前续租；owner+token+未过期必须一起匹配。旧Workflow恢复时重新读取当前租约，不把旧step.do缓存的Lease当成仍有效。续租失败立即停止本轮，未完成页留待下一轮；最大3页限制不能悄悄把尚未扫描范围标为完整。

冻结候选通过item_versions.collection_run_id/collection_page_no关联collection_pages，只选status=committed且committed_at<=cutoff_at的页面，再以cutoff_at过滤item_versions.ingested_at，按每item在cutoff前的最新revision选取。页面可分小批写条目，但页面最终标记提交前，条目不能进入日报。item_versions写入时间由DB生成，不能用请求启动时间倒填。生成集合与frozen_at写入同一个batch，整个批次按digest build_generation及frozen_at IS NULL限定。重试时读取已存集合；不能重新执行动态查询后替换。

08:00前存在的metadata_only不能在08:10补到新正文后无声进入同一版事实来源；新正文是新版本，下一版使用。标题/链接降级可以使用冻结的metadata_only，禁止编写超出标题的信息。

## 7. 调度、截止和恢复

计划与实际时间分开：event.scheduledTime决定时间槽与日报日期，Clock.now()检查是否还允许调用/发送。午夜换日测试必须用UTC 23:45对应次日07:45。

cron配置：`0 * * * *`每小时采集；`45 23 * * *`晨间；`*/5 * * * *`校验遗漏和恢复。两个表达式在同一时刻命中可以造成重复事件，job_key与workflowId保持确定，数据库处理幂等。

| 本地时间 | 规则 |
| --- | --- |
| 07:45 | 为当日创建scheduled日报，发起有界补采 |
| 08:00 | 冻结前一正常成功日报截止至本次cutoff的候选，并考虑迟到/初始窗口 |
| 08:25 | 停止启动新的付费编辑调用；未就绪则夺取新的build_generation并制作降级快照 |
| 08:30 | ready且SEND_ENABLED为true时允许发送 |
| 08:35、08:40、08:45、08:50、08:55 | 补创建、查运行状态、恢复明确失败；sent/uncertain不重发 |
| 09:00及之后 | 不再开始外部发送；未送达标记expired，calling无回执转uncertain |

heartbeat在07:45–09:00内补漏当日任务，全天恢复未创建的未过期采集run与清理日志。若错过当天整个窗口，第二天只生成一份合并日报，不逐日补发。第一次窗口起点=cutoff−48小时；正常windowStart=最近sent日报的cutoff；uncertain日报的内容视作已曝光用于去重，但不声称确认送达。

旧日报生成者通过build_generation失权后不能提交新快照、覆盖ready内容或领取发送；best-effort terminate旧Workflow只用来减少资源消耗，正确性不能依赖terminate及时成功。发送领取同时校验digest.mode、generation、status、时间窗口及实时SEND_ENABLED。preview不受发送窗口影响但永不发送。

08:25编辑截止仅指真实scheduled任务；preview可以在任意时刻运行，使用创建时刻+5分钟作为运行deadline，不得把历史date的08:25当作已过期限制。

更详细状态转移与异常矩阵见05。

## 8. 模型协议与预算

提供方适配器接受LlmRequest，返回LlmResponse。v1仅支持明确验证过的OpenAI-compatible chat/completions；json_schema/json_object/none按能力显式配置。请求输出必须经过JSON解析和Zod结构校验，不能假设HTTP200就是可用结果。不自动更换供应商、不把Secrets写进请求正文。

模型只返回来源version引用，程序映射URL和id。Prompt完整模板与阶段JSON示例在`reference/prompts.md`。每阶段cacheKey=SHA256(canonical输入+stage+model+baseUrl标识+promptVersion+子模板版本+能力配置)，复用只有已结构校验通过的输出。相同输入超时后有可能已经计费；允许再次尝试时使用新call id和新预算预留，不承诺供应商只收费一次。

预算账期为UTC day/month，与日报当地日期分开。默认日限750000 microUSD，月限15000000 microUSD。预留最少1microUSD以满足账本CHECK，真实免费调用可以按0结算。输入/输出每百万token的microUSD价格必须已配置且billing范围已核实，否则禁真实LLM调用，生成链接降级版。

completeBudgeted接受BudgetedCall：invocationId稳定绑定digest/generation/原阶段/batch序号/prompt版本；attemptNo为1–3且repair沿用原阶段计数；callId=SHA256(invocationId+attemptNo)。这些身份和deadline/generation写入llm_calls，Workflow重放读取相同attempt，不自动分配新attempt。只有应用明确决定重试才递增attemptNo；预留与调用前校验当前日报generation和deadline。

请求上界成本=ceil((inputTokenUpperBound×inputRate + outputTokenCap×outputRate)/1,000,000)。输入优先provider精确tokenizer；conservative_utf8使用整个序列化messages的UTF-8字节数加固定封装余量估计，并与模型context上限核对。使用保守估计不能证明任何未知供应商的隐藏推理费已受控；pricingIncludesAllBillableTokens为false时禁止真实调用。必要时要求供应商预算/最大token上限作为额外边界。

原子预留在一个D1 batch中进行：确保日/月bucket存在；新增llm_calls，reserved_microusd通过同时检查两个bucket剩余额度的CASE计算，不足时写0触发CHECK使整个batch回滚；只有插入成功的全新call可增加两桶reserved。重放相同callId必须触发唯一冲突并回滚，之后查旧调用状态；禁止ON CONFLICT DO NOTHING后继续重复加预留。

结算使用llm_calls作为事实账本：更新某attempt状态/实际费用后，按day_bucket/month_bucket重新SUM账本生成对应bucket spent/reserved，而不是无条件加减（避免重试重复扣费）。索引已提供；个人规模每月数百调用可接受。reserved/calling/uncertain计为占用预留；succeeded/明确结算failed计实际费用；若成功返回但没有usage，则实际费用按已预留上界结算，不释放差额，并标记usage_unknown。只有确定尚未调用或供应商明确未受理的failed才按0释放。

调用超时且无输出 => uncertain继续占用预留；自动清理不能返还calling/uncertain的钱。实际费用超出预留说明价格/估计契约失效，记真实费用并停止后续LLM，不裁剪账单掩盖超额。日月边界按该attempt预留时bucket结算，不将晚回执记入新月。

## 9. 投递边界

Telegram 或兼容邮件适配器返回accepted只表示供应商受理。系统sent即“供应商已受理”，不是保证用户已经阅读。待发送快照含subject/text/html、payloadHash及destinationConfigRef；正文和hash一旦ready不再变。

原子领取将pending或到期且retryable的failed改为sending并设置新的attemptId。只有实际影响1行的进程能调用Sender。先保存delivery_attempts的calling，再发网络请求；进程在任何不确定边界中断，过期sending都转uncertain。失败分类由适配器明确证明，不能一律把5xx当未发送。

外部发送步骤设置retries.limit=0，sender禁用HTTP隐式重试。发送失败只由业务状态机决定是否重试；最多3次发送attempt，且均在09:00之前。明确失败的重试允许digest.status为delivery_failed；claim事务将其与delivery一同推进sending。人工回执对账追加到delivery_attempts.response_summary_json.audit数组，包含at、operator、action、evidenceRef、priorState和newState，不能用无记录的SQL改状态。未知结果不自动重试。延迟回执只允许匹配原attemptId的CAS补记accepted；不能让旧回执覆盖另一个attempt。

dummy/preview/SEND_ENABLED=false生成suppressed记录或不创建outbox，都不得将scheduled日报标sent，不更新已曝光历史。Telegram 仅允许配置中的正整数私聊 chat ID，单条纯文本最多4096字符；cloudflare_email兼容渠道在发送前核对允许的域名与目标地址。MVP不开放send任意内容/任意目标的接口。

## 10. 留存、性能和完成标准

运行日志默认30天；日报/发送回执365天；文章正文默认180天，但仍被保留日报或事件引用的版本不能删除；自动清理按小批次，禁止级联删除历史。source禁用保持原记录。事件去重至少查过去30天sent/uncertain快照。

响应大小、每源候选及模型次数有明确上限。200条候选不等于200次模型调用；filter批量20条，精读最多20条，group分批合并，编辑只处理已验证event卡。实际调用数必须在预算日志中可见。

“可交付应用”必须满足02所有任务与04验收；参考SQL可本地执行不等于D1已部署，Wrangler dry-run成功不等于云端定时通过。最终报告分别写已实现、已本地验证、已云端验证、已启用推送四种状态，不混为“完成”。
