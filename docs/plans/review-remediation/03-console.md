# C：Console 真实操作体验

当前状态：本轮卡已按约定范围验收；具体等级与未做事项见 [最终对账](final-reconciliation.md)。下文保留原验收条件。

先读 [共同约束](README.md)。这里的截图与浏览器测试必须来自实际页面；只通过组件单测不能声称用户流程完成。

## C01

- [x] 保留提交意图并提供 UNKNOWN 核对。依赖 A04、A06。建议 Sol。

**先读：** `apps/console/src/web.tsx` 的 READY submit、foreground submit、草稿更新和 pending；`command-history.ts`；ADR 0066。

**实现：** 新增 `apps/console/src/submission-intent.ts`，以 reducer/显式状态记录 sessionId、generation、executionId（适用时）、draftRevision、冻结 payload、idempotencyKey、actionId（已知时）与 `idle / submitting / uncertain / accepted / rejected`。这些是前端状态，不替代服务端 Action 状态。

Enter 在一个未决意图上不能创建新 key；网络错误进入 uncertain，保留原身份，提供“核对结果”。核对调用 A06，不发送写请求；not_found/unavailable 仍保留不确定并显示原因。确定的准入前拒绝才允许编辑后新建意图。accepted 后仅清理与原 draftRevision 相同的草稿，不清除用户等待时新写的文字；切 session 不把结果应用到另一个页面。

统一 READY/foreground 的 pending 逻辑；不要把 Input 与 Execute 的服务端语义混为一类。秘密输入不进 localStorage/sessionStorage/history，不把 payload 写日志。第一版意图仅内存保存：刷新会丢失核对身份，页面需在有未决提交时提示离开风险；不能声称跨刷新恢复。

**验收：** 丢响应后反复 Enter 只有一次写入；延迟旧响应不清新草稿；切会话、generation 更新、重复点击核对、先 not_found 后 found；收到确定 validation 拒绝后可改稿；UNKNOWN 不出现自动重试按钮语义。

**验证：** 新增 `submission-intent.test.ts`；HTTP tests 注入丢响应；扩展 `browser-shared-path.test.ts`。运行新单测、`pnpm test:m5`、`pnpm test:m5:browser`。浏览器真实共享路径至少 L3；未提供隔离 DB 时仅能标已实现待 L3 验证。

## C02

- [x] 将输入模式放在主操作区。依赖 C01。建议 Sol。

**先读：** `web.tsx` 的 foregroundLineVisible、rawTUI、onData/键盘处理；`input-context.ts`、lineInput 校验；ADR 0065、0066。

**实现：** RUNNING 主操作区显示“行输入 / 原始按键”切换及当前目标，不把 raw 模式藏 Advanced。初始保留当前行模式以避免无意发送按键；选 raw 后在当前 execution 内保持，execution 改变后明确重置提示。切换保留本地草稿，不发送或清空 PTY；raw 只有显式焦点落到终端才发送，提交前继续检查准确目标和现有权限。

行模式空草稿 Enter 显示“若要发送空回车，请切到原始按键”，不要悄悄增加 `lineInput` 空字符串特例。原始模式 Enter、Tab、箭头使用已有受控 Input Action；若某按键尚无受支持路径，明确禁用并记录，不绕过 Application 直接连 PTY。READY 仍使用命令编辑器，不声称它支持真实 Shell Tab completion。

**验收：** Python/Node REPL 中行提交与显式空回车；交互菜单箭头；全屏程序退出；中英文 IME 不双发；从 raw 切回行不发送未提交文字；Human 本地草稿存在时 Agent 行输入不会携带草稿；旧 execution 的按键被拒绝。

**验证：** `pnpm test:m6:interaction`、`pnpm exec vitest run --maxWorkers=1 apps/mcp/src/line-input.test.ts`、`pnpm test:m5:browser`。新增截图展示两模式和目标变化。L3，支持程序范围按实测列出，不宣称所有 TUI。

## C03

- [x] 不确定输入状态给出准确解释和已有操作。依赖 C02。建议 Luna。

**先读：** `packages/application/src/input-context.ts` 的 unknownReason，runtime 对 Control/Secret 标记，Console 错误呈现。

**实现：** 使用已有可暴露的 reason 区分“原始按键后无法跟踪程序行缓冲”与“某次写入是否送达未知”。不向前端暴露秘密字节。如果传输 DTO 缺 reason，仅增加受控枚举映射，不改状态转移。

对 untracked：显示行输入为何暂不可用，提供切原始按键、查看执行状态、现有受权限控制的中断入口。对 delivery unknown：优先核对 Action，提示无法通过重发判断是否送达。用户主动中断必须仍走已有 Control Action，并呈现其实际结果。

**验收：** Control、Secret 完成、原始输入等触发后的提示互相可区分；没有“已恢复 known”假提示；操作入口受当前 execution/generation 和权限控制；屏幕出现换行不会自动消除 unknown。

**验证：** 为纯提示映射新增局部测试，扩展 Console server/browser 对已有路径的用例；运行 `pnpm exec vitest run --maxWorkers=1 packages/application/src/input-context.test.ts apps/console/src/server.test.ts` 和 `pnpm test:m5:browser`。L1+L3。

