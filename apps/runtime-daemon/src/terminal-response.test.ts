import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  ACTOR_CAPABILITY_PROFILES,
  TERMINAL_RESPONSE_ACTOR,
  type InputAction,
} from "@iterminal/domain";
import { startRuntimeDaemon, type RuntimeDaemonHandle } from "./server.js";

const human = {
  id: "human_terminal_response_test",
  type: "human" as const,
  principal: "terminal-response-test",
  client: "test",
  capabilities: ACTOR_CAPABILITY_PROFILES.human,
};
let daemon: RuntimeDaemonHandle | undefined;
let root = "";
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  if (root !== "") await rm(root, { recursive: true, force: true });
  root = "";
});

const queryProgram = `import os,tty,select,time
tty.setraw(0)
os.write(1,b'READY\\r\\n')
os.read(0,1)
os.write(1,b'\\x1b[3;7H\\x1b[6n')
reply=b''
while not reply.endswith(b'R'):
 if not select.select([0],[],[],1)[0]: raise RuntimeError('cursor response timed out')
 reply+=os.read(0,1)
os.write(1,b'\\r\\nREPLY='+reply.hex().encode()+b'\\r\\n')
time.sleep(10)
`;

async function setup(databaseUrl?: string) {
  root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-terminal-response-")));
  if (databaseUrl !== undefined && new URL(databaseUrl).pathname !== "/iterminal_test")
    throw new Error("Refusing non-test database");
  const replies: InputAction[] = [];
  daemon = await startRuntimeDaemon({
    hooks: {
      afterInputWrite: (action) => {
        if (action.actor.id === TERMINAL_RESPONSE_ACTOR.id) replies.push(action);
      },
    },
    ...(databaseUrl === undefined ? {} : { databaseUrl, ownerId: `response-${Date.now()}` }),
    socketPath: join(root, "runtime.sock"),
  });
  const runtime = daemon.runtime;
  const session = await runtime.createSession({ shell: "zsh", workspaceRoot: root });
  await writeFile(join(root, "query.py"), queryProgram);
  const started = await runtime.startExecute({
    actor: human,
    sessionId: session.id,
    sessionGeneration: session.generation,
    idempotencyKey: "start",
    command: "python3 -u query.py",
  });
  const target = {
    sessionId: session.id,
    sessionGeneration: session.generation,
    targetExecutionId: started.execution.id,
  };
  await expect
    .poll(async () => (await runtime.getScreen(session.id, session.generation)).lines.join("\n"))
    .toContain("READY");
  return { runtime, session, target, replies };
}

