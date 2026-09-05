# F：支持边界、Agent 基准与路线

当前状态：本轮卡已按约定范围验收；具体等级与未做事项见 [最终对账](final-reconciliation.md)。下文保留原验收条件。

先读 [共同约束](README.md)。此阶段包括设计/文档卡，不能把它们的完成误写成相关功能已实现。

## F01

- [x] 明确 Shell 支持范围。依赖无。建议 Luna。

**先读：** executor shell argv/env/ZDOTDIR/history 初始化；ADR 0003、0060、0065、0066；local-quickstart；Console 输入提示。

**产物：** 新增 `docs/operations/shell-compatibility.md`。逐项对照当前代码，列出受管理 Shell 的启动配置、rc 是否加载、环境变量继承边界、cwd/checkpoint/fork 支持范围、READY 编辑器与 RUNNING 行/raw 模式差别。每项标明“源码确认 / 实测 / 尚未支持”。

**固定决策：** 默认 managed shell 保留；不自动 source 用户 `.zshrc`/`.bashrc`，不把外部 shell integration hook 当可信协议。真实 READY readline/tab completion、profile 导入、完整 mouse/图片等列为后续设计，不让 Luna 本卡顺手实现。inputContext unknown 的自动恢复同样延期；解释当前必须依赖真实程序边界，用户点确认不是证据。

**验收：** 新用户能知道 `cd` 的持久性、普通命令/REPL/TUI 如何输入、为什么 Tab 不一定是 Shell completion、哪些 shell 配置未继承。命令示例只使用隔离 fixture，引用当前已存在的选项，不编造启动 flag。C02 尚未完成时描述 current/planned 两栏，不能提前宣传新模式已上线。

**验证：** 文档与源码逐项核对，必要时只在独立短会话验证支持 shell 的基础场景；纯文档可 L0 交付。用 `pnpm exec prettier --check docs/operations/shell-compatibility.md` 和 `git diff --check`。不要修改任何用户 rc。

## F02

- [x] 建立 Agent 实际任务基准。依赖 B04、B05、C02、E06。建议 Sol。

**产物：** 新增可运行的 MCP benchmark fixture 与 `docs/verification/review-remediation/<日期>-F02.md`，用官方 MCP client 驱动隔离 runtime，不对已有用户会话发命令。

**固定场景与成功定义：**

| 场景            | 必须观察到的结果                                   |
| --------------- | -------------------------------------------------- |
| 短命令          | 执行一次，拿到真实退出状态和预期内容               |
| 长输出          | 分页完整重组固定校验和，无静默截断                 |
| 持续任务        | 有界等待返回，任务继续，后续能读和显式停止         |
| REPL            | Human 草稿在本地，Agent 独立送入一行并读到对应结果 |
| 命令失败        | 非零退出不被解释为传输失败或无输出                 |
| 丢响应          | 原 Action 可核对，没有第二次副作用                 |
| 空闲 Shell 死亡 | 不再 READY，下一步明确是新 generation              |
| 过期输出        | 明确 expired/gap，无伪造完整结果                   |

**测量：** 每场景工具调用数、请求/响应 UTF-8 bytes、工具 metadata chars、等待耗时、是否需要额外 screen/events 查询、是否成功。计费 token 只能在有实际 tokenizer/usage 时报告，并注明模型/方法；否则用字节/字符代理，不乘固定系数冒充账单。

比较旧工具路径与新观察路径，保持相同命令/输出/保留期/环境。若无法运行旧 revision，使用当前保留的 legacy 接口作基线并说明局限，不倒造旧测量。真实模型试用与确定性 MCP fixture 结果分开；用户未授权购买模型调用时只交付 fixture 和可供用户运行的模型提示。

**验收：** 全场景正确性通过，输出有界；报告实际减量及仍昂贵场景，不预设“节省 90%”。每个失败保留最小无秘密证据和可复现命令。benchmark 文件包含资源 cleanup 和独立 DB preflight。

**验证：** 新增 `apps/mcp/src/agent-workflows.test.ts` 并用 `pnpm exec vitest run --maxWorkers=1 apps/mcp/src/agent-workflows.test.ts`；使用 E06 必选集成入口确保无 skip。REPL Human 联合场景使用 browser shared-path，达到所覆盖的 L3。

## F03

- [x] 交付多 Agent 授权边界设计稿，暂不实施 ACL。依赖 D05。建议 Sol。

**先读：** ADR 0056、domain capability profiles、RPC grants、没有 actor 参数的 session create/close/read 路径、审批 Execute 与后续 Input 的区别。

**固定设计目标：** credential 绑定 actor；session 范围来自可信 grant/服务端授权关系；read/input/control/execute/close/rebuild/fork/approval/artifact 各自列权限。默认本地同用户共享模式保持兼容，新 session-scoped 模式应显式 opt-in。不能声称同 OS uid 下凭据文件实现强租户隔离。

**必须交付：** 新 ADR 草稿、现有接口授权矩阵、遗漏入口清单、计划数据结构和迁移步骤、旧客户端行为、403/不存在的防枚举策略、owner/router 转发身份、审批能授权什么以及 REPL 输入不自动继承顶层 Execute approval。写出至少 12 个授权反例及预期结果，供后续实现直接转测试。

**验收：** 每个公开读写入口都在矩阵里；不能出现“以后统一鉴权”占位；说明 root/local administrator 能力边界。结论明确哪些只是设计，不打勾 session ACL 实施，不自动改变现有 grants。

**验证：** 与 `pnpm test:m10:authorization` 的现有场景进行静态覆盖对照，文档格式/链接检查即可，L0。需要产品新增授权体验的实际实现另开明确任务，不混进 D05。

## F04

- [x] 收敛路线并对账所有整改项。依赖 F01、F02、F03。建议 Luna。

**先读：** 本索引全部状态、各卡验证记录、`TODO.md` 与 ADR index。只读历史证据，不修改历史通过数。

**实施：** 在原 TODO 中追加一个简短“审阅整改”入口，链接本计划和实际完成状态，不重写原里程碑。新增/更新操作文档中的推荐本地路径，优先 managed shell + local daemon + Console/MCP；RabbitMQ/多 owner 等现有模式说明为可选能力，不删除正常代码。

制作最终对账表：原 28 项 → 卡 → 实施状态 → 验证级别 → 证据 → 未完成/延期原因。部分卡未验收时如实保留，不为完成本卡把其他卡勾完。把 READY 原生编辑、完整 VT、离线写入、session ACL、deadline 等列为后续独立提案，并给触发条件：实际用户任务受阻且现有方案不能满足。

**验收：** 读者不用追溯整套历史也能找到当前运行入口、输入限制、故障核对方法和未做事项。所有“支持/修复”陈述有当前代码与验证依据；设计卡只显示设计完成；没有新增 SQLite/Redis/微服务等未授权路线。

**验证：** `pnpm verify:docs`、对修改 Markdown 的 Prettier 检查、`git diff --check`；阶段实际代码交付的 `pnpm verify` 与真实门禁结果引用当前证据，不为文档卡重跑耗时 soak。L0 文档对账，不代替其他卡验收。
