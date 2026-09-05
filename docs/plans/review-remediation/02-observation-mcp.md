# B：Agent 观察接口与资源边界

当前状态：本轮卡已按约定范围验收；具体等级与未做事项见 [最终对账](final-reconciliation.md)。下文保留原验收条件。

先读 [共同约束](README.md)。先把输出变得可读、可续读，再清理内部缓存；不要反过来。

## B01

- [x] 开放有界 Artifact 读取。依赖 A05。建议 Sol。

**先读：** `packages/persistence-postgres/src/postgres-observation-repository.ts` 的 `appendOutput`、`readArtifact`；`postgres-runtime-durability.ts` 的输出事件映射；Application observation ports；ADR 0050、0051。

**实现：** 新增 Application 读取方法、RPC `artifact.read`、MCP `artifact_read` 与 capability。请求包含 sessionId、generation、artifactId、offsetBytes、maxBytes，默认 8 KiB、最大 64 KiB。以数据库中的归属关系验证范围，不能把调用方提交的 sessionId 当授权证明。返回原始已脱敏字节的 base64、实际 byte range、totalBytes（已知才给）、nextOffset、eof；MCP 可附有界解码 text，但明确边界截断规则。格式错误、越权、未发现、已过期、后端不可用分别按可证明的错误返回，不泄露他人 artifact 是否存在。

**细节：** offset 非负且不能溢出；读取 byte range 不需要先把整个 artifact 装入内存。UTF-8 多字节跨段必须可用 base64 无损重组；文本视图不能悄悄丢字。复用已有 redaction / withheld 语义，不提供“原始未脱敏”开关。若现有存储布局无法真正 range read，先限定 artifact 存储块上限并记录内部读放大，不声称流式读取。

**验收：** 产生超过 4 KiB 的输出事件，从 artifactRef 读完 7 KiB 与 1 MiB fixture，重组等于已脱敏原文；中文/emoji 在段边界不丢失；超限、越界、跨 session、过期、秘密输出均覆盖。

**验证：** 扩展 `postgres-observation-repository.test.ts`、`apps/mcp/src/mcp-stdio.test.ts` 和 RPC tests；运行 `pnpm test:m10:artifact`、`pnpm test:m10:secret`、`pnpm test:m4`。至少 L2；同时证明旧 event 返回形状不变。

## B02

- [x] 增加执行输出的连续游标。依赖 B01。建议 Sol。

**先读：** Application execution/output 查询，byte ring，events cursor，PG output artifact 模型。新增契约不能假定所有输出永久保留。

**新契约：** RPC `execution.output.read` / MCP `execution_output_read`。输入 executionId、精确 session/generation、可选 opaque cursor、maxBytes。输出 executionState、stream=`pty`、内容编码、chunks、nextCursor、hasMore、gap、retention 信息。默认 8 KiB、上限 64 KiB；JSON/base64 膨胀另算并设置传输响应上限，预算不能只约束一段 text 而让 metadata 无界。

**实现：** 用稳定输出 offset/事件顺序作游标，不用数组 index 或时间戳猜顺序。历史 durable 段与当前 live tail 衔接必须有水位，不能重复或漏字。最小正确版本可以只提供 durable 连续段，并单独报告 persistenceLag；不能把未持久化 tail 拼进去假装完整。ring 淘汰、artifact 过期、未知游标、重启后游标分别明确响应。保存/恢复游标不携带命令秘密。

**验收：** 每次 8 KiB 连续读输出大于 ring 大小的 fixture，保留期内无重复无缺失；运行中多次分页，末尾未完成时 hasMore=false 不表示 execution 完成；中途 retention 明确 gap；伪造 cursor 不越权；取消后不释放底层 execution。

**验证：** 新增 `packages/application/src/execution-output.test.ts`；扩展 PG observation、MCP tests。运行新增测试、`pnpm test:m10:output`、`pnpm test:m4`。至少真实 PTY+PG L2。响应中不虚构 stdout/stderr，也不靠正则删掉看似命令回显的真实内容。