**有意未做：** 真正自动恢复 tracked 输入需要可靠的程序边界证据，目前不能从屏幕推导。不给 Luna 设计新的 reset/force bypass API；F01 记录这一限制。

## C04

- [x] Console 使用 canonical cell 样式。依赖 A05。建议 Sol。

**先读：** ADR 0022；`packages/terminal-screen/src/index.ts` 的 cells/snapshot/version；`web.tsx` 的 xterm 初始化和 `renderScreen`；ADR 0062、0064。

**实现：** 复用现有 `TerminalScreenCell`，新增适用于当前受控几何范围的 Console frame DTO（当前 cells 工具最大 120×40，不能直接拿它当 240×100 全屏）。frame 含 geometry、screenVersion、cursor 与有界 cells；一次 frame 里的 cells/cursor 来自同次投影。新端点依权限与 generation 校验，旧 screen 工具不变。

提取 `apps/console/src/terminal-renderer.ts`。只从规范化 cells 生成受控 cursor/SGR 绘制，字符文本过滤控制字节，绝不重放原始输出 OSC。保留 palette/RGB、bold、inverse、styled blanks、宽字/组合字符、invisible 显示空白、cursor。全量 frame 先保证正确，E01 再做 delta；resize 仅几何变化时调用，避免每次清屏重建。

**验收：** 红色错误、RGB 背景、反色选择、中文/emoji、样式空格、invisible、软换行、宽字边缘与真实 headless 投影一致；窗口缩放不会覆盖终端回复/CPR 逻辑；程序不能通过绘制字符串触发 clipboard OSC。

**验证：** 扩展 screen tests，新增 `terminal-renderer.test.ts` 并加浏览器截图断言关键颜色/布局；运行 `pnpm exec vitest run --maxWorkers=1 packages/terminal-screen/src/index.test.ts packages/terminal-screen/src/copy.test.ts apps/console/src/terminal-renderer.test.ts apps/runtime-daemon/src/terminal-response.test.ts`、`pnpm test:m5:browser`。至少 L3。图片、鼠标、超链接协议不属于本卡。

## C05

- [x] 提供有限且真实的滚动历史。依赖 C04。建议 Sol。

**先读：** headless scrollback、screen history、copy helpers、Console selection。当前 xterm scrollback=0 与定期清屏不能直接当作历史来源。

**实现：** 由 canonical normal buffer 提供 history range，不从当前屏幕反复拼接行。新增 generation 范围的 history cursor、行号基点、保留上限和 droppedBefore；分页默认 100 行、上限 500 行，并遵守响应字节上限。alternate screen 不把每一帧积累成命令历史；切回 normal buffer 恢复对应历史。

Console 将“跟随底部”和“浏览历史”分开：滚动离开底部后新输出不强拉回，显示回到底部按钮；选择复制遵守 soft-wrap，styled cells 的纯文本复制正确。重建 generation 后清楚区分历史与新 live viewport，不能将旧记录作为新屏幕。

**验收：** 打印超过屏幕高度和保留上限的编号行，分页无重复/漏行，淘汰明确；滚动时持续输出不抢位置；宽字符/软换行复制；进入退出全屏程序不污染历史；切 session 不串数据。

**验证：** 增加 screen history 和 renderer/browser 用例；运行 `pnpm exec vitest run --maxWorkers=1 packages/terminal-screen/src`、`pnpm test:m5:browser`。L3。历史页是观察，不能通过前端修改 PTY 行数来获取旧输出。

## C06

- [x] 简化主界面并修正布局。依赖无。建议 Luna。

**先读：** `apps/console/src/web.tsx`、`styles.css`、session-tabs/terminal-fit、Session create 路由。先实际打开独立测试 Console 截图再调整。

**实现：** 主区域优先显示会话可读名称、当前目录（真实可用时）、运行/断开状态、输入目标与核心操作。UUID、screenVersion、internal next 等移动到可展开诊断区；不删诊断能力。已有 label 机制优先复用；若没有，首版只做本地 label 并说明不会跨客户端同步，不在此卡加数据库字段。

移除 body `min-width:1120px` 导致裁切的约束，允许面板折叠/合理滚动；终端尺寸继续由现有 fit Application resize 流程管理。新建会话提供目录字段：默认选当前已知 workspaceRoot/服务端配置默认目录，没有就要求填写；不能固定 `/` 或把显示 cwd 当成用户授权根目录扩大权限。

所有图标按钮有可访问名称，键盘焦点可见；错误旁显示可执行操作而非只有内部错误码。此卡不引入 UI 组件库，不改新会话幂等协议。

**验收：** 1024×768、1440×900、200% 浏览器缩放下核心输入/提交/会话切换/错误操作可达；纯键盘创建会话和打开诊断；目录为空/无权限/不存在有明确反馈；已有会话列表不会因布局调整丢失。

**验证：** 更新相关 browser tests；运行 `pnpm exec vitest run --maxWorkers=1 apps/console/src/session-tabs.test.ts apps/console/src/terminal-fit.test.ts apps/console/src/server.test.ts`、`pnpm test:m5:browser`。交付前后截图和实际 viewport，至少 L3。
