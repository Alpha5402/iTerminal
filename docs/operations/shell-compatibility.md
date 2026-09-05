# Managed Shell 兼容范围

本文描述 iTerminal 当前受管理的 bash/zsh，而不是用户本机 Terminal 的完整复刻。状态标签含义：
**源码确认**=由当前实现核对；**实测**=已有隔离测试/验证证据；**尚未支持**=明确延期。

## 当前能力

| 项目            | 状态                       | 说明                                                                                                                                                                                                                                            |
| --------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell 启动      | 源码确认；实测             | 仅支持 `/bin/bash` 与 `/bin/zsh`。bash 以 `--noprofile --rcfile <私有文件> -i` 启动；zsh 以 `-d -i` 启动并设置私有 `ZDOTDIR`。PTY 使用 `xterm-256color` 和运行时 canonical geometry。                                                           |
| 用户 rc/profile | 源码确认                   | 不读取用户 `.bash_profile`/`.bashrc`/`.zshrc`；运行时生成 mode `0600` 的最小 hook 文件。不要依赖用户 prompt、插件或外部 hook；同一 OS 用户仍可发现私有资源，这不是 sandbox。                                                                    |
| 初始环境        | 源码确认                   | 子 Shell 只继承受控基础环境（PATH、TERM 与存在的 locale/TMPDIR）、运行时 FIFO/dispatch 变量，以及 fork 内部恢复的 allowlisted checkpoint environment；普通创建请求不能注入任意环境，也不是完整父进程环境复制。敏感变量不会自动成为 checkpoint。 |
| cwd 与 `cd`     | 实测；源码确认             | `cd` 在持久 top-level Shell 中执行，后续命令继续使用新 cwd。`pwd`、环境和 job 状态由真实 Shell 持有，不由 Runtime 模拟。                                                                                                                        |
| checkpoint/fork | 实测；源码确认             | checkpoint 保存 workspace、cwd、Shell 类型和 allowlisted、过滤后的环境。fork 创建新 Session/generation/PTY/Shell；共享 workspace 文件，但不复制进程、REPL/editor、fd、job、alias/function/trap。                                                |
| history         | 源码确认                   | managed bash 清空 history 且不设置 HISTFILE；zsh 使用私有非登录启动。Runtime dispatch 仅为恢复命令行显示临时写入内存 history，不承诺用户历史文件兼容。                                                                                          |
| READY 编辑      | 实测；源码确认             | READY 使用 Console command composer；Enter 将整个 draft 作为一次 ExecuteAction。多行粘贴保留换行，READY 不等于 raw terminal。                                                                                                                   |
| RUNNING 行输入  | 源码确认；实测             | 默认是本地 foreground line draft；提交时使用 exact generation/execution 与 `lineInput` 版本。只适合已知 newline-delimited、可打印 LF 行接口；草稿留在浏览器内。                                                                                 |
| RUNNING raw/TUI | 源码确认；尚未支持完整兼容 | Advanced raw mode 逐键发送 InputAction，并受 Human Guard；Ctrl+C/D/Z 是显式 ControlAction，密码走 Human-only secret channel。它不保证任何 TUI 的完整行为。                                                                                      |
| 输出/边界       | 源码确认                   | PTY 是合并字节流，不保证 stdout/stderr 归属。PREEXEC/RESULT/READY 来自独立 control FIFO；Shell 退出是 generation 生命周期事实，不是命令成功证据。                                                                                               |

## 输入决策

普通命令用 READY Execute；运行中的已知逐行程序可用 line input，例如在重新观察后提交 `status\n`。Python/Node 等 REPL、vim/less、确认提示和密码提示可能拥有自己的编辑协议，应使用当前模式允许的 Input/Control/secret 路径。多行 foreground paste 不能被 lineInput 自动压扁或执行。

Tab 不保证 Shell completion：READY 草稿是浏览器编辑器，RUNNING 行模式只提交一整行；raw 模式才可能把 Tab 作为单键送入程序，但程序可能把它用于补全、焦点、缩进或别的协议。Shell readline/ZLE 的真实 completion、用户 profile 导入和跨程序语义不属于当前保证。

## Current / Planned

| Current（已实现或有证据）                                                                                                                                                                            | Planned / 尚未支持                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| managed bash/zsh、clean-room 启动、不自动 source 用户 rc；持久 cwd/env；过滤 checkpoint/fork；READY 多行 Execute；RUNNING line/raw 入口；精确 generation/execution、Guard、UNKNOWN 与合并 PTY 输出。 | C02 的完整产品化交互仍未完成；真实 READY readline/tab completion；profile 导入；完整 mouse/图片协议；任意 TUI 兼容；inputContext `unknown` 自动恢复；把用户确认当作程序边界证据。 |

用户看到 prompt 或点击确认，只是 UI 观察/意图，不会改变这些程序边界，也不能证明 command completion、Shell readiness 或未知输入已安全恢复。

## 依据

实现依据包括 `packages/executor-pty/src/shell-profile.ts`、`pty-shell-executor.ts`、Console 输入状态与 `packages/application/src/input-context.ts`；语义依据为 ADR-0003、ADR-0060、ADR-0065、ADR-0066。已有 bash/zsh、checkpoint/fork、line input 与 Console 验证只证明各自覆盖范围，不代表所有用户配置、TUI、平台或长期运行均兼容。