## B03

- [x] 有界、可取消的观察等待。依赖 A05。建议 Sol。

**先读：** `packages/runtime-rpc/src/index.ts` 的 WAIT_REQUEST_TIMEOUT、wait dispatch 与 abort；MCP `execution_wait`；Application execution completion promises。

**实现：** 增加 RPC `execution.wait.v2` / MCP `execution_wait_v2`，输入 executionId、waitMs（默认 10000，0 为立即快照，最大 30000）。返回 `completed: boolean`、当前 executionState、executionId；超时返回当前快照，不抛执行失败。旧等待接口保持兼容并在说明中引导迁移。

客户端断开/AbortSignal 应从 MCP transport 经 RPC 传到 waiter，移除监听器和计时器；不得向 PTY 发送 Ctrl-C，也不结束共享 completion。多 waiter 相互独立。计时器在所有成功、失败、取消路径释放。预算计入服务端等待，不允许 router 再叠加 30 秒重复等待。

**验收：** waitMs=0 立即返回；10 秒预算用虚拟时钟验证；一个等待取消后另一个仍收到真实完成；断网等待者不泄漏；执行持续输出时等待超时仍 RUNNING；未知 execution 与 backend unavailable 不伪装未完成。

**验证：** 新增 `packages/application/src/execution-wait.test.ts`，扩展 RPC 和 MCP tests；运行该文件、`pnpm exec vitest run --maxWorkers=1 packages/runtime-rpc/src/index.test.ts apps/mcp/src/mcp-stdio.test.ts`。真实短 sleep 一次证明等待结束不影响执行，L2。

## B04

- [x] 给 Agent 提供紧凑观察视图。依赖 A06、B02、B03。建议 Sol。

**先读：** MCP `call`/结果包装、Execute/Execution 工具、domain Action/Execution。不要把内部完整记录定义为新的公开结果。

**实现：** 新增 `execution_observe` 工具，将 B02 的有界输出、B03 的有限等待组合为一次 Application observation 调用；请求含精确 execution 目标、cursor、maxBytes、waitMs。响应固定为 identity、state、output、nextCursor、gap、必要的 nextActions。nextActions 只在具体异常/阻塞时给短提示，不附整套教程。终态只来自已观察 execution completion，不根据“无新输出”猜完成。

本卡不新增写命令工具；现有 execute 接受后拿 executionId 即可调用 observe，UNKNOWN 则调用 action_lookup。旧 execution_get 保持原形状。text 与 structuredContent 如受 MCP SDK/客户端兼容要求需同时存在，保证二者是同一紧凑结果；不为减少重复破坏协议要求，也不能声称只付一份 token。

**验收：** Agent 用 execute→observe 完成短命令、用 cursor 续读长输出、有限等待长任务、核对 UNKNOWN；无需自己解析 actor capabilities 或额外 events 找输出。含 ANSI 的 raw 输出与可读 text 字段清楚区分，text 转换不抹除实际打印的命令同名行。输入敏感期观察不泄露。

**验证：** 新增 `apps/mcp/src/agent-observation.test.ts`，使用官方 MCP client 调用并断言响应 schema、预算与真实内容；运行该文件、`pnpm test:m10:secret`、`pnpm test:m4`。至少 L2。F02 再测实际调用成本。

## B05

- [x] 压缩 MCP 公共说明。依赖无。建议 Luna。

**先读：** `apps/mcp/src/server.ts` 的 instructions、24 个工具描述、现有 MCP tests。

**实现：** instructions 保留不超过 700 字符的核心规则：共享终端、精确目标、PTY_BUSY、UNKNOWN 核对、输出合并与秘密限制；工具局部只解释该工具的参数和特殊行为。中文/英文选用现有服务的语言，不为缩短字符数牺牲精确性。长教程移到仓库操作文档；若已有 MCP resources 通道可提供帮助资源，不为此额外开发资源框架。

