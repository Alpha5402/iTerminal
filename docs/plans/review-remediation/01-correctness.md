# A：运行语义与请求身份

先读 [共同约束](README.md)。以下路径相对仓库根目录。所有测试名字为应增加的场景描述；新增文件会明确标识。

## A01

- [ ] Shell 生命周期向 Application 传播。依赖：无。建议 Sol。

**问题与结果：** 目前 executor 的空闲 Shell 退出没有活动 execution 可供失败回调，Application 可继续显示 READY。任何非主动关闭的当前 generation Shell 退出后，Application 必须停止接受新 Execute，按现有状态机进入 BROKEN。

**先读：** `packages/executor-pty/src/pty-shell-executor.ts` 的 PTY `onExit`、`#fail`；`packages/application/src/ports.ts` 的 `CreateExecutorOptions`；`packages/application/src/runtime-service.ts` 的 executor 创建、close/rebuild、失败收尾；ADR 0001、0003、0045。

**实施：**

1. 在 executor port 增加生命周期通知，携带 owner 已绑定的 session/generation、退出原因及可观测 exit 信息；回调不直接改 domain/store。
2. Application 把通知放入已有 session mutation lane，核对 executor 身份及 generation。重复通知幂等；旧 generation 通知不能破坏新 generation。
3. 区分用户主动 close、创建未完成、READY、RUNNING 的退出。主动 close 不额外制造失败；READY 退出产生持久失效事实。RUNNING 使用已有未知交付规则收尾，不能因为 Shell 死亡就编造 command exitCode。
4. 清理 executor/guardian/监听器，完成或拒绝相关等待者；失败日志不得记录命令秘密。更新状态转移 ADR 与事件原因说明。

**验收场景：** READY 下杀掉测试拥有的 Shell，最终读到 BROKEN，后续 Execute 无 PTY 写入；RUNNING 下退出只有一次收尾；旧 generation 延迟 onExit 不影响 rebuild；主动 close 无重复 broken 事件；启动过程中退出不会发布假 READY。

**验证：** 扩展 `packages/application/src/runtime-service.test.ts`；新增 `apps/runtime-daemon/src/shell-lifecycle.test.ts` 真实 PTY 用例。运行 `pnpm exec vitest run --maxWorkers=1 packages/application/src/runtime-service.test.ts apps/runtime-daemon/src/shell-lifecycle.test.ts`。至少 L2；测试必须只 kill 自己的 fixture PID。

**不做：** 自动 rebuild、恢复旧 Shell、把数据库状态当进程存活证据。

## A02

- [ ] 移除隐式执行寿命并收紧异常清理。依赖：A01。建议 Sol。

**先读：** executor 的 24 小时计时器与 `execute`；Application 的 `failDispatchedExecution`、execution completion；现有启动超时与 drain ADR。

**实施：**

1. 删除“运行到 24h 自动 reject”的隐式执行计时器。保留启动握手、观察等待和 shutdown/drain 等各自有语义的计时器，不全局删除 timeout。
2. 检查每条 executor fatal 路径：如果 Application 已宣告本 generation 不可写，底层 executor 必须进入一致的失效/释放路径，不能留下可运行却无控制入口的 Shell。
3. 写一张失败矩阵到新 ADR：尚未写入 / 已写入无 completion / 有真实 completion，分别沿现有 FAILED / UNKNOWN / 已观察结果规则结算。不能把所有异常统一 FAILED。
4. 测试通过注入时钟或调度器检查计时器用途，不在测试里等待 24 小时，不使用全局替换任意 setTimeout 的生产设计。

**验收：** 推进虚拟时钟超过旧上限不会改变 RUNNING 或关闭 executor；真实长于“观察等待”的短 sleep 在等待返回后仍可由另一个请求观察和控制；真实 fatal 后没有孤儿 fixture 进程；startup timeout 仍生效。

**验证：** 扩展 A01 新测试和 `runtime-service.test.ts`；运行 A01 命令及 `pnpm exec vitest run --maxWorkers=1 packages/executor-pty/src`。至少 L2。不新增用户可配置 execution deadline。

## A03

- [ ] 对齐 Execute/Input schema。依赖：无。建议 Luna。

**先读：** `packages/protocol/src/schemas.ts`；domain 请求类型；RPC、HTTP、MCP 对应 Execute/Input schema；现有 `line-input.test.ts` 与 ADR 0065。

**实施：** 为公开 Execute schema 补齐当前已支持的 `approvalId`，为 Input 补齐 `lineInput`，字段类型、optional/required、值域从当前 domain/application 的真实契约取得。保留 `additionalProperties: false`。补充一组共享有效/无效 fixture，分别经过公开 schema 与对应适配器解析；明确 body 中 actor 不授予权限。

**验收：** 有/无 approvalId、有/无 lineInput 的合法请求在各入口一致；未知字段、错误类型、非法 generation 都被拒绝；空行等语义仍由现有规则处理，不因补 schema 放宽。

**验证：** 新增 `packages/protocol/src/schemas.test.ts`，使用现有依赖可用的验证器或 schema 消费路径，禁止只比对字符串是否包含字段。运行 `pnpm exec vitest run --maxWorkers=1 packages/protocol/src/schemas.test.ts apps/mcp/src/line-input.test.ts apps/console/src/server.test.ts`。

