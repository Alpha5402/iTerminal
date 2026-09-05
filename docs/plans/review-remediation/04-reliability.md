# D：故障范围、凭据与共享入口

当前状态：本轮卡已按约定范围验收；具体等级与未做事项见 [最终对账](final-reconciliation.md)。下文保留原验收条件。

先读 [共同约束](README.md)。此阶段不能通过放松 fencing 或绕过授权来获得“更可用”的表象。

## D01

- [x] 缩小可确定的单 session 失败范围。依赖 A01。建议 Sol。

**先读：** `apps/runtime-daemon/src/postgres-recovery-supervisor.ts`；RuntimeService 的 `reportDurabilityUnavailable`、owner failure/trip、`isOwnerDurabilityFailure`；ADR 0015、0034、0037、0042 与现有 postgres-outage tests。

**先写 ADR 故障矩阵：** 单 session 的 generation/fencing token 不匹配；owner lease 确认丢失；连接错误/数据库不可达；未知数据库异常。只有第一类且错误上下文携带可信 session identity 时进入 session-scoped 失效；其余保持现有 owner 安全策略。不要按字符串包含“lease”分类，不要把 heartbeat 的 owner 错误降为 session 错误。

**实施：** 在 repository/port 错误中保留可信 scope，Application 统一决定处理范围。单 session 失效只终结它的写准入、executor、waiters，其他会话继续原行为；旧请求的迟到错误不能破坏新 generation。保证 durable 失效记录与 inability-to-persist 情况有明确区别。

**验收：** 两个 fixture 会话，A 丢 session fence 后 A 不再写入、B 仍可 execute/control；owner lease 丢失两者都停止写；数据库失联仍触发既有防脑裂路径；未知错误不被静默忽略；恢复数据库不自动重放 UNKNOWN。

**验证：** `pnpm test:m9:fencing`、`pnpm test:m8:postgres-outage`、`pnpm exec vitest run --maxWorkers=1 packages/application/src/runtime-durability.test.ts`。新增隔离双会话故障注入测试。报告达到的具体 L2/L4 注入范围，不宣称所有 outage 可用性已解决。

## D02

- [x] 发现结果允许局部不可用。依赖 A05。建议 Sol。

**先读：** `apps/runtime-router/src/server.ts` 的 listSessions；`packages/persistence-postgres/src/postgres-runtime-owner-registry.ts` 的 owner/session 查询；`runtime-router.test.ts`。

**新契约：** `session.list.v2`，默认 50、最大 200、稳定 cursor。返回 `items`、`unavailableOwners`、`partial`、`nextCursor`；历史 session 显式 `liveAvailability` 和 durable 状态，不能把最后 READY 记录等同当前活跃。

**实施：** 对 registry 候选先做有界分页，再以受限并发查询 owner；单 owner 超时不拒绝整个列表。不能先拉全部 owner/session 再切片。历史 BROKEN session 的 owner 不在也可展示 durable metadata。generation/owner 冲突明确 unavailable/conflict，不任意选一个实时 owner。现有 listSessions 数组契约不静默改形状，新 Console 使用 capability 选择 v2。

**验收：** 一个 owner 离线、另一个在线仍返回可用会话并标 partial；全部不可用可读出历史但无法写；分页稳定且去重；registry 整体不可用不能冒充空列表；写路由保持严格唯一 owner 校验。

**验证：** `pnpm test:m9:router`、`pnpm test:m9:registry`，扩展 MCP router-routing 与 Console 列表契约。至少隔离双 owner L2。

## D03

- [x] Console 与 MCP 都支持动态 credential provider。依赖无。建议 Sol。

**先读：** `apps/mcp/src/credential-file.ts`、main、tests；`apps/console/src/main.ts`/server；RPC client grant 传递；ADR 0063、0055、0056。

**实施：** 复用现有 MCP file provider 的读取和权限校验方式，让 Console 服务端也按请求取得当前 grant，而非启动时永久冻结。明确文件与 inline 配置互斥/优先级，保留显式 inline 的兼容路径。文件只在服务端读取，不发给浏览器。

provider 输出需要绑定相同 principal/actor/scope；不能借文件内容任意提升现有 Console 身份。原子替换中短暂读失败返回具体认证不可用，不静默回退过期 token；已有请求用开始时绑定的 credential 完成，下一请求用新 credential。

**验收：** 在进程不重启条件下替换文件，下一请求使用新 grant；坏权限、畸形内容、过期内容被拒绝且无秘密日志；已有 PTY 与会话 identity 不变；MCP 原有 credential-file tests 保持通过。

**验证：** 扩展 Console provider tests 和 `credential-file.test.ts`；运行 `pnpm exec vitest run --maxWorkers=1 apps/mcp/src/credential-file.test.ts apps/console/src/server.test.ts packages/runtime-rpc/src/index.test.ts`、`pnpm test:m10:credentials`。L1+独立服务 L2。

## D04

- [x] supervisor 自动续期本地凭据。依赖 D03。建议 Sol。

**先读：** `apps/local-stack/src/credentials.ts`、server/processes/main、RPC issuer；ADR 0059、0063。

