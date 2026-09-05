# E：通信、性能、结构与门禁

当前状态：本轮卡已按约定范围验收；具体等级与未做事项见 [最终对账](final-reconciliation.md)。下文保留原验收条件。

先读 [共同约束](README.md)。没有基线数据就不宣称性能提升；拆文件不等于改变状态机。

## E01

- [x] 让 WS 观察有版本、有界、可降级。依赖 A05、C04。建议 Sol。

**先读：** `apps/console/src/server.ts` 的 screen wait、WS pump、ACK、sync；RuntimeService queryEvents 的 durable flush；screen version；ADR 0020、0052。

**实施：** 定义版本化 observation bundle，至少分开 `screenVersion`、`durableEventCursor`、session generation、execution identity 与 persistenceLag/partial。屏幕和事件来自不同时间点时如实标注，不声称整个包是原子快照。Application 负责采样并在 async screen read 后重核 generation/目标，有限重试后返回明确变化状态，transport 不自做状态转移。

活跃屏幕可独立于 durable event flush 更新；这只解耦观察，不放松写入持久化。复用 C04 的 canonical cells，为样式变化也定义 dirty rows/delta；版本不连续就请求 bounded full frame。连接慢时合并尚未发送的最新屏幕，不能无限堆积每帧；事件使用 cursor 续读，不能像屏幕一样丢掉中间事实。

ACK 选择一种明确含义：确认客户端已应用 screenVersion，服务端只以此选 delta 基线；不作为数据库 durability ACK。旧 ACK 无意义时仍兼容解析，但新协议不得继续假装已提供背压。计划默认屏幕发送上限 30fps，可配置；有新输出才工作，空闲不持续全量 query。

**验收：** 空闲 RPC 次数接近等待/心跳所需而非连续 full query；高输出慢浏览器内存队列有界；断线重连版本缺口会全量同步；generation 切换不混旧屏幕；数据库观察延迟时显示 lag 而非假静默；审批/交互状态变化无屏幕输出时也及时送达。

**验证：** server WS tests 增加慢 consumer、ACK乱序、partial bundle；运行 `pnpm test:m5`、`pnpm test:m5:browser`、`pnpm test:m10:output`。提供相同 fixture 的帧数/字节/RPC 数前后记录和 L3 场景。不设无测量依据的延迟达标声明。

## E02

- [x] Byte ring 改为固定容量循环存储。依赖 B02。建议 Sol。

**先读：** `packages/executor-pty/src/bounded-byte-ring.ts` 的 append/读取路径及 `bounded-byte-ring.test.ts`；B02 输出 offsets 与现有消费者。

**实施：** 用固定容量 Buffer、start/length/absolute offsets 实现写入与读取，单次 append 成本与输入/保留的字节量相关，不能对整个已有历史反复 Buffer.concat。保留对外 API 和原始字节顺序；oversized chunk 只保留末尾容量并更新丢失水位。返回给调用方的数据不能引用之后会被覆盖的可变内部片段。

Unicode 语义放在 text 解码层：原始 byte ring 可从多字节中间开始，必须明确起点裁切/gap，不能谎称原文完整。不要改成以 JS 字符数计算 byte cursor。

**验收：** 容量0/最小合法容量（按原契约）、刚好容量、wrap、多次覆盖、超大 chunk、随机输入序列，结果与简单 reference buffer 一致；旧 read 结果在后续 append 后不变；中文跨界能按 B02 规则解释。

**验证：** 扩展现有 ring tests，运行 `pnpm exec vitest run --maxWorkers=1 packages/executor-pty/src/bounded-byte-ring.test.ts packages/application/src/execution-output.test.ts`。记录 1 KiB 高频 append 到大 ring 的前后耗时/分配量，测试不使用脆弱的绝对毫秒硬门槛。L1+可重复微基准。

## E03

- [x] 测量 FIFO/投影热点后做局部优化。依赖 E01、E02。建议 Sol。

**先读：** executor FIFO 轮询和 16 KiB Buffer 分配；screen write/capture；现有控制协议测试。

**实施顺序：**

1. 新增可重复 benchmark fixture，分空闲、持续 1 KiB 日志、高吞吐、多会话四种，记录 CPU、分配/RSS、snapshot 次数、输出到观察延迟和样本长度。
2. 先消除可证明的无谓分配：复用单 reader 的 scratch buffer；异步消费者拿到数据前必要复制，不能复用覆盖仍在处理的数据。
3. 屏幕快照按 dirty/version 与 consumer 需求合并，处理待捕获任务的 single-flight；仍确保 read/wait 看到之前已处理输出。不得通过丢失 version 变化达成少 capture。
4. 只有测量证明 2ms polling 为主要瓶颈，才另写 ADR 提案评估事件驱动 FIFO；本卡不切换控制通道和进程 guardian 协议。

