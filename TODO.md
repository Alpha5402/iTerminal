# iTerminal — Human-Agent Shared Terminal Runtime PLAN / TODO

> 状态：Implementation Baseline v5.9 — M5 shared path 与 M6.6 controlled geometry 已通过 Browser Human + official MCP Agent L3；M6.7 bounded TerminalState 与 M7.1 versioned checkpoint fork 已通过 real PTY/official MCP L2；M0–M4.1、M6.5 与 M8.9 后端路径保持 L2，M4 autonomous-model L3 仍待显式授权
>
> 基线日期：2026-08-30
>
> 当前仓库状态：M0–M4.1 已实现并保存 L2 证据；live Runtime 已接入 PostgreSQL write-ahead journal、bounded ingest loop、versioned dynamic ANSI/VT Virtual Screen，以及 generation-scoped Input Policy/Interaction Guard。M5/M6.6 增加 loopback Human Console 与受控 ResizeAction：真实无头 Chrome Human 和 official MCP SDK Agent 已在同一 PostgreSQL/zsh Session 中共享 cwd/env/Python REPL，并分别驱动同一 PTY 的 SIGWINCH。M6.7 增加不可作为安全事实的 exact-generation `terminal_state`。M7.1 增加 Shell READY control-channel checkpoint、运维 exact allowlist env、version/hash/CAS/staleness、cwd containment、PostgreSQL `session_forks`/child lineage/idempotency 与 `session_checkpoint|session_fork` MCP；真实 bash/zsh 中 READY/RUNNING/BROKEN parent 可重建独立 child，不复制 process/REPL/editor/alias/function/trap，也不隔离共享 workspace 文件。M8.9 已证明 queue-driven owner-local Execute、Input/Control 写后 owner 崩溃不重放、DB/AMQP 恢复与真实三节点 RabbitMQ quorum leader failover。Browser fork UX、新 daemon hydrate 历史 BROKEN parent、Autonomous model 授权、更广 TUI/跨浏览器/style parity、daemon restart 后 durable wait、Approval/secret、非对称分区、long soak、M9 fencing、多 Worker 与完整 MVP/L4 仍未完成。
>
> 一句话定义：构建一个 Human 与 Agent 对等协作的共享终端 Runtime；每个 Session 拥有一个真实、持久的 PTY 与 Shell，所有 Actor 通过结构化 Action 操作同一份 cwd、env、Shell 与 foreground process 状态。

---

## 0. 本轮调整评估结论

本版接受并替换上一版的核心产品模型：

- 从“每个 Actor 有独立 Context”改为“同一 Session 的 Actor 共享一个真实 Shell Context”。
- 从“Command Mode + Interactive Mode”改为“所有 Shell 操作都发生在同一个 Persistent PTY”。
- 从“Session 内命令排队”改为“单 Session 单 active ExecuteAction；忙时立即返回 `PTY_BUSY`”。
- 从“新建 Lane 并行”改为“需要独立/并行环境时显式 `fork_session`”。
- 将 Execute、Input、Signal/Control 统一为结构化 Action，经同一 Application Service 仲裁、审计和持久化。
- Shell 状态由真实 Shell 持有；Runtime 只通过 Shell Integration 观察，不模拟 cwd/env。

以下技术点不能原样照搬，本文已修正：

1. **PTY 通常只有一个合并输出字节流。**不能可靠地把它重新拆成 stdout/stderr；事件类型使用 `pty_output`，只有非 PTY 旁路执行才可能保留 stream 来源。
2. **EOF 不是 POSIX signal。**`SIGINT/SIGTERM` 属于 process signal；`Ctrl+C/Ctrl+D/EOF` 属于 TTY key/control bytes，Action schema 必须区分 delivery mode。
3. **原子 `pty.write()` 只防止字符级混写，不防止语义竞争。**InputAction 仍需 target execution、screen version 与短期 Interaction Guard。
4. **PTY/Shell 是当前 live state 的事实源，PostgreSQL 是 durable accepted/observed facts 的事实源。**Runtime crash 后不能从数据库假装恢复同一个 PTY。
5. **Lease/Fencing 不能迁移内核 PTY。**Session owner Worker 丢失时，旧 generation 进入 `BROKEN/UNKNOWN`；只能从 checkpoint 创建新 generation。
6. **Shell marker 可能被命令输出伪造。**优先使用独立 control channel；若使用 OSC/DCS，必须带 session nonce、严格 parser 和信任边界说明。
7. **`fork_session` 只能复制可重建的 Shell Checkpoint。**不能复制 foreground process、REPL memory、数据库事务、vim buffer、socket 或 file descriptor。

上述模型已经成为实现基线；各里程碑的真实完成范围仍以 `docs/verification/` 中的证据与 `Not proven` 边界为准。

### 0.1 对 2026-08-30 Final PLAN 调整稿的合并结论

本次调整稿没有推翻现有领域模型。以下内容接受并强化：

- Human/Agent 共享一个 Persistent PTY/Shell，所有写操作经过 Action Service。
- Execute 忙时 fail-fast，Input/Control 命中当前 foreground Execution；独立工作显式 fork。
- Human 使用实时高带宽观察，Agent 使用 pull-based、selective、bounded Observation。
- Human 在 READY 使用 command composer，RUNNING 才进入 interactive input。
- Snapshot 只是 Observation/cache；fork 只复制可重建 Shell Context；不确定副作用进入 `UNKNOWN`。

以下内容不合并或按当前实现契约修正：

1. 调整稿中的 Phase 0–9 是概念路线，不是当前进度表；不得把已有 L2 实现重置为未完成。
2. 继续使用 `ControlAction`，不退回 `SignalAction`；它必须区分 TTY control bytes 与 process-group signal。
3. 保留 `STARTING`、Action/Execution 分离与 generation 边界，不把生命周期压缩成单一 Session 状态。
4. PTY 事件继续使用合并的 `pty_output`，不持久化虚构的 stdout/stderr 归属。
5. durable truth 只使用 PostgreSQL；不新增 SQLite 与 PostgreSQL 双后端兼容成本。
6. 原子 input batch 只解决字节交织，不能解决语义竞争；保留 target execution、screen freshness 与短期 Interaction Guard。
7. MCP 工具按已实现能力注册；不提前暴露 fork/search 等空壳，也不在没有版本迁移 ADR 时重命名已发布工具。
8. RabbitMQ/M8 虽已先行达到部分 L4 故障证据，但不会替代尚缺的 M4 autonomous-model L3、M6 完整交互矩阵与其余 MVP Exit Gate；M5 Browser/MCP shared path 已单独达到 L3。

---

## 1. 如何使用这份 TODO

- [ ] 复选框只有在对应证据保存后才能勾选；“代码已写”或“构建通过”不能替代场景验收。
- [ ] 每个里程碑通过 Exit Gate 后才能开始依赖它的下一阶段。
- [ ] 每个 PR 完成一个可回滚的垂直切片，并同时更新测试、协议、迁移、文档与验证记录。
- [ ] 改变 Action、Session、Execution、Shell Integration、并发、失败或权限语义时，必须先更新 ADR。
- [ ] 验证记录保存到 `docs/verification/<milestone>/<date>.md`，包含环境、命令、结果、失败项与产物。

### 1.1 验证等级

| 等级 | 含义                                         | 可声明范围       |
| ---- | -------------------------------------------- | ---------------- |
| L0   | 文档、静态审阅、状态机推演                   | 设计已定义       |
| L1   | 单元、属性、协议契约测试                     | 局部语义通过     |
| L2   | 真实 PostgreSQL、PTY、Shell 与本机集成       | 本地链路可运行   |
| L3   | 真实 Human Console + 真实 MCP Agent 协作路径 | MVP 用户场景可用 |
| L4   | 故障注入、跨平台、压力、安全与持续 dogfood   | 发布候选         |

MVP 至少达到 L3；v1.0 必须达到 L4。

---

## 2. 产品目标、用户与非目标

### 2.1 核心问题

项目不以“让 Agent 可以执行 Shell Command”为终点，而要回答：

> Human 与 Agent 如何可靠地共同操作一个持续变化、有隐式状态、可能运行交互程序的真实终端环境？

核心价值：

1. Human、Agent、Scheduler、System 都是一等 Actor，不存在永久 owner/takeover/release 状态。
2. 同一 Session 的所有 Actor 看到并改变同一个真实 cwd、env、Shell 与 foreground process。
3. Actor 不直接绕过 Runtime 写 PTY；每次操作都形成结构化 Action、状态与事件。
4. Action 被接受不等于执行成功；Runtime 明确区分 accepted、delivered、running、completed、failed 与 unknown。
5. Human 获得高带宽实时终端；Agent 获得有界、可寻址、可做新鲜度校验的 Observation。
6. 无法证明副作用结果时进入 `UNKNOWN`，不以自动重试制造二次副作用。

### 2.2 首批目标用户

- 希望与 Coding Agent 操作同一个真实终端上下文的本地开发者。
- 需要在 Agent 卡在密码、REPL、TUI 或长任务时直接协助的 Human Operator。
- 需要 Action attribution、持久事件、按需日志与失败解释的 Agent Harness 开发者。
- 后续希望接入 Scheduler 或 remote executor，但不希望把终端语义散落在各 transport 中的平台团队。

