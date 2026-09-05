import type * as ExecutorModule from "../packages/executor-pty/src/pty-shell-executor.js";
import type * as ScreenModule from "../packages/terminal-screen/src/index.js";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, platform, arch, cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ShellExecutor } from "@iterminal/application";
import { BoundedByteRing } from "../packages/executor-pty/src/bounded-byte-ring.js";

const root = resolve(import.meta.dirname, "..");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const percentile = (values: number[], fraction: number) =>
  [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;

if (process.argv[2] === "--worker") {
  const [scenario, executorPath, screenPath] = process.argv.slice(3);
  const executorModule = (await import(
    pathToFileURL(executorPath!).href
  )) as typeof ExecutorModule & {
    benchmarkCounters: { polls: number; allocatedBytes: number };
  };
  const screenModule = (await import(pathToFileURL(screenPath!).href)) as typeof ScreenModule & {
    benchmarkCounters: { captures: number; cellCaptures: number; latencies: number[] };
  };
  const directory = await realpath(await mkdtemp(join(tmpdir(), "it-benchmark-")));
  const executors: ShellExecutor[] = [];
  const screens: InstanceType<typeof screenModule.XtermScreenProjection>[] = [];
  let reads = 0;
  let observing = true;
  let observer: Promise<void> | undefined;
  const completed: string[] = [];
  const checksums: string[] = [];
  try {
    const count = scenario === "multi-session" ? 4 : 1;
    for (let index = 0; index < count; index++) {
      const screen = new screenModule.XtermScreenProjection({
        sessionId: `benchmark-${index}`,
        sessionGeneration: 1,
      });
      screens.push(screen);
      let version = 0;
      executors.push(
        await new executorModule.PtyShellExecutorFactory().create({
          executorId: `executor-${index}`,
          sessionId: `benchmark-${index}`,
          sessionGeneration: 1,
          shell: "zsh",
          workspaceRoot: directory,
          checkpointEnvironmentKeys: [],
          onLifecycle: () => undefined,
          onOutput: (data) => screen.write(data, ++version),
        }),
      );
    }
    await Promise.all(screens.map((screen) => screen.snapshot()));
    executorModule.benchmarkCounters.polls = 0;
    // Include initial scratch allocation; it is the entire new allocation cost.
    screenModule.benchmarkCounters.captures = 0;
    screenModule.benchmarkCounters.latencies.length = 0;
    const startMemory = process.memoryUsage();
    const startCpu = process.cpuUsage();
    const started = performance.now();
    let peakRss = startMemory.rss;
    observer = (async () => {
      while (observing) {
        for (const screen of screens) {
          await screen.consoleFrame();
          reads++;
        }
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        await delay(33);
      }
    })();
    if (scenario === "idle") await delay(1500);
    else {
      const repeats = scenario === "high-throughput" ? 1024 : 100;
      const pause = scenario === "high-throughput" ? 0 : 0.01;
      const source = `import os,time,termios\noriginal=termios.tcgetattr(1)\nraw=termios.tcgetattr(1)\nraw[1] &= ~termios.OPOST\ntermios.tcsetattr(1,termios.TCSANOW,raw)\nos.write(1,b"BENCH_BEGIN:")\nfor i in range(${repeats}):\n os.write(1,b"x"*1023+b"\\n")\n time.sleep(${pause})\nos.write(1,b":BENCH_END")\ntermios.tcsetattr(1,termios.TCSANOW,original)\n`;
      await writeFile(join(directory, "load.py"), source);
      const expected = hash(Buffer.from(("x".repeat(1023) + "\n").repeat(repeats)));
      await Promise.all(
        executors.map(async (executor, index) => {
          let didStart = false;
          const result = await executor.execute("python3 load.py", {
            onStarted: () => {
              didStart = true;
              completed.push(`start-${index}`);
            },
          });
          if (!didStart || result.exitCode !== 0 || result.outputTruncated)
            throw new Error("Benchmark command did not complete correctly");
          completed.push(`end-${index}`);
          const begin = result.output.indexOf("BENCH_BEGIN:");
          const end = result.output.indexOf(":BENCH_END");
          if (begin < 0 || end < begin) throw new Error("Benchmark payload boundaries missing");
          // The fixture temporarily disables OPOST and restores it after its framed output.
          const digest = hash(result.output.slice(begin + "BENCH_BEGIN:".length, end));
          if (digest !== expected)
            throw new Error(
              `Benchmark output checksum mismatch ${JSON.stringify({ scenario, begin, end, expectedBytes: repeats * 1024, observedBytes: end - begin - "BENCH_BEGIN:".length, prefix: result.output.slice(begin, begin + 50), firstNewline: result.output.slice(begin + 1020, begin + 1050), suffix: result.output.slice(end - 50, end + 20) })}`,
            );
          checksums.push(digest);
        }),
      );
    }
    await Promise.all(screens.map((screen) => screen.snapshot()));
    observing = false;
    await observer;
    const cpu = process.cpuUsage(startCpu);
    console.log(
      JSON.stringify({
        scenario,
        sessions: count,
        sampleMs: performance.now() - started,
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        rssStart: startMemory.rss,
        peakRss,
        rssEnd: process.memoryUsage().rss,
        controlPolls: executorModule.benchmarkCounters.polls,
        controlAllocatedBytes: executorModule.benchmarkCounters.allocatedBytes,
        snapshots: screenModule.benchmarkCounters.captures,
        cellCaptures: screenModule.benchmarkCounters.cellCaptures,
        observationReads: reads,
        projectionLatencySamples: screenModule.benchmarkCounters.latencies.length,
        projectionLatencyP50Ms: percentile(screenModule.benchmarkCounters.latencies, 0.5),
        projectionLatencyP95Ms: percentile(screenModule.benchmarkCounters.latencies, 0.95),
        completionOrder: completed,
        checksums,
      }),
    );
  } finally {
    observing = false;
    await observer;
    for (const executor of executors) executor.close();
    for (const screen of screens) screen.dispose();
    await rm(directory, { recursive: true, force: true });
  }
} else {
  const baseline =
    process.argv.find((argument) => argument.startsWith("--baseline="))?.slice(11) ??
    "5c59a49ed034bb3d6e59231a4c3e93f20128d4ea";
  if (!/^[a-f0-9]{7,40}$/.test(baseline))
    throw new Error("Use an explicit hexadecimal baseline revision");
  const generated: string[] = [];
  const materialize = async (relative: string, source: string) => {
    const path = join(root, dirname(relative), `.benchmark-${randomUUID()}.ts`);
    await writeFile(path, source);
    generated.push(path);
    return path;
  };
  const baselineSource = (path: string) =>
    execFileSync("git", ["show", `${baseline}:${path}`], { cwd: root, encoding: "utf8" });
  try {
    const oldRing = baselineSource("packages/executor-pty/src/bounded-byte-ring.ts");
    const ringPath = await materialize(
      "packages/executor-pty/src/bounded-byte-ring.ts",
      oldRing.replace(
        "const combined = Buffer.concat",
        "benchmarkCounters.allocatedBytes += this.#buffer.length + incoming.length;\n    const combined = Buffer.concat",
      ) + "\nexport const benchmarkCounters = { allocatedBytes: 0 };\n",
    );
    const oldModule = (await import(pathToFileURL(ringPath).href)) as {
      BoundedByteRing: typeof BoundedByteRing;
      benchmarkCounters: { allocatedBytes: number };
    };
    const capacity = 2 * 1024 * 1024;
    const appendCount = 8192;
    const chunk = Buffer.alloc(1024, 120);
    const rings = [];
    for (const [mode, Constructor] of [
      ["baseline", oldModule.BoundedByteRing],
      ["fixed-ring", BoundedByteRing],
    ] as const) {
      const ring = new Constructor(capacity);
      const start = performance.now();
      for (let index = 0; index < appendCount; index++) ring.append(chunk);
      const elapsedMs = performance.now() - start;
      const snapshot = ring.snapshot();
      rings.push({
        mode,
        capacity,
        appendCount,
        chunkBytes: chunk.length,
        elapsedMs,
        appendAllocatedBytes:
          mode === "baseline" ? oldModule.benchmarkCounters.allocatedBytes : capacity,
        snapshotBytes: snapshot.byteLength,
        checksum: hash(snapshot.data),
      });
    }
    if (rings[0]!.checksum !== rings[1]!.checksum)
      throw new Error("Ring benchmark correctness mismatch");
    const executorFile = "packages/executor-pty/src/pty-shell-executor.ts";
    const currentExecutor = await readFile(join(root, executorFile), "utf8");
    const oldExecutor = baselineSource(executorFile);
    const screenFile = "packages/terminal-screen/src/index.ts";
    const screen = await readFile(join(root, screenFile), "utf8");
    const instrumentScreen = (source: string) =>
      source
        .replace(
          "}): TerminalScreenCellsResult {",
          "}): TerminalScreenCellsResult { benchmarkCounters.cellCaptures++;",
        )
        .replace(
          "this.#scheduledVersion = screenVersion;",
          "benchmarkWriteTimes.set(this.identity.sessionId + ':' + screenVersion, performance.now());\n    this.#scheduledVersion = screenVersion;",
        )
        .replace(
          "#recordSnapshot(): TerminalScreenSnapshot {",
          "#recordSnapshot(): TerminalScreenSnapshot {\n    benchmarkCounters.captures++;\n    const measured = benchmarkWriteTimes.get(this.identity.sessionId + ':' + this.#appliedVersion);\n    if (measured !== undefined) { benchmarkCounters.latencies.push(performance.now() - measured); benchmarkWriteTimes.delete(this.identity.sessionId + ':' + this.#appliedVersion); }",
        ) +
      "\nexport const benchmarkCounters = { captures: 0, cellCaptures: 0, latencies: [] as number[] };\nconst benchmarkWriteTimes = new Map<string, number>();\n";
    const screenPath = await materialize(screenFile, instrumentScreen(screen));
    const uncachedMethod = `  public consoleFrame(): Promise<TerminalConsoleFrame> {
      return this.#read(() => ({ ...cloneSnapshot(this.#currentSnapshot()), format: "cells-v1" as const,
        cells: this.#captureCells({ startColumn: 0, startRow: 0, columnCount: this.#terminal.cols, rowCount: this.#terminal.rows }).cells }));
    }
`;
    const methodStart = screen.indexOf("  public consoleFrame():");
    const methodEnd = screen.indexOf("  public cells(", methodStart);
    const uncachedSource = screen.slice(0, methodStart) + uncachedMethod + screen.slice(methodEnd);
    const uncachedPath = await materialize(screenFile, instrumentScreen(uncachedSource));
    const frames = [];
    for (const [mode, path] of [
      ["uncached-cells", uncachedPath],
      ["same-version-cache", screenPath],
    ] as const) {
      const module = (await import(pathToFileURL(path).href)) as typeof ScreenModule & {
        benchmarkCounters: { cellCaptures: number };
      };
      const projection = new module.XtermScreenProjection({
        sessionId: "frame-benchmark",
        sessionGeneration: 1,
      });
      try {
        projection.write("\u001b[31m" + "x".repeat(4000), 1);
        await projection.snapshot();
        const started = performance.now();
        const results = await Promise.all(
          Array.from({ length: 100 }, () => projection.consoleFrame()),
        );
        const elapsedMs = performance.now() - started;
        const hashes = results.map((result) => hash(JSON.stringify(result)));
        if (new Set(hashes).size !== 1)
          throw new Error("Same-version frames changed across consumers");
        frames.push({
          mode,
          calls: results.length,
          elapsedMs,
          captures: module.benchmarkCounters.cellCaptures,
          checksum: hashes[0],
        });
      } finally {
        projection.dispose();
      }
    }
    if (frames[0]!.checksum !== frames[1]!.checksum)
      throw new Error("Cached frame correctness mismatch");
    const runtime = [];
    for (const [mode, source] of [
      ["baseline-scratch", oldExecutor],
      ["reused-scratch", currentExecutor],
    ] as const) {
      const executorPath = await materialize(
        executorFile,
        source
          .replace(
            "#pollControl(): void {",
            "#pollControl(): void {\n    benchmarkCounters.polls++;",
          )
          .replaceAll(
            "Buffer.allocUnsafe(16 * 1024)",
            "(benchmarkCounters.allocatedBytes += 16 * 1024, Buffer.allocUnsafe(16 * 1024))",
          ) + "\nexport const benchmarkCounters = { polls: 0, allocatedBytes: 0 };\n",
      );
      for (const scenario of ["idle", "continuous-1k", "high-throughput", "multi-session"]) {
        const output = execFileSync(
          process.execPath,
          ["--import", "tsx", import.meta.filename, "--worker", scenario, executorPath, screenPath],
          { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
        );
        runtime.push({ mode, ...(JSON.parse(output) as object) });
      }
    }
    const report = {
      baseline,
      environment: {
        node: process.version,
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
      },
      sourceHashes: {
        baselineRing: hash(oldRing),
        baselineExecutor: hash(oldExecutor),
        currentExecutor: hash(currentExecutor),
        currentProjection: hash(screen),
      },
      notes: [
        "Fixed workloads; process CPU/RSS exclude child Python CPU",
        "Allocation bytes count instrumented ring concat and 16KiB control allocation sites, not whole-process allocations",
        "Both executor variants use current ring and current projection to isolate scratch reuse",
        "Projection latency measures PTY callback to snapshot; it is not browser paint latency",
        "Snapshots are not coalesced in this benchmark; per-session completion order is checked, inter-session order is nondeterministic",
      ],
      rings,
      frames,
      runtime,
    };
    const outputPath = process.argv.find((argument) => argument.startsWith("--output="))?.slice(9);
    if (outputPath) {
      await mkdir(dirname(resolve(outputPath)), { recursive: true });
      await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    for (const path of generated) await rm(path, { force: true });
  }
}