describe("Runtime terminal cursor response", () => {
  for (const databaseUrl of [
    undefined,
    ...(process.env.ITERM_DATABASE_URL === undefined ? [] : [process.env.ITERM_DATABASE_URL]),
  ]) {
    it(`answers under a Human Guard with System attribution and blocks forged public input (${databaseUrl === undefined ? "memory" : "PostgreSQL"})`, async () => {
      const { runtime, session, target, replies } = await setup(databaseUrl);
      const interaction = await runtime.getInteractionState(session.id, session.generation);
      await runtime.acquireInteractionGuard({
        ...target,
        actor: human,
        expectedVersion: interaction.version,
        reason: "response test",
        ttlMilliseconds: 5000,
      });
      const forged = {
        ...target,
        actor: TERMINAL_RESPONSE_ACTOR,
        data: "\x1b[3;7R",
        idempotencyKey: "forged",
        terminalResponse: { kind: "cursor_position", sourceScreenVersion: 1 },
      };
      await expect(runtime.sendInput(forged)).rejects.toMatchObject({ code: "POLICY_DENIED" });
      const before = Date.now();
      const trigger = await runtime.sendInput({
        ...target,
        actor: human,
        data: "x",
        idempotencyKey: "trigger",
      });
      await expect
        .poll(
          async () => (await runtime.getScreen(session.id, session.generation)).lines.join("\n"),
          { timeout: 2000 },
        )
        .toContain("REPLY=1b5b333b3752");
      expect(Date.now() - before).toBeLessThan(1500);
      expect(
        (await runtime.getInteractionState(session.id, session.generation)).inputContext,
      ).toEqual({
        targetExecutionId: target.targetExecutionId,
        version: trigger.actionSequence,
        state: "pending",
      });
      const events = await runtime.queryEvents(session.id, session.generation, 0, 100);
      const accepted = events.events.filter(
        (event) =>
          event.type === "action.accepted" && event.actor?.id === TERMINAL_RESPONSE_ACTOR.id,
      );
      expect(accepted).toHaveLength(1);
      const action = replies[0]!;
      expect(action.id).toBe(accepted[0]!.actionId);
      expect(action).toMatchObject({
        type: "input",
        data: "\x1b[3;7R",
        status: "DELIVERED",
        targetExecutionId: target.targetExecutionId,
        terminalResponse: { kind: "cursor_position" },
      });
      expect(
        events.events.filter((event) => event.actionId === action.id).map((event) => event.type),
      ).toEqual(["action.accepted", "interaction.write_attempted", "interaction.input_delivered"]);
      if (databaseUrl !== undefined) {
        const pool = new Pool({ connectionString: databaseUrl });
        try {
          const row = await pool.query(
            "SELECT actor_id, status, payload FROM actions WHERE id = $1",
            [action.id],
          );
          expect(row.rows[0]).toMatchObject({
            actor_id: TERMINAL_RESPONSE_ACTOR.id,
            status: "DELIVERED",
            payload: { data: "\x1b[3;7R", terminalResponse: action.terminalResponse },
          });
        } finally {
          await pool.end();
        }
      }
    }, 20000);
  }

  it("marks a reply UNKNOWN and breaks the generation after a post-write fault without retry", async () => {
    await setup();
    let writes = 0;
    let failedAction: InputAction | undefined;
    // The standard post-Input hook is shared by generated replies and ordinary Human input.
    await daemon?.close();
    daemon = await startRuntimeDaemon({
      socketPath: join(root, "fault.sock"),
      hooks: {
        afterInputWrite: (action) => {
          if (action.actor.id === TERMINAL_RESPONSE_ACTOR.id) {
            failedAction = action;
            writes++;
            throw new Error("injected reply write uncertainty");
          }
        },
      },
    });
    const faulty = daemon.runtime;
    const session = await faulty.createSession({ shell: "zsh", workspaceRoot: root });
    const started = await faulty.startExecute({
      actor: human,
      sessionId: session.id,
      sessionGeneration: session.generation,
      idempotencyKey: "fault-start",
      command: "python3 -u query.py",
    });
    const current = {
      sessionId: session.id,
      sessionGeneration: session.generation,
      targetExecutionId: started.execution.id,
    };
    await expect
      .poll(async () => (await faulty.getScreen(session.id, session.generation)).lines.join("\n"))
      .toContain("READY");
    await faulty.sendInput({
      ...current,
      actor: human,
      data: "x",
      idempotencyKey: "fault-trigger",
    });
    await expect.poll(() => faulty.getSession(session.id).status).toBe("BROKEN");
    const accepted = (await faulty.queryEvents(session.id, session.generation, 0, 100)).events.find(
      (event) => event.actor?.id === TERMINAL_RESPONSE_ACTOR.id && event.type === "action.accepted",
    );
    expect(failedAction).toMatchObject({ id: accepted!.actionId, status: "UNKNOWN" });
    expect(writes).toBe(1);
  }, 20000);

  it("fails a query flood closed without unbounded reply delivery", async () => {
    const { runtime, session, target, replies } = await setup();
    await runtime.closeSession(session.id, session.generation);
    await writeFile(
      join(root, "flood.py"),
      "import os,time\nos.write(1,b'\\x1b[6n'*1000)\ntime.sleep(10)\n",
    );
    const next = await runtime.createSession({ shell: "zsh", workspaceRoot: root });
    await runtime
      .startExecute({
        actor: human,
        sessionId: next.id,
        sessionGeneration: next.generation,
        idempotencyKey: "flood-start",
        command: "python3 -u flood.py",
      })
      .catch(() => undefined);
    await expect.poll(() => runtime.getSession(next.id).status).toBe("BROKEN");
    expect(replies.length).toBeLessThanOrEqual(32);
    expect(runtime.getSession(target.sessionId).status).toBe("CLOSED");
  }, 20000);

  it.skipIf(!hasDotnet10())(
    "edits real .NET 10 ReadLine input with backspace and Chinese without timeout corruption",
    async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), "iterminal-dotnet-response-")));
      await writeFile(
        join(root, "Probe.csproj"),
        '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
      );
      await writeFile(
        join(root, "Program.cs"),
        'using System; using System.Text; Console.InputEncoding = Console.OutputEncoding = Encoding.UTF8; Console.WriteLine("READY"); for(int i=0;i<3;i++){string line=Console.ReadLine(); Console.WriteLine("ECHO="+line);}',
      );
      execFileSync("dotnet", ["build", "--nologo", "--verbosity", "quiet"], {
        cwd: root,
        timeout: 30000,
        stdio: "pipe",
      });
      const databaseUrl = process.env.ITERM_DATABASE_URL;
      if (databaseUrl !== undefined && new URL(databaseUrl).pathname !== "/iterminal_test")
        throw new Error("Refusing non-test database");
      const replies: InputAction[] = [];
      daemon = await startRuntimeDaemon({
        socketPath: join(root, "runtime.sock"),
        ...(databaseUrl === undefined ? {} : { databaseUrl, ownerId: `dotnet-${Date.now()}` }),
        hooks: {
          afterInputWrite: (action) => {
            if (action.terminalResponse !== undefined) replies.push(action);
          },
        },
      });
      const runtime = daemon.runtime;
      const session = await runtime.createSession({ shell: "zsh", workspaceRoot: root });
      const started = await runtime.startExecute({
        actor: human,
        sessionId: session.id,
        sessionGeneration: session.generation,
        idempotencyKey: "dotnet-start",
        command: "dotnet bin/Debug/net10.0/Probe.dll",
      });
      const target = {
        sessionId: session.id,
        sessionGeneration: session.generation,
        targetExecutionId: started.execution.id,
      };
      const text = async () =>
        (await runtime.getScreen(session.id, session.generation)).lines.join("\n");
      await expect.poll(text).toContain("READY");
      for (const [data, expected] of [
        ["/helpp\x7f\r", "/help"],
        ["中文测X\x7f试\r", "中文测试"],
        ["中文🙂\r", "中文🙂"],
      ]) {
        await runtime.sendInput({
          ...target,
          actor: human,
          data: data!,
          idempotencyKey: crypto.randomUUID(),
        });
        await expect.poll(text, { timeout: 2000 }).toContain(`ECHO=${expected}`);
      }
      expect(await text()).not.toContain("\ufffd");
      expect((await runtime.waitExecution(started.execution.id)).status).toBe("COMPLETED");
      expect(replies.length).toBeGreaterThanOrEqual(2);
      expect(replies.every((action) => action.status === "DELIVERED")).toBe(true);
    },
    40000,
  );
});

function hasDotnet10(): boolean {
  try {
    return /^10\./mu.test(
      execFileSync("dotnet", ["--list-sdks"], { encoding: "utf8", timeout: 5000 }),
    );
  } catch {
    return false;
  }
}