不删工具、不改名称、不动权限、不删 schema 字段说明；新工具到位前不能让描述推荐尚不存在的名称。错误提示给最短的下一步，不反复附全局规则。

**验收：** metadata 测试验证核心约束未丢失、instructions 字符预算、工具名集合不变；记录修改前后 instructions/tool descriptions 的字符数。宿主重复展开是宿主行为，报告本端减量，不承诺宿主不复制或精确 token 节省。

**验证：** 新增 `apps/mcp/src/tool-metadata.test.ts`；运行该文件和 `pnpm test:m4`。L1 即可。文案语义人工逐项对照本卡，不用整段文字快照锁死每个逗号。

## B06

- [x] 建立历史事实持久查询和过期边界。依赖 A06、B02。建议 Sol。

**先读：** `packages/runtime-memory/src/memory-runtime-store.ts`、Application getExecution/getAction/idempotency lookup、PG facts retention；ADR 0058、0039。

**实施：** 在开始驱逐内存前，给历史 Action/Execution 读取增加 durability fallback，核对 actor/session/generation；当前活跃进程状态仍由 owner 内存负责，数据库读回不能重新注册 executor。明确完整事实、已压缩防重记录、保留期外三种状态。

幂等保护的最小决策：现有公开 key 若无可验证的年龄/epoch，就不能安全地完全忘记 key。持久模式保留当前 generation 必要的防重记录；终结 generation 可整体拒绝新执行，但还能区分历史记录过期。若要有限期 key，需另立有版本的 key epoch 协议，本卡不临时加一个“过期视为新请求”。内存模式不具备无限历史回退，B07 达容量时必须可拒绝新准入。

**验收：** 人工驱逐非活动记录后历史查询结果与驱逐前一致；同 key 重发仍命中原 action；记录 retention 后明确 expired/无法恢复，不能创建新 execution；服务重启只显示 durable 历史，不显示旧 PTY 为 READY；查询超时不伪装缺失。

**验证：** 扩展 application runtime-durability 和 PG runtime repository tests；运行 `pnpm test:m10:retention`、`pnpm test:m4:durable`、`pnpm exec vitest run --maxWorkers=1 packages/application/src/runtime-durability.test.ts`。L2。先交付此卡再允许 B07 合入。

## B07

- [x] 有界内存和完成态清理。依赖 B03、B06。建议 Sol。

**先读：** MemoryRuntimeStore 的 actions/executions/events/idempotency；RuntimeService 的 completions、started、dispatchStates 等 Map；现有 session close/drain 路径。

**实施：**

1. 建立资源清单：每个集合的 owner、增加点、结束点、删除条件、上限。区分安全可丢的缓存、尚未完成的控制状态、必须保留的防重依据。
2. completed promise、listeners、dispatch 临时状态在无活跃依赖后释放；持久模式已落盘的历史缓存按条目与字节双预算驱逐。活跃/排队/未落盘 action 不驱逐。
3. events 使用有界历史并暴露首个可用 cursor/gap。保留 B06 的防重规则；memory-only 到达不能安全释放的 key/action 容量时，用明确 capacity 错误拒绝新 action，并保留查询/控制/关闭既有会话的能力。
4. 上限可从配置注入以便小容量测试；在 ADR 中记录默认值及估算依据。不靠每次调用全量扫描全部历史维持上限。

**验收：** 用小容量配置执行数千个短 action，安全缓存条目有界、活跃 action 不丢；同 key 跨驱逐仍零重放；memory-only 满额时不继续无限增长也不让当前执行失控；等待取消/关闭后 listener 数回落。压力证据同时报集合大小和 RSS 趋势，不能把 GC 未立即回收等同泄漏。

**验证：** 新增 `packages/application/src/runtime-retention.test.ts` 和 MemoryRuntimeStore tests；运行新增文件、`pnpm test:m1`、`pnpm test:m10:retention`。L1 加隔离 daemon L2，压力观察仅声称实际运行的范围。
