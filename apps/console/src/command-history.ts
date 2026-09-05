export interface CommandHistoryEntry {
  readonly eventId: string;
  readonly sequence: number;
  readonly command: string;
}

interface HistoryEvent {
  readonly actor?: { readonly id: string; readonly type: string };
  readonly id: string;
  readonly sequence: number;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export const MAX_COMMAND_HISTORY_ENTRIES = 100;
export const MAX_COMMAND_HISTORY_CHARACTERS = 65_536;

export function mergeCommandHistory(
  current: readonly CommandHistoryEntry[],
  events: readonly HistoryEvent[],
  actorId: string,
): readonly CommandHistoryEntry[] {
  const byEvent = new Map(current.map((entry) => [entry.eventId, entry]));
  for (const event of events) {
    const command = event.payload.observedCommand;
    if (
      event.type !== "execution.started" ||
      event.actor?.type !== "human" ||
      event.actor.id !== actorId ||
      typeof command !== "string" ||
      command.trim() === "" ||
      command.length > MAX_COMMAND_HISTORY_CHARACTERS
    )
      continue;
    byEvent.set(event.id, { eventId: event.id, sequence: event.sequence, command });
  }
  const recent: CommandHistoryEntry[] = [];
  let characters = 0;
  for (const entry of [...byEvent.values()].sort((a, b) => b.sequence - a.sequence)) {
    if (recent.at(-1)?.command === entry.command) continue;
    if (
      recent.length === MAX_COMMAND_HISTORY_ENTRIES ||
      characters + entry.command.length > MAX_COMMAND_HISTORY_CHARACTERS
    )
      break;
    recent.push(entry);
    characters += entry.command.length;
  }
  recent.reverse();
  return recent.length === current.length &&
    recent.every((entry, index) => {
      const prior = current[index];
      return (
        prior?.eventId === entry.eventId &&
        prior.sequence === entry.sequence &&
        prior.command === entry.command
      );
    })
    ? current
    : recent;
}

export function commandHistoryKey(actorId: string, sessionId: string, generation: number): string {
  return `iterminal.command-history.${JSON.stringify([actorId, sessionId, generation])}`;
}

export function readCommandHistory(
  storage: Pick<Storage, "getItem">,
  key: string,
): readonly CommandHistoryEntry[] {
  try {
    const raw = storage.getItem(key);
    if (raw === null || raw.length > MAX_COMMAND_HISTORY_CHARACTERS * 8) return [];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > MAX_COMMAND_HISTORY_ENTRIES) return [];
    const entries: CommandHistoryEntry[] = [];
    for (const candidate of value as unknown[]) {
      if (typeof candidate !== "object" || candidate === null) return [];
      const entry = candidate as Partial<CommandHistoryEntry>;
      if (
        typeof entry.eventId !== "string" ||
        entry.eventId.length > 256 ||
        typeof entry.sequence !== "number" ||
        !Number.isSafeInteger(entry.sequence) ||
        entry.sequence < 1 ||
        typeof entry.command !== "string" ||
        entry.command.trim() === "" ||
        entry.command.length > MAX_COMMAND_HISTORY_CHARACTERS
      )
        return [];
      entries.push(entry as CommandHistoryEntry);
    }
    return mergeCommandHistory(entries, [], "");
  } catch {
    return [];
  }
}

/** Snapshot navigation so arriving Events cannot shift an in-progress history selection. */
export class CommandHistoryNavigation {
  #commands: readonly string[] | undefined;
  #index = 0;
  #draft = "";

  public reset(): void {
    this.#commands = undefined;
    this.#draft = "";
    this.#index = 0;
  }

  public move(
    direction: "older" | "newer",
    currentDraft: string,
    history: readonly CommandHistoryEntry[],
  ): string | undefined {
    if (this.#commands === undefined) {
      if (direction === "newer" || history.length === 0) return undefined;
      this.#commands = history.map((entry) => entry.command);
      this.#index = this.#commands.length;
      this.#draft = currentDraft;
    }
    this.#index = Math.max(
      0,
      Math.min(this.#commands.length, this.#index + (direction === "older" ? -1 : 1)),
    );
    if (this.#index === this.#commands.length) {
      const draft = this.#draft;
      this.reset();
      return draft;
    }
    return this.#commands[this.#index];
  }
}