**实施：** 本地 supervisor 负责同身份、同权限续签并原子替换私有文件；MCP/Console bootstrap 默认引用文件路径。刷新时刻以 expiresAt 和提前量计算，计划默认提前 5 分钟，短 TTL 测试按比例提前；失败采用有界退避且不超过到期后仍假装有效。启动/退出/重复启动释放刷新定时器，文件写入沿用安全权限与 symlink 防护。

保留签发方密钥边界，不把 issuer 能力交给普通 agent。刷新不重建 daemon/PTY，不重启 Console/MCP；过期后明确只拒绝无效授权的请求，不能靠重置会话解决 token 问题。时钟漂移和 supervisor 已停分别显示实际状态。

**验收：** 短 TTL 下真实进程经历至少两次续期，Session/generation/Shell PID 不变，之后 Execute/Input 仍授权成功；刷新失败跨过期后拒绝写，再恢复刷新可继续合法请求；检查所有配置/日志无 token 内容。使用假时钟覆盖定时分支，真实短 TTL 覆盖端到端。

**验证：** `pnpm test:m10:local`、`pnpm test:m10:credentials`；新增 local-stack refresh integration。至少 L2，若同时通过 Console/MCP 共用会话续期则可记具体 L3。更新 local-quickstart，删去“必须重启 stack 才能续期”的过时指引，保留显式 inline 的限制说明。

## D05

- [x] 每个配置的 Agent 有明确身份。依赖 D04。建议 Luna。

**先读：** local-stack MCP bootstrap、`apps/mcp/src/main.ts` actor 配置、capability profiles、授权矩阵。

**实施：** 支持显式 agent name/id 的独立 bootstrap 配置与凭据文件，同名配置重启身份稳定，不同配置不共用 `agent-local`。验证名称长度/字符并避免目录穿越；不能每次工具调用随机生成新 actor。默认单 Agent 安装可保留兼容名字，但多实例必须能清楚区分。

不拓宽默认 capability profile；UI/审计显示该可信 actor，不能信任调用 body 中自称的名字覆盖 credential actor。文档明确“身份不同”尚不等于 session ACL 或多租户隔离。

**验收：** A/B 两个配置产生各自 Action actor；A 无法用 body 冒充 B；刷新与重启后 A identity 稳定；私有文件无互相覆盖；旧单 Agent 配置仍工作。

**验证：** `pnpm test:m10:local`、`pnpm test:m10:authorization`、`pnpm test:m4`。L1 加真实两个 MCP client L2。session ACL 仅由 F03 设计，不在本卡实现。

## D06

- [x] CLI 默认连接共享 daemon。依赖 A05、B03。建议 Sol。

**先读：** `apps/cli/src/main.ts` 的 MemoryRuntime 初始化与 requestChain；`packages/runtime-rpc/src/index.ts` UnixRuntimeClient；MCP main 的 socket/grant/actor 配置；CLI 现有文档。

**实施：** 默认 CLI 成为经过认证的 gateway 客户端，启动时握手并提供缺配置的清晰错误。原 standalone 模式移为显式 `--standalone` 开发选项（计划新增参数），不默认再创建独立 Runtime。使用同一 Application Action API，CLI 请求不能自授 capabilities。

若当前是 JSONL 请求/响应，保留并补 request id：长 read/wait 不阻塞后续 control/input；受限并发处理读等待，写入顺序仍交给 Application。错误响应带对应 id，EOF/断线取消本客户端等待，不能关闭共享 session。只有显式 close 请求关闭会话。

**验收：** CLI 列出 daemon 中已有 session；CLI Execute 后 MCP/Console 看到同 execution；一个长 wait 期间下一条 Control 可处理；两个返回可按 id 匹配；CLI 退出后 PTY 仍在；未授权、旧版本、daemon 不可达错误清楚。

**验证：** 新增 `apps/cli/src/shared-runtime.test.ts`，真实启动 CLI 子进程与独立 daemon；运行该文件、`pnpm test:m4:durable`、`pnpm test:m10:authorization`。至少 L2，Console/MCP 联合验证为 L3。更新 CLI 示例与配置说明。

## D07

- [x] 提供全局待审批视图。依赖 A05、D02。建议 Sol。

**先读：** Console `pendingApprovals`/pendingCount/current-session effect；Application approval query/decide；ADR 0049、0056。

**实现：** 新增 authenticated `approval.pending.list` 有界分页，默认 50、最大 200。返回当前调用方可读/可决策范围内的 pending approvals 与所属 session、generation、版本，不开放无权限全局查询。router 聚合必须继承 D02 的 partial/unavailable 语义，计数不完整时显示“至少 N / 部分不可用”，不能显示假精确总数。

Console 主入口显示跨会话审批数量与列表，点击定位对应会话。使用一个受限刷新/订阅入口，不为每个 session 创建高频 poll；切会话不重置全局 pending 信息。审批详情展示原请求的冻结内容，决定提交带已有 expectedVersion，冲突后刷新，不自动重试 approve。

**验收：** A 当前、B 有待审批时仍提示；B 状态变化/过期后数量正确；两个 Human 同时决策一条只能一次成功；隐藏/越权会话不泄露；坏 owner 不让健康 owner 的审批消失；无审批行为由读请求触发。

**验证：** `pnpm test:m10:approval`、`pnpm test:m9:router`、`pnpm test:m5:browser`。新增双会话 browser 场景，达到 L3。
