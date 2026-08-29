import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ShellKind } from "@iterminal/domain";

export interface ShellLaunchProfile {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function createShellLaunchProfile(
  shell: ShellKind,
  runtimeDirectory: string,
  controlFifo: string,
): ShellLaunchProfile {
  if (shell === "bash") {
    const rcFile = join(runtimeDirectory, "bashrc");
    writeFileSync(rcFile, bashRc(), { mode: 0o600 });
    return {
      args: ["--noprofile", "--rcfile", rcFile, "-i"],
      env: { ITERMINAL_CONTROL_FIFO: controlFifo },
      executable: "/bin/bash",
    };
  }
  const zshDirectory = join(runtimeDirectory, "zdotdir");
  mkdirSync(zshDirectory, { mode: 0o700 });
  writeFileSync(join(zshDirectory, ".zshrc"), zshRc(), { mode: 0o600 });
  return {
    args: ["-d", "-i"],
    env: { ITERMINAL_CONTROL_FIFO: controlFifo, ZDOTDIR: zshDirectory },
    executable: "/bin/zsh",
  };
}

function bashRc(): string {
  return String.raw`
PS1='iterminal:bash$ '
PS2='iterminal:bash> '
__IT_PREEXEC_EMITTED=0

__it_control() {
  builtin printf '%s\000%s\000%s\000' "$1" "$2" "$3" > "$ITERMINAL_CONTROL_FIFO"
}

__it_execute() {
  trap - DEBUG
  command /bin/bash --noprofile --norc -n -c "$1"
  local __it_syntax_status=$?
  if [[ "$__it_syntax_status" -ne 0 ]]; then
    trap '__it_debug' DEBUG
    builtin printf '\033]1337;iTerminalBarrier=%s\007' "$2"
    __it_control 'RESULT' "$__it_syntax_status" ''
    return "$__it_syntax_status"
  fi
  builtin eval "$1"
  local __it_status=$?
  trap '__it_debug' DEBUG
  builtin printf '\033]1337;iTerminalBarrier=%s\007' "$2"
  __it_control 'RESULT' "$__it_status" ''
  return "$__it_status"
}

__it_debug() {
  local __it_previous_status=$?
  if [[ "${"$"}{FUNCNAME[1]:-}" == "__it_execute" || "${"$"}{FUNCNAME[1]:-}" == "__it_precmd" ]]; then
    return "$__it_previous_status"
  fi
  if [[ "$__IT_PREEXEC_EMITTED" -eq 0 ]]; then
    __it_control 'PREEXEC' "$BASH_COMMAND" ''
    __IT_PREEXEC_EMITTED=1
  fi
  return "$__it_previous_status"
}

__it_precmd() {
  local __it_status="$1"
  __IT_PREEXEC_EMITTED=0
  __it_control 'READY' "$__it_status" "$PWD"
}

__it_control 'HELLO' 'bash' "$$"
trap '__it_debug' DEBUG
PROMPT_COMMAND='__it_precmd "$?"'
`;
}

function zshRc(): string {
  return String.raw`
PS1='iterminal:zsh%# '
PS2='iterminal:zsh> '
autoload -Uz add-zsh-hook

__it_control() {
  builtin printf '%s\000%s\000%s\000' "$1" "$2" "$3" > "$ITERMINAL_CONTROL_FIFO"
}

__it_execute() {
  builtin eval "$1"
  local __it_status=$?
  builtin printf '\033]1337;iTerminalBarrier=%s\007' "$2"
  __it_control 'RESULT' "$__it_status" ''
  return "$__it_status"
}

__it_preexec() {
  __it_control 'PREEXEC' "$1" ''
}

__it_precmd() {
  local __it_status=$?
  __it_control 'READY' "$__it_status" "$PWD"
}

__it_control 'HELLO' 'zsh' "$$"
add-zsh-hook preexec __it_preexec
add-zsh-hook precmd __it_precmd
`;
}