**边界：** 本卡不重构整个协议包。L1 完成即可；后续 A05 逐步统一来源。

## A04

- [ ] 去除 HTTP 中先于幂等判断的状态决策。依赖：无。建议 Sol。

**先读：** `apps/console/src/server.ts` 的 Execute 路由、`requireRunningTarget`、Input/Control；Application 各写方法的幂等 lookup 与 guard 顺序。

**实施：** HTTP 只保留认证、body 形状/大小校验和适配；READY/RUNNING/target freshness 交给 Application 的现有顺序判断。检查所有写入口，不能只修 Execute 而留下 Input/Control。对相同已认证 actor、key、payload 的重复请求，返回同一 Action/Execution；同 key 不同 payload 仍冲突。

**验收：** 首次接受的 Execute 完成后重发同请求返回原身份且不再次写 PTY；Input/Control 接受后 target 状态变化，重发仍得到原事实；新 key + 旧 execution 仍拒绝；假冒 actor、无效 grant、越权请求在重放路径也不得读取原结果。

**验证：** `pnpm exec vitest run --maxWorkers=1 apps/console/src/server.test.ts packages/application/src/runtime-service.test.ts packages/application/src/authorization-matrix.test.ts`。用 fake executor 的 write counter 验证次数，并新增真实 HTTP 丢响应后核对测试达到 L2。不要声称不同 principal 的请求天然共享幂等域。

## A05

- [ ] 增加运行能力握手并建立新契约统一来源。依赖：A03。建议 Sol。

**先读：** `packages/protocol`、`packages/runtime-rpc/src/index.ts`、`apps/mcp/src/server.ts`、Console bootstrap、router dispatch。

**实施：**

1. 在 protocol 包新增 transport DTO/schema 模块，允许它依赖 domain，禁止 domain 反向依赖 transport。复用仓库 Zod 版本。先统一 Execute/Input 公共字段和本计划新增接口；actor 绑定、HTTP/RPC 包装仍由适配器负责。
2. 新增只读 `runtime.capabilities` RPC 与 MCP `runtime_capabilities`（计划名称），返回 `protocolVersion`、`buildId`、`features`。buildId 来自构建/启动版本标识，可明确 unknown，不返回源码路径或 token。
3. features 只列实际实现能力。后续卡完成才注册相应 feature。router 分清自身与目标 owner 能力，不把某 owner 支持宣称为所有 owner 支持。
4. Console bootstrap 显示兼容状态；新功能检测 capability 再启用。老服务无握手时明确 legacy，并沿已支持入口工作，不猜测磁盘代码等于运行能力。

**验收：** 新客户端/旧服务、新服务/旧客户端、router 下混合 owner 三类组合；unsupported feature 有明确反馈；服务版本变更需要重新握手；认证继续按现有读权限执行。新契约 schema 与 handler 使用同一来源。

**验证：** `pnpm exec vitest run --maxWorkers=1 packages/protocol/src/schemas.test.ts packages/runtime-rpc/src/index.test.ts apps/mcp/src/mcp-stdio.test.ts apps/console/src/server.test.ts apps/runtime-router/src/server.test.ts`；记录版本策略 ADR。L1 加一次真实 MCP 握手 L2。不要一次迁移所有旧接口。

## A06

- [ ] 提供按请求身份的 Action 核对接口。依赖：A05。建议 Sol。

**先读：** Application 幂等路径、`ports.ts` 的 durability/repository 接口、`postgres-runtime-durability.ts`、RPC grants、Console actor 绑定；ADR 0011、0056。

**新增契约：** `action.lookup` RPC / `action_lookup` MCP，HTTP 使用同一服务。请求为 sessionId、generation、idempotencyKey，actor 从认证上下文得到。返回带 discriminant 的 `found / not_found / expired / unavailable`；found 至少含 actionId、executionId（若有）、接受/交付/终态的实际状态，不附秘密输入或整条内部 actor/capabilities。

**实施：** 优先查当前事实，必要时查持久记录；保持已有幂等域，不允许通过更换 actor 读取他人 action。found 只报告事实，不再次执行。expired 必须有真实 retention 依据；无法区分就不得伪报 expired。跨 generation 精确匹配，不返回新 generation 的同 key。

**关键语义：** not_found 带明确说明“本次查询未发现，不排除原请求仍在途”；客户端不能据此自动重新生成 key。要实现确定拒绝/取消尚未到达请求，需要额外 admission 协议，不在本卡范围。

**验收：** 接受但响应丢失仍查到原 action；查询先于延迟到达的原请求时先 not_found 后 found；同 key 跨 actor/gen 不串；数据库不可用返回 unavailable，不能伪装 not_found；UNKNOWN 如实保留，核对无 PTY 写入。

**验证：** 增加 application / RPC / MCP / HTTP 契约用例及 PG integration，运行 `pnpm test:m10:authorization`、`pnpm test:m10:console`、`pnpm test:m4:durable`，另运行本卡新增测试的明确文件路径并记入证据。至少 L2。