### 2.3 MVP 成功场景

- Agent 执行 `cd packages/web`，Human 随后执行 `pwd`，得到同一共享 cwd。
- Human 执行 `export DEBUG=1`，Agent 随后执行 `echo $DEBUG`，得到 `1`。
- Human 与 Agent 同时 Execute，只有一个 CAS 成功，另一个立刻获得包含当前 execution 的 `PTY_BUSY`。
- Human 启动 `psql`，Agent 通过 InputAction 操作同一连接；输入归属与顺序可审计。
- Agent 基于旧 execution/screen 发送输入时获得 `EXECUTION_CHANGED` 或 `SCREEN_CHANGED`，不误写新程序。
- 10 万行 PTY 输出不会无界进入 Agent 上下文；Agent 可按 execution、sequence、time、keyword 查询。
- Worker 在写入 `npm publish` 后崩溃时，Execution 进入 `UNKNOWN`，不自动再次写入。
- Human Console 与 MCP Client 断线重连后，可从 durable cursor 恢复已持久化事实，并明确标示 live gap。

### 2.4 MVP 明确不做

- 通用 SSH/远程运维、多主机广播、文件传输、端口转发。
- Docker/Kubernetes 编排、多区域、PTY/进程跨 Worker 或跨主机迁移。
- Redis、Kafka、Embedding/Semantic Search、CRDT。
- Exactly-once shell/input delivery 承诺。
- 完整 PTY clone、REPL memory clone 或任意 Shell 状态序列化。
- 自动理解 psql/python/vim 的业务协议；只提供 screen/state heuristic。
- 依靠 prompt 字符串或“输出安静了”判断命令完成。
- 把命令规则/审批称为 OS sandbox。
- Windows 原生 ConPTY 首发支持；MVP 先支持 macOS 与 Linux。

---

## 3. 竞品借鉴与差异化

> 竞品能力来自 2026-08-28 的官方 README/文档快照；实现阶段应刷新。

