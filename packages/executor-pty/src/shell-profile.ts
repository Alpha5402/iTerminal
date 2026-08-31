import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ShellKind } from "@iterminal/domain";

export interface ShellLaunchProfile {
  readonly executable: string;
  readonly args: readonly string[];
  readonly dispatchCommandFile: string;
  readonly dispatchTokenFile: string;
  readonly env: Readonly<Record<string, string>>;
}

export function createShellLaunchProfile(
  shell: ShellKind,
  runtimeDirectory: string,
  controlFifo: string,
): ShellLaunchProfile {
  const dispatchCommandFile = join(runtimeDirectory, "dispatch-command");
  const dispatchTokenFile = join(runtimeDirectory, "dispatch-token");
  writeFileSync(dispatchCommandFile, "", { mode: 0o600 });
  writeFileSync(dispatchTokenFile, "", { mode: 0o600 });
  const dispatchEnvironment = {
    ITERMINAL_CONTROL_FIFO: controlFifo,
    ITERMINAL_DISPATCH_COMMAND_FILE: dispatchCommandFile,
    ITERMINAL_DISPATCH_TOKEN_FILE: dispatchTokenFile,
  };
  if (shell === "bash") {
    const rcFile = join(runtimeDirectory, "bashrc");
    writeFileSync(rcFile, bashRc(), { mode: 0o600 });
    return {
      args: ["--noprofile", "--rcfile", rcFile, "-i"],
      dispatchCommandFile,
      dispatchTokenFile,
      env: { ...dispatchEnvironment, BASH_SILENCE_DEPRECATION_WARNING: "1" },
      executable: "/bin/bash",
    };
  }
  const zshDirectory = join(runtimeDirectory, "zdotdir");
  mkdirSync(zshDirectory, { mode: 0o700 });
  writeFileSync(join(zshDirectory, ".zshrc"), zshRc(), { mode: 0o600 });
  return {
    args: ["-d", "-i"],
    dispatchCommandFile,
    dispatchTokenFile,
    env: { ...dispatchEnvironment, ZDOTDIR: zshDirectory },
    executable: "/bin/zsh",
  };
}

function bashRc(): string {
  return String.raw`
PS1='\u@\h \w \$ '
PS2='> '
unset HISTFILE
builtin history -c

__it_control() {
  builtin printf '%s\000%s\000%s\000%s\000' "$1" "$2" "$3" "$4" > "$ITERMINAL_CONTROL_FIFO"
}

__it_checkpoint_env() {
  local __it_key __it_value __it_encoded
  local __it_old_ifs="$IFS"
  IFS=','
  for __it_key in $ITERMINAL_CHECKPOINT_ENV_KEYS; do
    command /usr/bin/printenv "$__it_key" >/dev/null 2>&1 || continue
    __it_value="${"$"}{!__it_key}"
    [[ "$__it_value" == *$'\n'* ]] && continue
    __it_encoded="$(builtin printf '%s' "$__it_value" | command /usr/bin/base64 | command /usr/bin/tr -d '\n')"
    [[ "${"$"}{#__it_encoded}" -gt 5464 ]] && continue
    [[ "${"$"}{#__it_encoded}" -eq 5464 && "$__it_encoded" != *== ]] && continue
    builtin printf '%s=%s\n' "$__it_key" "$__it_encoded"
  done
  IFS="$__it_old_ifs"
}

__it_load_action() {
  local __it_buffer
  if [[ ! -s "$ITERMINAL_DISPATCH_TOKEN_FILE" ]]; then
    return
  fi
  __it_buffer="$(command cat -- "$ITERMINAL_DISPATCH_COMMAND_FILE"; builtin printf '\034')"
  __it_buffer="${"$"}{__it_buffer%$'\034'}"
  builtin history -s "$__it_buffer"
  __it_control 'PREEXEC' "$__it_buffer" ''
  builtin printf '\033[1A\r\033[2K'
}

__it_precmd() {
  local __it_status="$1"
  local __it_checkpoint __it_token
  [[ "$__it_status" =~ ^[0-9]+$ ]] || __it_status=1
  __it_status=$((__it_status & 255))
  if [[ -s "$ITERMINAL_DISPATCH_TOKEN_FILE" ]]; then
    IFS= builtin read -r __it_token < "$ITERMINAL_DISPATCH_TOKEN_FILE"
    : > "$ITERMINAL_DISPATCH_TOKEN_FILE"
    : > "$ITERMINAL_DISPATCH_COMMAND_FILE"
    builtin printf '\033]1337;iTerminalBarrier=%s\007' "$__it_token"
    __it_control 'RESULT' "$__it_status" ''
  fi
  __it_checkpoint="$(__it_checkpoint_env)"
  __it_control 'READY' "$__it_status" "$PWD" "$__it_checkpoint"
}

__it_control 'HELLO' 'bash' "$$"
bind -x '"\C-x\C-a":__it_load_action'
PROMPT_COMMAND='__it_precmd "$?"'
`;
}

function zshRc(): string {
  return String.raw`
PROMPT='%n@%m %~ %# '
PROMPT2='> '
autoload -Uz add-zsh-hook

__it_control() {
  builtin printf '%s\000%s\000%s\000%s\000' "$1" "$2" "$3" "$4" > "$ITERMINAL_CONTROL_FIFO"
}

__it_checkpoint_env() {
  local __it_key __it_value __it_encoded
  for __it_key in ${"$"}{(s:,:)ITERMINAL_CHECKPOINT_ENV_KEYS}; do
    command /usr/bin/printenv "$__it_key" >/dev/null 2>&1 || continue
    __it_value="${"$"}{(P)__it_key}"
    [[ "$__it_value" == *$'\n'* ]] && continue
    __it_encoded="$(builtin printf '%s' "$__it_value" | command /usr/bin/base64 | command /usr/bin/tr -d '\n')"
    [[ "${"$"}{#__it_encoded}" -gt 5464 ]] && continue
    [[ "${"$"}{#__it_encoded}" -eq 5464 && "$__it_encoded" != *== ]] && continue
    builtin printf '%s=%s\n' "$__it_key" "$__it_encoded"
  done
}

__it_load_action() {
  local __it_buffer
  if [[ ! -s "$ITERMINAL_DISPATCH_TOKEN_FILE" ]]; then
    BUFFER=''
    CURSOR=0
    return
  fi
  __it_buffer="$(command cat -- "$ITERMINAL_DISPATCH_COMMAND_FILE"; builtin printf '\034')"
  BUFFER="${"$"}{__it_buffer%$'\034'}"
  CURSOR="${"$"}{#BUFFER}"
  __it_control 'PREEXEC' "$BUFFER" ''
}

__it_precmd() {
  local __it_status=$?
  local __it_token
  if [[ -s "$ITERMINAL_DISPATCH_TOKEN_FILE" ]]; then
    IFS= builtin read -r __it_token < "$ITERMINAL_DISPATCH_TOKEN_FILE"
    : > "$ITERMINAL_DISPATCH_TOKEN_FILE"
    : > "$ITERMINAL_DISPATCH_COMMAND_FILE"
    builtin printf '\033]1337;iTerminalBarrier=%s\007' "$__it_token"
    __it_control 'RESULT' "$__it_status" ''
  fi
  local __it_checkpoint="$(__it_checkpoint_env)"
  __it_control 'READY' "$__it_status" "$PWD" "$__it_checkpoint"
}

__it_control 'HELLO' 'zsh' "$$"
zle -N __it_load_action
bindkey '\e[99~' __it_load_action
add-zsh-hook precmd __it_precmd
`;
}