**验收：** 相同 seed/负载输出内容、completion 顺序与 terminal replies 不变；空闲唤醒或分配减少有数据；压力下无死锁/饿死；若局部优化没有收益，允许只交付测量和不改动结论，不能伪报性能修复。

**验证：** `pnpm exec vitest run --maxWorkers=1 packages/executor-pty/src/control-protocol.test.ts packages/terminal-screen/src/index.test.ts apps/runtime-daemon/src/terminal-response.test.ts`，再运行本卡新增 benchmark 的明确命令。L2+具体压力范围，记录平台与负载。

## E04

- [x] 拆分 Application 内部职责而不改行为。依赖 A02、B07、D01。建议 Sol。

**先读：** `packages/application/src/runtime-service.ts`，以已完成卡修改后的代码为准。

**实施：** 先画依赖/状态所有权小表，再将纯 observation/query、execution waiter 管理、retention/cache 管理分三次局部提取到 application 内部模块。RuntimeService 继续是公共 facade；唯一 session mutation lane、状态转移、fencing 校验与 Action admission 所有权保持不变。新模块通过窄接口传入所需能力，不传整个 RuntimeService 或无约束 mutable store。

每次提取先运行对应定向测试。不要顺手重命名公开 DTO、改 async 顺序、移动事务边界、改变 catch 的错误分类。未能清晰分离的写状态机留在原处；不以单文件必须小于某行数作为验收。

**验收：** 已有并发/失败/幂等场景通过；import direction 正确，无循环依赖；服务公共 API 和事件顺序未变化；交付说明列出模块职责与仍保留热点。一个模块一个可审阅 diff，必要时把本卡实施分多次会话而非一次巨改。

**验证：** `pnpm test:m1`、`pnpm test:m6:interaction`、`pnpm test:m10:authorization`、`pnpm test:m10:secret`，运行 A01/B07 新测试；收尾 `pnpm verify`。不新增镜像每个内部 helper 的单测，复用行为测试。

## E05

- [x] 拆分 Console 控制器。依赖 C01、C02、C05、C06、D07、E01。建议 Luna。

**先读：** 当前 `web.tsx`，已提取的 submission-intent/terminal-renderer，session-tabs 等 helpers。

**实施：** 在保持页面 DOM 结构和 CSS 行为的前提下，分离 transport subscription、session navigation、approval inbox、诊断面板。优先抽纯视图和无副作用 selector，保留明确 props；Effect ownership 与 cleanup 只归一个 controller。不要为每个小按钮建一层通用框架或全局 event bus。

每一步只搬一种职责，保留请求取消、草稿 revision、generation guard、终端焦点恢复等保护。禁止一次把所有 state 移到新的第三方状态库。

**验收：** 页面交互/截图基本不变；mount/unmount/switch session 后 listener 不叠加；快速切换无旧响应覆盖；C01 的重复提交测试继续通过。

**验证：** 运行 Console 单测目录 `pnpm exec vitest run --maxWorkers=1 apps/console/src`，浏览器测试必须先 `pnpm build:console` 且具备隔离 DB；缺环境的 skip 如实报告。以 `pnpm test:m5:browser` 完成 L3 回归。此卡只重构，不补新的产品行为。

## E06

- [x] 必选集成测试不允许静默 skip。依赖 A02、B04、C01、C04、D04。建议 Sol。

**先读：** 根 `package.json`、`vitest.config.*`（若存在）、browser-shared-path 的 databaseUrl/browserReady gates、`scripts/check-verification.mjs`、当前 CI 配置。

**实施：** 保留普通本地测试便利性，新增显式 `verify:integration` 和 `verify:shared-path`（计划脚本名）。入口 preflight 检查隔离测试 DB、真实 PTY 依赖、Chrome 路径、已构建 Console；缺条件非零退出，不能打印 passed。执行结束校验所选核心测试实际运行数和 skip 数，必选场景有 skip 则失败。

核心集合至少含：Shell death、等待超时不杀执行、HTTP 同 key 重放、MCP 输出续读、UNKNOWN 核对、Console/Agent 共享输入、样式屏幕、凭据续期。用明确文件/用例名单，不按随意 grep 标题碰巧匹配。提供隔离环境搭建步骤，测试 secret 从环境读取但不回显。现有 generic `pnpm verify` 不必强迫每台机器装所有外部服务，但交付说明必须分开普通门禁与必选集成门禁。

**验收：** 刻意去掉 DB/Chrome 条件时必选脚本失败；正常隔离环境所有名单用例实跑；测试结束清理自有进程；验证记录显示 pass/skip/失败及证据级别，历史统计不冒充本次结果。

**验证：** 在隔离环境运行新脚本的缺环境测试与成功测试，然后 `pnpm verify`。实现脚本的错误路径可单测，但不能用脚本单测替代实际 L2/L3 核心场景。