| 项目                                                                | 借鉴                                                                  | iTerminal 的明确差异                                                                      |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [fzxbl/terminal-mcp](https://github.com/fzxbl/terminal-mcp)         | 真实 PTY、Shell boundary、Human 可见、按需探索大输出、审计回放        | 不以 Agent 驾驶/Human takeover 为主模型；所有 Actor 经统一 Action Runtime 协作            |
| [kessler-frost/imprint](https://github.com/kessler-frost/imprint)   | shared terminal、screen text、wait stable、真实 TUI E2E、像素观察思路 | 核心不依赖 tmux/浏览器截图；先建立 Action/Event/Execution 与 VT Screen 领域语义           |
| [Zw-awa/ssh-session-mcp](https://github.com/zw-awa/ssh-session-mcp) | Actor 标记、input policy、危险状态写入保护、自动清理                  | 本地 Persistent Shell 状态共享优先，不是 SSH wrapper；忙时 fail-fast + fork，而非无限队列 |
| [tddh/clum](https://github.com/tddh/clum)                           | 审计链、terminal state、凭据隔离、远程 owner/bridge 思路              | 不做远程运维大工具面；v1 聚焦单 Workspace 的共享终端正确性                                |

差异化验收：

- [ ] 同 Session 共享真实 Shell Context 达到 L3。
- [ ] Action attribution + target execution + screen freshness 达到 L3。
- [ ] `PTY_BUSY -> wait/input/control/fork` 的结构化冲突恢复达到 L3。
- [ ] Persistent Shell crash/owner loss 不伪装为可恢复 Session。
- [ ] Agent 大输出按需寻址，不依赖对全量日志做 LLM summary。

如果以上五项少于四项通过 L3，应重新评估定位，而不是继续堆远程/编排功能。

---

## 4. 不可破坏的领域契约

### 4.1 Session-centric

```text
Session generation N
  └── ONE Persistent PTY
       └── ONE Persistent Shell
            └── ZERO or ONE Foreground Execution
```

- 一个 Session generation 只有一个真实 PTY、一个 Shell、一个有效 Executor owner。
- 同一 Session 的 Actor 共享 Shell state；需要隔离或并行时创建新的 Session。
- `fork_session` 创建新 Session/generation，不是复制旧 PTY。
- Persistent Shell/PTY 丢失后，旧 generation 永远不会“复活”；恢复会创建新 generation 并保留 lineage。

### 4.2 Actor 对等

Actor 类型：`human | agent | scheduler | system`。Actor 身份影响审计、capability、approval、优先级与输入策略，但不形成全局 `current_owner`。

每个写 Action 必须记录：

- actor identity/type；
- authenticated principal/client；
- session/generation；
- idempotency key 与 request hash；
- accepted/rejected policy result；
- target execution/screen precondition（如适用）。

### 4.3 Communication 与 Execution 分离

API/MCP/WS 成功只表示 Action 已接受或已拒绝，不能把 transport response 当成 foreground program result。

```text
Human Console ─┐
               ├─> Action Service -> PostgreSQL -> Session Executor -> PTY
Agent MCP ─────┘                         |
                                          -> Event/Screen Projection
```

所有 transport 调用同一 Application Service；WebSocket、MCP、HTTP 不得直接持有 PTY 写权限。

### 4.4 Live truth 与 durable truth

- PTY/Shell 是当前 live process state 的事实源。
- PostgreSQL 是已接受 Action、观察到的 Execution/Event、Snapshot、Approval 与 ownership 的 durable truth。
- Snapshot 是带 `observed_at`、generation、confidence 的 cache，不等同于 Shell 本身。
- Runtime 只能陈述它观察到的事实；没有 marker/exit/owner 证据时必须用 `UNKNOWN/BROKEN`。

---

## 5. Action、Execution 与 Session 状态模型

### 5.1 三类核心 Action

```text
SessionAction = ExecuteAction | InputAction | ControlAction
```

#### ExecuteAction

语义：请求当前 Persistent Shell 执行一段新的顶层 Shell input。

最小字段：

- `action_id`, `session_id`, `session_generation`
- `actor_id`, `actor_type`
- `command`（显式 Shell grammar，不伪装为 argv exec）
- `idempotency_key`, `request_hash`
- `status`
- `execution_id`
- accepted/started/finished time、exit code、event range

状态：

```text
ACCEPTED -> DISPATCHING -> RUNNING -> COMPLETED
                          |          -> FAILED
                          |          -> INTERRUPTED
                          -> UNKNOWN
ACCEPTED -> CANCELLED（尚未写 PTY 前）
```

`COMPLETED` 表示 Shell Integration 观察到 command end；exit code 可以非零。`FAILED` 表示 Runtime/Shell integration failure，而不是简单等同于非零 exit code。

#### InputAction

语义：向当前 foreground execution 写入一个不可拆分的 input batch。

必须字段：

- `target_execution_id`
- `session_generation`
- `data` 或结构化 key batch
- 可选 `expected_screen_version`
- `idempotency_key`, `request_hash`

状态：

```text
ACCEPTED -> DELIVERED
         -> REJECTED
         -> UNKNOWN
```

`DELIVERED` 只表示 Runtime 成功调用 PTY write；不表示 foreground application 已理解、接受或完成该输入。

#### ControlAction

语义：显式选择 TTY control bytes 或 process-group signal。

```text
TTY_CONTROL: CTRL_C | CTRL_D | CTRL_Z | ESC
PROCESS_SIGNAL: SIGINT | SIGTERM | SIGKILL | SIGTSTP | SIGCONT
```

- TTY control 写入 PTY input；process signal 调用 `killpg`/平台等价能力。
- `CTRL_D` 只有在终端 line discipline/foreground program 的具体状态下才可能表达 EOF，Runtime 不把“已写 Ctrl+D”误报成“程序已收到 EOF”。
- 两条路径可能产生不同程序行为，事件必须记录 delivery mode。
- `SIGKILL` 仅限授权的强制终止流程，不作为普通 Agent 工具默认选项。

### 5.2 Action 与 Execution

- Action 是 Actor 的不可变请求与审计单元。
- Execution 是 ExecuteAction 被 Session Executor 实际写入并由 Shell Integration 跟踪的一次运行事实。
- MVP 中一个 ExecuteAction 最多对应一个 Execution；任何人工 retry 都创建新 Action，并用 `retry_of_action_id` 建 lineage。
- 相同 idempotency key + 相同 request hash 返回原 Action；相同 key + 不同 hash 返回 `IDEMPOTENCY_KEY_REUSED`。
- 对写入是否发生不确定的 Action，禁止在同一 Action 下重发 command/input。

### 5.3 Session 状态机

```text
STARTING -> READY -> RESERVED -> RUNNING -> READY
    |        |          |          |
    |        |          |          -> BROKEN
    |        |          -> READY（确定未写 PTY）
    |        -> CLOSED
    -> BROKEN -> CLOSED / REBUILD_AS_NEW_GENERATION
```

- `STARTING`：PTY/Shell 创建中，Shell Integration 尚未证明 ready。
- `READY`：可以 CAS 接受一个 ExecuteAction。
- `RESERVED`：Action 已持久接受，尚未证明 command 已开始。
- `RUNNING`：已观察到 active Execution；ExecuteAction 不区分 batch/long-running/interactive。
- `BROKEN`：Shell/PTY/owner/control protocol 已丢失或结果不可信。
- `CLOSED`：显式终态。

### 5.4 Execute 并发与 Busy

同一 Session 同时最多一个 active ExecuteAction。接受 Execute 的事务必须对 Session 做 CAS：

```text
READY -> RESERVED
```

竞争失败立即返回：

```json
{
  "code": "PTY_BUSY",
  "active_execution_id": "exec_101",
  "available_actions": ["wait", "send_input", "control", "fork_session"]
}
```

- MVP 不提供 Session 内无限 Execute Queue。
- Client 可以 wait、与当前 Execution 交互、Control/Interrupt，或 fork 新 Session。
- `PTY_BUSY` 请求默认不创建 ExecuteAction；可写入轻量 rejected audit event，避免 Action 表被轮询污染。

### 5.5 Input 并发与 Interaction Guard

Runtime 为所有 accepted Action 分配 Session Action Sequence。每个 InputAction payload 以一次不可拆分 write 提交，但这只保证字节不交织。

进一步规则：

- `target_execution_id` 必须等于当前 active execution，否则 `EXECUTION_CHANGED`。
- Input/Control 默认只允许命中 `RUNNING` Session 的 active execution；READY 状态必须提交 ExecuteAction。
- Agent 配置要求 fresh screen 时必须携带 `expected_screen_version`，不相等返回 `SCREEN_CHANGED`。
- 默认 `human_guarded`：Human 正在形成 raw interaction batch 的短窗口内，Agent input 暂缓或返回 `INPUT_GUARDED`。
- 支持 `common | human_guarded | human_only | agent_only`，策略变化形成事件；不把策略称为 Session ownership。
- Guard 必须有 actor、reason、TTL、续租上限；Human emergency ControlAction 可按权限绕过。
- Human 在 `READY` 使用独立 command composer，Enter 后提交 ExecuteAction；在 `RUNNING` 才发送 Input/Control，避免绕过 Execute 仲裁。

### 5.6 Stale protection

任何写 PTY 的请求至少校验：

```text
session_id
session_generation
target_execution_id（Input/Control）
expected_screen_version（需要 fresh screen 时）
```

错误码：`SESSION_GENERATION_CHANGED | EXECUTION_CHANGED | SCREEN_CHANGED`。Human 默认可不带 screen precondition，但仍必须命中当前 generation/execution。

---

## 6. Persistent Shell 与 Shell Integration

### 6.1 基本原则

- 每条 ExecuteAction 不得用新的 `spawn(command)` 或 subshell 隔离，否则 `cd/export/source/nvm/conda` 状态会丢失。
- ExecuteAction 必须在 Session 的真实顶层 Shell 中执行。
- 不使用 prompt 字符串、静默时间或 stdout 结束猜测 command completion。
- 首发 Shell：bash + zsh；fish/PowerShell 延后并需要独立 adapter/ADR。
- 后台化命令（`&`、`nohup`、daemonize）MVP 不保证生命周期追踪；UI/文档明确建议使用新 Session，而不是把后台进程藏在同一 Shell。

### 6.2 Integration 必须观察的事实

- Shell ready。
- Action/Execution start。
- Command end 与 exit code。
- 当前 cwd。
- Shell pid、foreground process group/pid（平台允许时）。
- Session generation 与 integration protocol version。

### 6.3 Control protocol 方案门

M0 必须对两种方案做 spike 并形成 ADR：f

1. **独立 control FD/channel（优先）**：Shell hooks 向 Runtime 专用 channel 写 framed messages；PTY 只承载用户可见 bytes。控制 FD 应 close-on-exec，避免普通 child process 继承；Shell builtin hook 仍可写入。
2. **Authenticated OSC/DCS fallback**：marker 带不可预测 session nonce、length framing、严格 parser；从 Human rendering stream 中剥离。

验收要求：

- [x] 普通 command 输出仿造 marker 不会结束别的 Execution。
- [x] command 输出被任意 chunk boundary 切割仍可正确解析。
- [x] 多行 command、empty command、syntax error、nonzero exit、Ctrl+C 都能闭合状态机。
- [x] `cd/export/source` 在真实 Shell 中持久生效。
- [ ] `ssh/su/docker exec` 等 shell switch 在 MVP 可以明确标记 unsupported/broken，不得静默误判。
- [ ] Shell rc/theme/prompt 不影响 boundary；Runtime hook 在用户 rc 后重新安装并校验。

### 6.4 Shell 启动策略

- 提供 Runtime-managed clean profile，保证 integration 可预测。
- 可选 source 用户 shell rc，但必须在之后重新安装 hook；用户 rc 被视为同用户权限代码，不是安全隔离对象。
- 记录 shell executable、version、argv、integration version；不持久化敏感 env 原文。
- Shell Integration 自检失败时 Session 停在 `STARTING/BROKEN`，不得返回 READY。

### 6.5 Checkpoint

每次 `SHELL_READY` 后可以生成 best-effort checkpoint：

- cwd realpath；
- shell executable/type；
- workspace root；
- 经过 allowlist/denylist 与 secret policy 的 exported env；
- checkpoint version、source generation、observed time。

Checkpoint 不包含 alias、function、trap、job table、REPL memory、file descriptor 或进程树。它只服务 fork/rebuild，不能宣称完整 Shell snapshot。

---

## 7. Observation、Event 与 Virtual Screen

### 7.1 两种 Observation

- `SessionEvent`：append-only 历史，回答“发生了什么”。
- `VirtualScreen`：PTY bytes 投影出的 materialized view，回答“现在看起来是什么”。

Human 默认消费实时 PTY bytes +结构化 Action/Event metadata；Agent 默认 pull bounded events/screen，不订阅无界 stream。

### 7.2 Event 最小集合

- Session：created、shell_starting、shell_ready、broken、rebuild_started、closed。
- Action：accepted、rejected、dispatching、cancelled。
- Execution：started、completed、failed、interrupted、unknown。
- Interaction：input_delivered/rejected/unknown、control_delivered/rejected、policy_changed、guard_acquired/renewed/released/expired。
- Terminal：`pty_output`、screen_changed、cwd_observed、foreground_observed、resize_applied。
- Reliability：owner_acquired/lost、outbox_published、delivery_ambiguous。
- Security：policy_denied、approval_requested/granted/expired、secret_input_completed/cancelled。

PTY output 以 4–16 KiB 或 50–100 ms 聚合为 chunk；具体阈值通过 benchmark 决定。Event payload 默认不存 secret 原文，大内容只保存 artifact ref/metadata。

### 7.3 Event 序号

- `action_sequence`：Session 内 accepted Action 的单调序号。
- `event_sequence`：Session generation 内持久事件的单调序号。
- API cursor 必须携带 scope/generation，禁止把旧 generation cursor 当成新 live stream cursor。
- Live buffer 丢失时返回 `RESYNC_REQUIRED`，从 durable event + screen snapshot 恢复；不得静默跳过。

### 7.4 Virtual Screen

```text
PTY bytes -> ANSI/VT parser -> versioned screen buffer -> full/diff/region/search
```

最小字段：generation、screen version、rows/cols、cursor、alternate buffer、content、observed time。

- Agent 读取 normalized screen text，不直接消费大坨 ANSI。
- Human xterm.js 与 headless parser 必须用同一 canonical geometry 做 fixture 对照。
- TerminalState 如 `shell_ready | running | editor | pager | password | confirm | repl | unknown` 必须带 confidence/evidence，只作为辅助观察，不作为唯一安全依据。
- Pixel screenshot/diff 是 v1.x 扩展，用于颜色、布局、对比度等 text screen 无法判断的 TUI QA。

### 7.5 有界 Agent Observation

- execution metadata 默认只返回 status、exit code、event range、byte count、tail preview/ref。
- query 支持 after/before sequence、time、execution、type、limit。
- search 首版使用 PostgreSQL trigram/FTS，不引入 Embedding。
- 所有结果有服务端 hard limit、truncated 标记、next cursor/ref。
- 10 万行 fixture 下，Agent 必须只靠 query/search 找到稀疏错误，不读取全量。

---

## 8. fork_session 的准确语义

`fork_session(parent)` 创建一个新的、独立的 Session 与 Persistent PTY；准确语义是 fork/rebuild shell context，不是 clone process state。

继承：

- workspace root；
- 最近有效 checkpoint 的 cwd；
- shell type/config profile；
- policy 允许的 exported env；
- parent session/generation/checkpoint lineage。

不继承：

- active/foreground/background process；
- Python/Node/psql REPL memory/transaction；
- vim unsaved buffer；
- socket、file descriptor、job control；
- alias/function/trap 等未纳入 checkpoint 的隐式状态。

规则：

- [x] parent `READY` 时重新 certify Shell observation、checkpoint version +1 后 fork（M7.1 L2）。
- [x] parent `RUNNING/BROKEN` 时只能使用最近一次 READY checkpoint，必须 `allowStale` 明示确认，结果返回 age/status/staleness（同 owner L2）。
- [x] checkpoint 缺失、version 变更、cwd 不存在/逃逸时返回结构化错误，不默默 fallback 到 workspace root。
- [x] fork 创建 attributed request/ready/failure Events、immutable child lineage 与新 Session generation；durable admission 失败不推进 parent checkpoint/不留 child，child 启动失败只留下已 admission 的 checkpoint/audit，不改变 parent PTY/Execution。
- [x] 同一 workspace 的文件系统仍然共享；fork 不是 git checkout/worktree 隔离。

---

## 9. 持久化模型

### 9.1 核心表

- [x] `sessions`：status、current generation、workspace root、shell profile、active execution、next action sequence。
- [x] `session_generations`：owner、PTY/Shell metadata、integration version、started/broken/closed reason。
- [ ] `actors` / `session_actors`：identity、type、capability、display metadata。
- [x] `actions`：kind、immutable payload、actor、sequence、idempotency key、request hash、status；fork 另由 actor-scoped `session_forks` 记录 idempotency 与 child lineage。
- [ ] `executions`：execute action、generation、owner、write/start/end state、exit/outcome/unknown reason 已完成；fencing 待 M9。
- [x] `session_events`：generation、event sequence、action/execution/actor、type、payload/ref、created time。
- [x] `session_snapshots`：cwd、foreground observation、last exit、screen version、confidence、observed time。
- [x] `shell_checkpoints`：versioned workspace/cwd/shell/operator-allowlisted env/hash/observed time；READY 更新与 stale 选择已完成 M7.1。
- [ ] `screen_snapshots`：geometry/cursor/content or artifact ref、screen version。
- [x] `interaction_guards`：generation-scoped policy、guard actor/reason/TTL/renewal、state version。
- [ ] `approvals`：exact action hash、actor/approver、expiry、one-time use。
- [x] `outbox`：`ExecutionReady`、leased claim、confirm publish、mark/retry 与 publish Event。
- [x] `consumer_inbox`：payload hash、processing lease、attempt/outcome 与完成去重。
- [ ] `artifacts`：大输出 metadata/hash/size/retention 已完成；录制/导出待 M10。
- [ ] `worker_registry` / `session_leases`：M9 才引入。

### 9.2 关键约束

- [x] `UNIQUE(session_id, action_sequence)`。
- [x] `UNIQUE(session_id, actor_id, idempotency_key)`。
- [x] `UNIQUE(session_id, generation)`。
- [x] `UNIQUE(session_id, generation, event_sequence)`。
- [x] 同 idempotency key 不同 request hash 返回 `IDEMPOTENCY_KEY_REUSED`。
- [ ] `sessions.status = RUNNING` 时 active execution 必须属于 current generation。
- [x] Session CAS Reservation、Action、Execution、accepted event、Outbox 同事务创建。
- [ ] 所有 Execution 状态更新使用 expected version；多 Worker 阶段额外校验 fencing token。

### 9.3 Reservation 事务

```text
BEGIN
1. authenticate actor + evaluate capability/policy
2. validate session/generation is READY
3. check idempotency key + request hash
4. CAS session READY -> RESERVED and bind execution_id
5. allocate action sequence
6. insert Action + Execution + accepted Event + Outbox
COMMIT
```

CAS 失败返回 `PTY_BUSY`；API 不做内存级“先检查再写”。

---

## 10. 建议系统架构与进程演进

```text
Human Console                       Agent / Scheduler
  HTTP + WS                         MCP stdio / HTTP
       \                               /
        +------ API / Action Service -+
                     |
                 PostgreSQL
             Action/Event/Outbox
                     |
                Session Router
                     |
           Session Executor owner
              PTY + Shell hooks
                /           \
        Event Ingestor   VT Projector
```

进程演进：

1. M0–M7：模块化单体；API、Application、Executor 同进程，PostgreSQL 持久化。
2. M8：拆 Outbox Publisher/Worker，引入 RabbitMQ；消息只唤醒当前 Session owner。
3. M9：多 Worker，Session 固定到唯一 owner；router 将 Action 投递到 owner。
4. Owner 丢失：generation BROKEN；新 owner 只能从 checkpoint 创建新 generation，不能接管旧 PTY。

RabbitMQ 不负责 Action ordering，也不表达 exactly-once。`ExecutionReady` 是 wake-up；Worker 仍读取 PostgreSQL 状态并校验 generation/owner。

多 Worker 必须先解决路由再谈 Lease：

- 方案 A：owner-specific queue/consumer routing。
- 方案 B：central router RPC 到 owner Worker。
- 方案 C：每个 Session Executor 是独立 supervisor process，Worker 只与 supervisor 通信。

M9 spike/ADR 选型；不能让任意 Worker 消费后新建第二个“同 Session”PTY。

---

## 11. Protocol 草案

### 11.1 MCP 工具面

当前已注册且有实现证据的工具：

- Session：`session_create`、`session_get`、`session_list`、`session_close`。
- Action/Execution：`execute`、`execution_get`、`execution_wait`、`input`、`control`、`terminal_resize`。
- Event：`events_query`。
- Screen：`screen_get`、`screen_region`、`screen_cells`、`screen_diff`、`screen_search`、`screen_wait`、`terminal_state`。
- Checkpoint/Fork：`session_checkpoint`、`session_fork`。

后续按能力分阶段增加：

- M7.2：新 daemon 从 durable checkpoint hydrate 历史 BROKEN parent 并接入 Browser Human rebuild/fork UX。
- Event exact-get/全文 search 只有在 bounded schema、权限与分页契约冻结后才注册；底层 repository 已有能力不等于 MCP 工具已交付。

调整稿使用的 `terminal_*` 名称仅视为产品草案。当前实现已使用上述稳定短名称；如发布前需要统一前缀，必须单独做命名 ADR、兼容别名与弃用周期，不能只改 TODO。

约束：

- [x] 所有现有 write tool 接受 idempotency key；Input/Control 接受 generation + target execution。
- [x] Input 可携带 expected screen version 并在不匹配时返回 `SCREEN_CHANGED`；强制 fresh-screen policy 待 M6.5 接入。
- [x] Tool description 清楚解释 Execute/Input/Control 的选择边界。
- [x] `PTY_BUSY` 返回当前 execution 与 allowed next actions，不只返回字符串。
- [x] MCP stdio stdout 只能有合法 JSON-RPC，诊断写 stderr。
- [x] MCP adapter 不复制 Application 逻辑；新 MCP Tasks 能力只做 adapter，不替换 Action/Execution 模型。

### 11.2 HTTP / WebSocket

建议资源：

- `/api/sessions`
- `/api/sessions/:sessionId/fork`
- `/api/sessions/:sessionId/actions`
- `/api/executions/:executionId`
- `/api/executions/:executionId/input`
- `/api/executions/:executionId/control`
- `/api/executions/:executionId/screen`
- `/api/sessions/:sessionId/events`
- `/api/sessions/:sessionId/interaction`
- `/api/sessions/:sessionId/interaction/guard`
- `/api/approvals/:approvalId`

WebSocket 只承载 live event/screen/action transport，不是真相源。重连携带 generation + last durable event cursor；server 可返回 event batch、screen snapshot/diff、guard/policy、backpressure、resync required。

### 11.3 稳定错误码

- `SESSION_NOT_FOUND`
- `SESSION_NOT_READY`
- `SESSION_BROKEN`
- `SESSION_GENERATION_CHANGED`
- `PTY_BUSY`
- `EXECUTION_CHANGED`
- `SCREEN_CHANGED`
- `INPUT_GUARDED`
- `INTERACTION_GUARD_CHANGED`
- `IDEMPOTENCY_KEY_REUSED`
- `POLICY_DENIED`
- `APPROVAL_REQUIRED`
- `OUTPUT_TRUNCATED`
- `DELIVERY_UNKNOWN`
- `BACKPRESSURE`
- `RUNTIME_UNAVAILABLE`
- `CHECKPOINT_UNAVAILABLE`
- `RESYNC_REQUIRED`

错误响应统一带 request ID、domain IDs、current state、retryability 与 allowed next actions。

---

## 12. Human Console 交互模型

### 12.1 READY 模式

- xterm 显示 Shell output/prompt，但键盘焦点默认进入独立 command composer。
- Human 本地编辑完整 command，Enter 后提交 ExecuteAction。
- 不把每个 keydown 直接写入 READY Shell，避免绕过 Reservation/Action attribution。
- 支持历史、取消草稿、明确 actor label；autocomplete 属于后续功能。

### 12.2 RUNNING 模式

- 当前是 REPL/TUI/long-running process 时，Human 可进入 interactive focus。
- 文本尽量以 batch 发送；raw keys 在 10–30 ms 小窗口聚合，具体阈值实测。
- UI 显示 active execution、generation、screen freshness、input policy、当前 guard。
- Ctrl+C UI 必须让用户选择/明确映射 TTY control 或 process signal；默认采用终端语义并记录。

### 12.3 Console 第一版功能

- [x] 创建/关闭 Session generation。
- [ ] 重建/fork Session（依赖 M7 checkpoint/fork 语义）。
- [x] 实时 xterm.js Terminal + current execution + Session status（canonical screen projection）。
- [x] command composer、Input、Control、stream wait、PTY_BUSY allowed-next-action 建议。
- [x] Human/Agent/System Action 标签与 bounded Timeline。
- [x] event cursor 重连、screen resync、live/event gap 提示。
- [ ] 预留 Approval/secret prompt 状态展示；完整交互与脱敏在 M10 实现。
- [x] Runtime-owned canonical geometry：默认 120×40、显式 ResizeAction、viewer 不自动 fit/抢占 ownership。
- [x] 基本键盘可达、焦点边界、文本状态与非纯颜色提示。

---

## 13. 安全、隐私与资源边界

### 13.1 MVP 威胁模型

MVP 假设单机受信用户；Agent 可能犯错或受提示注入影响，但 Runtime/宿主用户未被攻陷。Shell rc 与 Shell 中运行的代码拥有宿主用户权限，策略层不是 sandbox。

### 13.2 必做项

- [x] Human Console HTTP 仅监听 loopback并拒绝 `0.0.0.0`；MCP 当前为 stdio、无网络监听。
- [x] Console 校验 Origin/Host/WebSocket upgrade；HttpOnly SameSite cookie 不进入 URL query。
- [x] workspace root 与 fork cwd 使用 realpath/containment 校验（M7.1 reconstruction boundary）。
- [x] 明确声明：workspace containment 只校验重建起点，不阻止后续 Shell command 访问 root 外路径。
- [x] 不继承完整宿主 env；Runtime env、Shell env、checkpoint env 分开定义。
- [ ] Secret 不进入 Action payload、Event、Snapshot、Checkpoint、MCP result、普通 log/recording。
- [ ] Human-only secret channel 直接写 PTY，只记录完成/取消 metadata；敏感期间暂停/脱敏 screen/event recording。
- [ ] Approval 绑定 immutable Action request hash + session generation + actor + expiry；任何变化使批准失效。
- [ ] PTY/Shell 独立 process group/session；close/timeout 使用可配置 Control -> SIGTERM -> SIGKILL，并验证子进程回收。
- [ ] 限制 Session、event bytes、artifact bytes、单次返回、WS backlog、screen geometry、Action rate。
- [x] Shell marker parser 抵抗注入、oversize frame、partial frame 与 nonce replay。
- [ ] CI 做 secret scan、dependency audit、SBOM 与 release provenance。

### 13.3 Remote/硬隔离后续边界

- Remote Executor 必须使用独立身份/Bridge，不把 SSH key 直接暴露给 MCP Client/Agent。
- Linux isolation 可评估 namespace/cgroup/seccomp/container provider；不把 macOS `sandbox-exec` 当长期通用方案。
- 对外开放 Streamable HTTP MCP 前，按当时稳定 MCP Authorization 规范实现并独立安全评审。

---

## 14. 技术栈与仓库结构

### 14.1 技术栈基线

- TypeScript + 实现时受支持的 Node.js LTS。
- pnpm workspace；首版不引入 Nx/Turborepo。
- Fastify + WebSocket + JSON Schema/TypeBox 或 Zod。
- PostgreSQL；关键 CAS/locking SQL 显式可审阅。
- `node-pty`；Virtual Screen 先评估 `@xterm/headless`，通过 adapter 隔离。
- React + xterm.js Human Console。
- 官方 MCP TypeScript SDK；M4 先 stdio，后续 Streamable HTTP。
- RabbitMQ 仅 M8 引入。
- Vitest + Testcontainers + Playwright +真实 Shell/TUI fixtures。
- 结构化 JSON log + OpenTelemetry 接口；本地默认不上传 telemetry。

### 14.2 建议结构

```text
apps/
  api/
  worker/
  mcp/
  web/
  cli/
packages/
  domain/
    session/
    action/
    execution/
    event/
  application/
    create-session/
    execute/
    send-input/
    send-control/
    query-events/
    fork-session/
  protocol/
  persistence/
  executor-pty/
  shell-integration/
  terminal-screen/
  policy/
  observability/
  testkit/
docs/
  adr/
  architecture/
  protocol/
  threat-model/
  verification/
infra/
  compose/
```

依赖方向：`domain <- application <- adapters/apps`。任何 transport 都不能直接写 PTY 或更新 Session 状态。

---

## 15. Development Roadmap

### M0 — 契约冻结与 Shell Integration Feasibility Spike（目标：L2 spike）

- [x] 新增 README/AGENTS/术语表/验证模板。
- [x] ADR-001：Session-centric shared Shell 与 generation。
- [x] ADR-002：Action/Execution/Session 状态机与 Busy fail-fast。
- [x] ADR-003：Shell Integration control channel 与 marker trust boundary。
- [x] ADR-004：PTY merged output、Event 与 Virtual Screen。
- [x] ADR-005：Input Guard、target execution、screen freshness。
- [x] ADR-006：Checkpoint/fork 的可复制与不可复制状态。
- [x] 建立最小 pnpm workspace、format/lint/typecheck/unit/build 脚本，足以运行和丢弃 spike。
- [x] 最小 node-pty bash/zsh spike：同一 Shell 连续执行 `cd/export/pwd/echo`。
- [x] 对比独立 control FD 与 authenticated OSC/DCS；保存兼容矩阵。
- [x] 验证 multiline/syntax error/nonzero/Ctrl+C/large output/marker spoof。
- [x] Spike 可以丢弃，不能在未评审时直接演化成生产 Runtime。

Exit Gate：真实 bash/zsh 下可靠观察 start/end/exit/cwd；`cd/export` 持久共享；marker spoof/partial frame 测试有明确结果。核心假设失败则先调整架构，不开始 M1。

### M1 — 单进程 Persistent PTY Core + CLI（目标：L2）

- [x] 补齐 CI matrix、domain package、协议 fixture 与验证报告门禁。
- [x] Session create/close，generation，单 Executor owner。
- [x] Execute/Input/Control Application Service 与内存 repository。
- [x] READY/RESERVED/RUNNING/BROKEN/CLOSED 状态机。
- [x] Session CAS/mutex Reservation；同一 Session 单 active Execute。
- [x] Shell Integration production adapter（bash/zsh）。
- [x] PTY output bounded ring buffer；process group/control/cleanup。
- [x] CLI 创建 Session、Execute、Input、Control、status、events。
- [x] Human/Agent fake client 同时操作同一 Session。

验收：

- [x] Agent `cd packages/web` 后 Human `pwd` 得到共享 cwd。
- [x] Human `export DEBUG=1` 后 Agent `echo $DEBUG` 得到 `1`。
- [x] 长运行 fixture（M1 使用 Python/sleep，API `pnpm dev` 尚未存在）RUNNING 时另一个 Execute 返回 PTY_BUSY。
- [x] Python fixture 中两个 Actor 的 InputAction 命中同一 Execution。
- [x] stale target execution 被拒绝；Ctrl+C 后 Shell 回到 READY。

Exit Gate：L2 核心链路通过；仍不声明 durability、MCP 或 Web 已完成。

### M2 — PostgreSQL Domain Persistence 与 Reservation（目标：L2）

- [x] migrations：Session/Generation/Actor/Action/Execution/Event/Snapshot/Checkpoint/Outbox。
- [x] Action idempotency + request hash conflict。
- [x] Session READY -> RESERVED CAS 事务。
- [x] accepted Action/Execution/Event/Outbox 同事务。
- [x] Event sequence 分配与 chunk persistence。
- [x] Runtime restart 将失联 live generation 标记 BROKEN；模糊 Execution 标 UNKNOWN。
- [x] Snapshot/checkpoint best-effort 更新，不覆盖历史事实。
- [x] retention/quota 最小实现。

验收：

- [x] 100 个并发 Execute 只有一个 Reservation 成功，其余 PTY_BUSY。
- [x] 相同 idempotency key/hash 返回原 Action，不同 hash 冲突。
- [x] DB commit 前失败不留下半个 Action；commit 后 crash 可发现 RESERVED/UNKNOWN。
- [x] Runtime 重启不伪造旧 PTY 恢复。

### M3 — Bounded Event Observation（目标：L2）

- [x] get execution/event、query by sequence/time/execution/type。
- [x] keyword search（PostgreSQL FTS）与有界上下文。
- [x] output chunk/artifact 阈值、byte count、tail preview/ref。
- [x] cursor scope/generation、truncated/next cursor、RESYNC_REQUIRED。
- [x] 结构化 timeline attribution。
- [x] 10 万行与慢消费者 benchmark。

Exit Gate：已在 PostgreSQL 17 通过。Agent 测试程序只靠 metadata/query/search 定位第 25k/50k/75k/100k 行的稀疏 FAIL，不读取全量；查询响应大小受 page/context/artifact read 上限约束，不随总输出无界增长。

### M4 — MCP Adapter（目标：L3 Agent 路径）

- [x] stdio MCP server，stdout 零污染。
- [x] Session/Execute/Input/Control/Event 工具 schema；Fork 与 Screen 按后续里程碑注册。
- [x] Tool descriptions 明确 Action 选择与 PTY_BUSY next actions。
- [x] idempotency、generation、target execution precondition 透传。
- [x] OpenCode 1.18.25 与 Claude Code 2.1.251 完成本地 stdio handshake。
- [x] MCP Client 重启后凭 Action/Execution/Event cursor 恢复观察。
- [x] `ITERM_DATABASE_URL` durable daemon：Session/Execute/Input/Control/Execution 状态接入 PostgreSQL。
- [x] PTY output 经每 Session 有界有序 ingest loop 进入 Event/Artifact，失败熔断 live generation。
- [x] 真实 MCP + PostgreSQL 证明 write-ahead Action、attribution 与 durable cursor 重连。
- [x] daemon `SIGKILL` 后同 owner 重启将旧 generation/Execution 标为 `BROKEN/UNKNOWN`，不伪恢复 PTY。
- [ ] 真实模型驱动 Agent 自主完成完整工具路径（需要显式外发授权）。

Exit Gate：L2 协议/Runtime/持久化路径已完成；官方 SDK Client 已完成 create -> shared state -> execute -> busy/wait/input/control -> durable observe/reconnect，真实进程崩溃恢复通过，OpenCode/Claude Code handshake 通过。M5 只依赖这条稳定 transport contract，现已继续实现；M4 尚未由真实模型自主完成该路径，因此 M4 本身仍不声明 autonomous-model L3。

### M5 — Human Console（目标：L3 shared path）

- [x] React/xterm.js、Fastify HTTP/WS、Session 页面。
- [x] READY command composer 与 RUNNING interactive focus 分离；READY raw input 在 transport 层拒绝。
- [x] current execution、Action actor label、bounded Timeline、PTY_BUSY allowed-next-action UI。
- [x] Input/Control 与 actor/policy/guard 状态 UI；消费 M6.5 稳定契约，Approval/secret 仍待 M10。
- [x] durable event cursor reconnect、full screen resync、live/event gap 提示与慢消费者上限。
- [x] 默认 120×40、受控 dynamic geometry、多 viewer 独立 stream、基本键盘/焦点/非颜色可访问性。

Exit Gate：已通过 L3 shared path。真实无头 Chrome Human Console + official MCP SDK Agent 共享 cwd/env/Python REPL；Guard 阻断语义、浏览器 reload cursor/screen 恢复、Human/Agent PostgreSQL Action 归属与 READY 无旁路均有证据。Autonomous model、TUI/cross-browser/daemon-restart wait 不在本 Gate 的已证范围。

### M6 — Virtual Screen 与交互并发安全（目标：L3 MVP）

- [x] `@xterm/headless` ANSI/VT parser、alternate screen、Unicode/wide chars 与默认 120×40 canonical geometry。
- [x] 受控 resize/reflow 与多 viewer geometry ownership：Runtime 单一 owner、40–240×12–100 bounds、`geometryVersion` CAS、Human/Agent ResizeAction、SIGWINCH、UNKNOWN/BROKEN。
- [x] bounded full viewport、active buffer、cursor 与 exact `screenVersion` snapshot。
- [x] bounded current-viewport literal search 与 terminal-cell row/column match。
- [x] terminal-cell rectangular region、64-revision bounded row diff 与 explicit full-snapshot resync。
- [x] stable sparse cell DTO：palette/RGB foreground/background、wide/combined text 与标准 SGR boolean attributes。
- [ ] style diff、hyperlink target、underline variants/color、image/sixel、mouse/pixel metadata 等富终端表示。
- [x] exact-generation Runtime RPC `screen.get` 与 MCP `screen_get`。
- [x] exact-generation Runtime RPC/MCP reactive wait for visible text/version/stable interval/Execution exit；timeout 返回最新 bounded snapshot，RPC disconnect 取消服务端 wait。
- [x] Human Console WebSocket subscription、event cursor catch-up 与 full screen resync。
- [ ] daemon restart 后的 durable wait/subscription 恢复。
- [x] expected screen version 与 `SCREEN_CHANGED`：Agent 读屏后 Human Actor 经 Runtime RPC 改屏，Agent stale input 被拒绝。
- [x] common/human_guarded/human_only/agent_only 与短期 Guard（L2 backend + L3 Browser Human/MCP shared path）。
- [x] exact-generation read-only `TerminalState` heuristic + closed confidence/evidence/limitations；不当作安全事实。
- [x] real bash/zsh + official MCP 的 shell/REPL/vim/nano/top/pager/confirm/password-like/spoof fixtures（L2）。

核心场景：

- [x] Agent read screen v100，Human 改到 v105，Agent stale input 被拒绝（L2 RPC/MCP Actor 路径；该 stale-version 子场景尚未由 Browser Human 重跑）。
- [ ] Agent 看到 psql exec_101，Human Ctrl+C 后启动 python exec_102，旧 SQL 被拒绝。
- [x] Human raw input 活跃时 Agent input 不插入半行；guard 过期/释放后可继续（L2 RPC + L3 Browser Human/MCP）。
- [x] Human xterm.js 与 Agent headless screen 在 Human/Agent resize 后文本一致（L3 Chrome + official MCP；style/pixel parity 仍未覆盖）。

#### M6.5 — Input Policy 与 Interaction Guard（已完成 backend L2）

这是一项 generation-scoped 协调机制，不是 Human/Agent ownership，也不是长期锁。建议先在 ADR-0023 冻结下列精确契约，再写代码：

| policy          | Human Input/Control       | Agent Input/Control | Guard 行为                                        |
| --------------- | ------------------------- | ------------------- | ------------------------------------------------- |
| `common`        | 允许                      | 允许                | 不获取、不阻塞                                    |
| `human_guarded` | 允许；Guard holder 可继续 | 无 Guard 时允许     | Human 可短期持有；其他 Actor 返回 `INPUT_GUARDED` |
| `human_only`    | 允许                      | `POLICY_DENIED`     | 不使用 Guard                                      |
| `agent_only`    | `POLICY_DENIED`           | 允许                | 不使用 Guard                                      |

`scheduler/system` 不自动继承 Human 或 Agent 权限；没有显式 interaction capability 时返回 `POLICY_DENIED`。Human emergency Control 的 `bypassGuard` 只绕过 Guard，不绕过 policy、generation、target execution、screen freshness 或 approval。

建议冻结的数据契约：

```ts
type InputPolicyMode = "common" | "human_guarded" | "human_only" | "agent_only";

interface InteractionState {
  sessionId: string;
  sessionGeneration: number;
  policy: InputPolicyMode;
  version: number;
  guard?: {
    id: string;
    actor: Actor;
    reason: string;
    acquiredAt: Date;
    expiresAt: Date;
    renewals: number;
    maxRenewals: number;
  };
}
```

建议默认值由 ADR 确认：`human_guarded`；TTL default 500 ms、min 50 ms、max 5 s；同一 Guard 最多续租 3 次。Guard 到期采用请求/读取时的惰性清理，通过 version CAS 只记录一次 `guard_expired`，不引入常驻 timer。

实现 TODO：

- [x] ADR-0023 冻结 policy 矩阵、授权者、TTL/续租、emergency bypass、expiry 与幂等顺序。
- [x] Domain 增加 `InputPolicyMode`、`InteractionState/Guard`、`INPUT_GUARDED`、`POLICY_DENIED`、`INTERACTION_GUARD_CHANGED`；Control request/action 记录显式 `bypassGuard` 审计字段。
- [x] 每个新 Session generation 初始化 `human_guarded` + version 1；policy change 清除现有 Guard、version +1，并形成 durable event。
- [x] Application 在同一 per-session mutation serialization 内完成 idempotency replay、generation/execution/screen 校验、policy/guard 判定与 Action admission；已接受 Action 的同 key/hash replay 先返回原结果，不被后来 policy 变化改写。
- [x] Guard acquire/renew/release 使用 guard id + expected state version；仅 Human capability 可 acquire，renew/release 必须匹配完整 Actor identity；活跃 Guard 冲突返回 `INPUT_GUARDED`，stale guard/version 返回 `INTERACTION_GUARD_CHANGED`。
- [x] PostgreSQL migration 增加 generation-scoped `interaction_guards` 状态行与约束；policy/guard state update + Event 同事务提交，并在 `acceptInteraction` 事务内再次校验，避免 Application 检查与 durable admission 的 TOCTOU。
- [x] Runtime RPC 增加 `interaction.get`、`interaction.policy.set`、`interaction.guard.acquire|renew|release`；把它们纳入 mutating-operation delivery uncertainty 判定。
- [x] MCP 增加只读 `interaction_get`；`input`/`control` Tool description 与结构化 error 暴露 retryability、guard expiry/current version、allowed next actions，不给 Agent 暴露 Human Guard mutation。
- [x] Human Console 通过 HTTP/RPC 持有和续租 Guard；20 ms raw-key batch 前 acquire，idle/blur/disconnect 时 release，断线失败仍由 TTL 收敛。
- [x] denied/guarded 请求不分配 accepted Action sequence、不触碰 PTY；记录不含 raw secret/input data 的 bounded rejection/security event。
- [x] 统一 clock 注入或受控 fake clock，覆盖 TTL 边界；数据库时间与 Runtime 时间差异不得造成已过期 Guard 永久阻塞。

测试与证据：

- [x] L1 Domain/Application：四种 policy × Human/Agent/Scheduler/System 矩阵；acquire/renew/release/expire/version race；policy change 清 Guard；emergency Control 只绕过 Guard；rejected input 零 PTY write。
- [x] L1 Durability：migration constraints、state/event 原子性、expected-version CAS、事务回滚、idempotent accepted replay、并发 Guard acquire 只有一个成功。
- [x] L2 real PostgreSQL + PTY + official MCP Client：Human RPC 持有 Guard 时 Agent MCP input 返回 `INPUT_GUARDED` 且画面无半行；Guard 到期/释放后 Agent 可继续；`human_only/agent_only/common` 行为与矩阵一致。
- [ ] L2 crash/restart：Guard 与 policy durable 可观察；旧 generation Guard 不影响新 generation；未知 Input/Control 仍遵守 ADR-0011，绝不因 Guard 过期自动重放。
- [x] 功能闭合后运行受影响测试、`pnpm verify`、`git diff --check`，保存 `docs/verification/M6/2026-08-30-interaction-guard.md`；该报告保持 backend L2，Browser/MCP L3 另见 M5 verification。

#### M6.7 — Bounded TerminalState Evidence（已完成 L2）

- [x] ADR-0026 冻结只读、exact-generation、snapshot-bound 的证据契约和安全边界。
- [x] Domain/Application 实现 closed-enum `kind/confidence/evidence/limitations`，最多各 8 项，不返回 raw command/screen/input/env/secret。
- [x] Runtime RPC `terminal.state.get` 与 MCP `terminal_state`；读取不写 Event、Action 或 `session_snapshots`。
- [x] READY/RUNNING 优先使用 Shell Integration 事实；prompt-looking 文本、alternate buffer、command family 仅为 signal。
- [x] real PTY/official MCP fixture 覆盖 bash/zsh READY、stable RUNNING、Python REPL、vim、nano、less、top、confirm、password-like、spoof 与 stale generation。
- [x] 证据报告保持 L2；未授权 autonomous model 自动输入，不宣称 foreground-process/echo-mode 重建或 M6 全量 L3。

Exit Gate：M0–M6 的 L3 证据齐全；到此才能称为 MVP。

### M7 — fork_session 与 Rebuild（目标：L3）

- [x] M7.1 checkpoint schema、operator exact allowlist/filter、bounded value、hash/version/age/staleness。
- [x] M7.1 fork from READY re-certified checkpoint + exact version CAS。
- [x] M7.1 fork from RUNNING/BROKEN last valid checkpoint + explicit `allowStale` warning（同 live owner）。
- [x] M7.1 cwd/env/workspace/shell profile 恢复；cwd realpath/containment，只注入 filtered env。
- [x] M7.1 PostgreSQL parent/child lineage、actor-scoped fork idempotency、fork/rebuild events。
- [x] M7.1 缺失/变更/stale-unacknowledged/invalid cwd checkpoint 结构化失败。
- [ ] M7.2 UI 明确“不复制 process/REPL/vim state”；MCP Tool description 已完成。
- [ ] M7.2 Human Console fork/rebuild 操作；MCP `session_checkpoint|session_fork` 已注册。
- [ ] M7.2 daemon/owner restart 后从 PostgreSQL hydrate 历史 BROKEN parent checkpoint，而不伪恢复旧 PTY。

Exit Gate：parent busy 时 fork 后可独立 `git status`；child 继承可复现 context，不影响 parent PTY。

### M8 — Outbox、RabbitMQ 与 Crash Semantics（目标：L4）

- [x] Outbox claim/publish/mark、重复 publish、lease recovery 与 relay 优雅停机。
- [x] RabbitMQ `ExecutionReady` confirm transport、manual ACK、confirmed retry queue 与 DLQ。
- [x] retry publisher outage 时的 NACK/requeue 与无 hot-loop 故障注入。
- [x] Consumer Inbox 去重并读取 DB Execution/owner/generation，不信任 message ordering。
- [x] 将 owner-local PTY dispatch 从 admission 调用栈迁到 `ExecutionReady` handler。
- [x] 写 PTY 前/后 crash injection 与 delivery uncertainty（Execute owner-local 路径）。
- [x] Input/Control write 后 crash 不自动重发。
- [x] duplicate/delayed message 不重复调用 handler 或真实 Shell input。
- [ ] DB/MQ outage 的完整 admission/backpressure 行为。
  - [x] DB lock timeout 不写 PTY，返回 `RUNTIME_UNAVAILABLE` 并熔断失去 durable truth 的 generation。
  - [x] MQ delivery unavailable 时 Outbox 有界积压；满载 `BACKPRESSURE` 不破坏 READY Session，publish 后可重试。
  - [x] 单节点 RabbitMQ 进程 stop/start：relay publisher 与 Worker consumer 自动重连，停机期间已接受 Execute 恢复后只写一次 PTY。
  - [x] Runtime PostgreSQL 进程 stop/start：health probe 打开 owner-wide circuit，Pool reconnect 后先 durable reconciliation，再允许新 Session。
  - [x] standalone Outbox relay/Execution Worker 的 PostgreSQL stop/start supervision：真实子进程暂停 loop/consumer，并在数据库恢复后继续服务。
  - [x] 本机双向 silent TCP blackhole：真实 PostgreSQL/RabbitMQ socket 不关闭但丢弃字节，deadline/heartbeat 有界检测并恢复。
  - [x] 三节点 RabbitMQ quorum：查询并停止实际 queue leader；relay/Worker 轮换端点，在旧 leader 保持停机时完成 pending Outbox 且不重复写 PTY。
  - [ ] 非对称/多跳 network partition、minority partition、相关性 DB/MQ 故障与长时间 soak。

故障矩阵：

- [x] DB commit 前 crash。
- [x] DB commit 后、outbox publish 前由 pending row/expired lease 恢复。
- [x] publish confirm 后 mark 前丢失状态会重复 publish，并由 Inbox 去重。
- [x] Worker claim 后、PTY write 前 crash。
- [x] PTY write 后、start marker 前 crash。
- [x] command completed 后、DB update 前 crash。

Exit Gate：每个故障点有确定期望；不确定写入进入 UNKNOWN，文档无 exactly-once 误导。

### M9 — Multi-Worker Session Ownership、Lease 与 Router（目标：L4）

- [ ] Worker registry、heartbeat、drain。
- [ ] Session owner routing 方案 ADR 与实现。
- [ ] generation-scoped Lease、renewal、fencing token。
- [ ] 所有 Execution 状态提交校验 owner/generation/fencing。
- [ ] 非 owner Worker 无法创建/写第二个同 Session PTY。
- [ ] owner lost -> generation BROKEN；checkpoint rebuild 创建新 generation。
- [ ] stale owner DB writes 被拒绝；旧 process group 尽力回收并告警。
- [ ] 多 Session 的公平分配与 per-actor/session rate limit。

Exit Gate：3+ Worker chaos 下每个 generation 最多一个有效 PTY owner；不宣称 live PTY failover。

### M10 — Security、Release 与 Dogfood（目标：v1.0 L4）

- [ ] Capability/Policy/Approval 完整矩阵。
- [ ] secret channel、敏感期 recording redaction、审计抽检。
- [ ] Human Console Approval 与 Human-only secret input 完整交互。
- [ ] origin/DNS rebinding/WS hijack/token/log/marker/path/resource exhaustion 测试。
- [ ] event/artifact retention/export/cleanup 与磁盘上限。
- [ ] 一条命令启动 PostgreSQL + Runtime + Web；MCP 配置可复制。
- [ ] macOS/Linux clean-machine install、node-pty platform matrix。
- [ ] 至少两个真实 MCP Client 版本矩阵。
- [ ] 连续两周真实开发 dogfood：shared cwd/env、dev server、REPL、TUI、fork、crash、reconnect。
- [ ] operator/recovery/security/protocol/troubleshooting 文档。
- [ ] SBOM、provenance、release notes 链接全部 L3/L4 证据。

---

## 16. 必测场景总表

1. **Shared cwd**：Agent `cd frontend`，Human `pwd` -> frontend。
2. **Shared env**：Human `export DEBUG=1`，Agent `echo $DEBUG` -> 1。
3. **Busy**：Human `pnpm dev`，Agent `git status` -> PTY_BUSY + next actions。
4. **Shared REPL**：Human 进入 psql，Human/Agent Input 命中同一 connection/execution。
5. **Stale execution**：Agent 针对旧 psql exec 发 SQL，当前已是 python -> EXECUTION_CHANGED。
6. **Screen race**：Agent screen v100，Human 改到 v105，Agent write -> SCREEN_CHANGED。
7. **Input race**：Human raw batch 未结束时 Agent write -> guarded，不产生半行混写。
8. **Huge output**：10 万行 Human 实时看，Agent bounded query/search。
9. **Idempotency**：重复 key/hash 返回原 Action；key 相同 payload 不同返回冲突。
10. **Unknown execute**：`npm publish` 已写 PTY 后 Worker crash -> UNKNOWN，不 retry。
11. **Unknown input**：SQL write 后 crash -> UNKNOWN，不自动重发。
12. **Shell mutation**：`source`/`nvm`/`conda` 中至少选择两个真实 fixture 验证持久 state。
13. **Shell integration attack**：command 输出伪 marker/partial/oversize frame，不越权闭合 Execution。
14. **Fork**：parent busy，child 从 checkpoint 启动；不复制 foreground state。
15. **Runtime restart**：旧 PTY generation BROKEN；rebuild 是新 generation。
16. **Reconnect**：Human/MCP 重连恢复 durable facts；live gap 显式 resync。

---

## 17. 测试与质量门

### 17.1 每个 PR 固定门禁

- [ ] format/lint/typecheck/unit/build。
- [ ] 受影响模块 integration/contract tests。
- [ ] migration forward/rollback plan。
- [ ] `git diff --check`；无 DB/log/recording/secret/cache 混入。
- [ ] 状态机/协议变更同步 ADR/schema fixture/兼容说明。
- [ ] 验证报告标注 L0–L4，不把 build 写成真实协作完成。

### 17.2 测试分层

- Domain：Action/Execution/Session 状态机、CAS、idempotency、stale protection、policy。
- Shell Integration：bash/zsh hooks、marker/control channel、multiline、signals、rc 冲突。
- PTY：foreground group、TTY controls、resize、Unicode、process tree cleanup。
- Persistence：真实 PostgreSQL 事务、event sequence、outbox、unknown recovery。
- Screen：ANSI/alternate buffer/diff/version 与 xterm.js 对照。
- Protocol：CLI/HTTP/MCP/WS schema、errors、pagination、backpressure、reconnect。
- Scenario：真实 Human browser +真实 MCP Agent +真实 Shell/TUI fixture。
- Chaos：kill API/worker/shell、DB/MQ outage、duplicate message、owner loss。
- Security：marker spoof、origin/auth/secret/path/resource exhaustion。
- Performance：大输出、快速 redraw、多 Session、慢 consumer。

不可用 mock 替代：真实 PTY/Shell mutation、真实 xterm/headless screen、真实 PostgreSQL race、真实 MCP Client、真实 browser input race、真实 crash 后 UNKNOWN。

---

## 18. 性能与可观测性目标草案

先测量再冻结 v1 SLO，初始目标：

- ExecuteAction admission（不含执行）本机 p95 < 100 ms。
- Input/Control accepted -> PTY write 本机 p95 < 50 ms（不含 guard wait）。
- PTY bytes -> Human WS p95 < 100 ms；-> screen projection p95 < 150 ms。
- 100k 行输出时 Runtime RSS 不随总输出线性无界增长。
- 慢 consumer 不阻塞 PTY reader；超过 buffer 触发 resync。
- Session owner lost 后 10 s 内 durable state 可见 BROKEN/UNKNOWN（规模基线需记录）。

必须采集：Session status/generation、active execution age、Action outcome、PTY bytes/chunks、screen lag、WS backlog/resync、outbox age、MQ redelivery/DLQ、owner lease/fencing rejection、policy/approval latency、artifact/disk growth。

---

## 19. 高风险与止损条件

| 风险                                                | 最早验证       | 止损/调整条件                                                 |
| --------------------------------------------------- | -------------- | ------------------------------------------------------------- |
| Shell Integration 无法跨 bash/zsh 稳定闭合 boundary | M0             | 缩小首发 Shell 或采用 sidecar/control FD，不进入持久化扩展    |
| marker 可被输出伪造或被 chunking 破坏               | M0             | 禁止仅靠裸 OSC 文本；切换独立 control channel                 |
| command composer 与真实 Shell editing 体验割裂      | M1/M5          | 增加明确模式/UX，不允许 READY raw bypass 破坏 Action 模型     |
| 原子 Input 仍发生语义竞争                           | M6             | 默认收紧为短期 Interaction Guard，而不是宣称对等输入已解决    |
| headless screen 与 xterm.js 漂移                    | M6             | 共享 parser core 或提前像素 screenshot provider               |
| PG event 成本过高                                   | M3             | raw chunks 转 artifact/file，PG 只存索引与 ref                |
| fork context 对用户预期过度承诺                     | M7             | UI 改称 rebuild-from-checkpoint，并显示字段/staleness         |
| MQ/多 Worker 无法路由到 live PTY owner              | M8/M9          | 保持单 Worker 产品，不用 Lease 伪装迁移能力                   |
| 项目滑向低配 clum/SSH 平台                          | Roadmap review | 冻结 remote 功能，优先 Shared Shell/Action/Observation 正确性 |

---

## 20. 开工前 ADR 清单（含建议默认值）

- [ ] 项目/包名暂用 `iTerminal`，发布前查 npm/GitHub/商标冲突。
- [ ] License 建议 Apache-2.0，由项目所有者确认。
- [ ] 首发 macOS arm64/x64 + Linux x64/arm64；Windows 延后。
- [x] bash/zsh 为首发 Shell；默认 Runtime-managed profile。
- [ ] 可选 source user rc 及 hook 重装/校验仍待兼容验证。
- [x] Shell Integration 使用独立 control FD，不信任 PTY 文本 marker 作为状态事实源。
- [x] Persistent Shell ExecuteAction 接受 Shell command string；不与 direct argv API 混为一谈。
- [x] Session 忙时 fail-fast，不建 Execute Queue；并行用 fork Session。
- [x] Human READY 使用 composer，RUNNING 使用 interactive input。
- [x] ADR-0023 冻结 M6.5 policy/Guard 精确契约；默认 `human_guarded`、TTL 500 ms（50 ms–5 s）、最多续租 3 次。
- [x] Human emergency Control 的 `bypassGuard` 仅按 trusted-local Human role 绕过 Guard，不绕过 policy/stale/approval；完整 capability 待 M10。
- [ ] Checkpoint 只保存 cwd + shell + filtered exported env + workspace。
- [x] PostgreSQL 为 durable truth；raw output 达阈值转 artifact。
- [x] MCP M4 先 stdio；对外 HTTP 后续实现 Origin/Auth。
- [x] 开发 retention 默认 7 天或固定事件上限，以先到者为准。
- [ ] artifact/recording 全局磁盘预算与清理告警待 M10。
- [ ] Multi Worker 先 owner routing，后 Lease/Fencing；owner loss 不迁移旧 PTY。

---

## 21. MVP 与 v1.0 Definition of Done

只有以下全部满足，才能称为 MVP：

- [ ] M0–M6 Exit Gate 全部通过并链接验证证据。
- [ ] 真实 Human Console 与真实 MCP Agent 共享 cwd/env/REPL/TUI，达到 L3。
- [x] 现有 Human Console/MCP 写操作都形成 Action，无 READY/WS 旁路 PTY write。
- [x] Busy、target execution、screen freshness、Input Guard 均有自动化回归。
- [ ] Shell Integration 不猜 prompt/静默时间；marker/control channel 有 spoof/chunk 测试。
- [ ] PTY merged output 与 Agent bounded observation 语义一致。
- [ ] Runtime crash 后旧 generation 明确 BROKEN/UNKNOWN，不伪恢复。
- [ ] Secret 不出现在 Action/Event/Snapshot/Checkpoint/MCP result/普通 log 抽检中。
- [ ] README 明确安全假设、非沙箱、支持 Shell/平台与未完成项。

v1.0 还必须满足 M7–M10、fork 语义、故障矩阵、owner routing、multi-worker chaos、安全审阅和持续 dogfood。

---

## 22. 第一批建议 PR 切片

1. `docs: establish shared-shell runtime contracts`：README/AGENTS/术语/ADR/verification template，无业务实现。
2. `chore: bootstrap minimal spike workspace`：pnpm、最小 scripts 与本地质量门。
3. `spike: validate bash and zsh integration channels`：一次性 PTY spike + fixtures + ADR 结论。
4. `feat(domain): model sessions actions and executions`：纯状态机、错误码、属性测试。
5. `feat(runtime): create persistent shell sessions`：Session lifecycle、generation、Shell Integration。
6. `feat(runtime): execute input and control actions`：Reservation、stale target、process group、CLI。
7. `feat(persistence): persist actions executions and events`：PostgreSQL、CAS、idempotency、unknown recovery。
8. `feat(observation): add bounded event queries`：完成 M3 后再开始 MCP adapter。

当前已完成建议切片 1–8，并追加 M4.1 live durable journal、M6.1 live Virtual Screen base、M6.2 reactive screen observation、M6.3 bounded screen synchronization、M6.4 stable styled-cell observation、M8.1 reliable messaging、M8.2 owner-local queue dispatch、M8.3 Interaction/retry outage crash semantics、M8.4 admission/backpressure、M8.5 RabbitMQ process reconnect、M8.6 PostgreSQL owner recovery、M8.7 messaging-loop PostgreSQL recovery、M8.8 silent network blackhole recovery 与 M8.9 RabbitMQ quorum leader failover；后续仍严格按里程碑 Exit Gate 与 `docs/verification/` 证据推进。

下一批按依赖顺序推进：

9. [x] `feat(interaction): enforce generation-scoped input policy and guards`：完成 M6.5 Domain/Application/PostgreSQL/RPC/MCP 与 L2 场景，不包含 Human Console。
10. [x] `feat(console): add shared human terminal path`：完成 M5 最小 HTTP/WS、composer、interactive focus、actor/timeline 与 policy/guard UI，形成首条 L3 Browser Human + official MCP Agent 路径。
11. [x] `feat(screen): add controlled resize and geometry ownership`：完成 canonical geometry owner、resize/reflow、CAS/UNKNOWN 与 Human/headless L3 fixture 对照。
12. [x] `feat(screen): classify bounded terminal state evidence`：完成有 confidence/evidence/limitations 的 heuristic 与 real shell/REPL/TUI fixtures，不把 heuristic 当权限事实。
13. [ ] `feat(session): fork from versioned shell checkpoint`：M7.1 backend/PostgreSQL/RPC/MCP L2 已完成；M7.2 仍需 Browser Human UX 与 cross-daemon durable rebuild 才闭合。

M5 shared path 已闭合，但 M6 完整 L3 与其余 MVP Gate 未闭合前，不因为 M8 已有故障证据就宣称 MVP。
