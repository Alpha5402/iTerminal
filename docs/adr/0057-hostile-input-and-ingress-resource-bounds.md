# ADR-0057: Hostile input and ingress resource bounds

- Status: Accepted for M10.11
- Date: 2026-08-31
- Refines: ADR-0003, ADR-0024, ADR-0027, ADR-0048, ADR-0054

## Context

iTerminal already separates trusted Shell facts onto a mode-`0600` control FIFO, canonicalizes
workspace/checkpoint paths, caps Runtime RPC frames, and bounds Console bodies, Actor records,
WebSocket streams, messages, and outbound buffering. PostgreSQL also rate-limits accepted durable
Actions.

Those controls leave four gaps:

1. the control decoder limits only the unseparated tail, not the cumulative bytes already moved
   into frame fields;
2. a PTY string containing the barrier prefix without a terminator can remain buffered without a
   bound even though PTY text is not trusted Shell state;
3. invalid workspace resolution can copy a hostile path and raw filesystem message into a public
   Runtime error;
4. cheap Console reads/bootstrap and idle Runtime RPC connections do not reach durable Action rate
   limits and can consume loopback process resources first.

The threat remains a buggy or hostile same-user client, browser page that reaches loopback, or Shell
program producing adversarial bytes. This decision does not claim protection after the host user,
Runtime process, kernel, or filesystem is compromised.

## Decision

### Shell control channel

The Shell Integration control FIFO remains the only source of `HELLO`, `PREEXEC`, `RESULT`, and
`READY` facts. PTY text never becomes a control event.

- One control frame is capped at 1 MiB cumulatively, including NUL separators and fields already
  removed from the decoder tail.
- The closed frame vocabulary and exact four-field framing remain mandatory.
- Shell PID must be a positive safe integer. Result/ready exit status must be a safe integer from
  `0` through `255`.
- Checkpoint environment remains at most 32 unique canonical keys with at most 4 KiB of canonical
  base64 UTF-8 value per key and no NUL/newline.
- Malformed, unknown, over-bound, or non-canonical control data is fatal to that Executor. It is not
  skipped in search of a later apparently valid fact.

### PTY barrier parser

The execution barrier is an output-ordering aid, not a Shell-state authority. Runtime creates one
unguessable UUID token for the pending Execute and recognizes only that exact token between the
closed prefix and BEL suffix.

The parser retains at most the fixed prefix plus 64 token characters while waiting for a suffix. A
complete unknown token or an unterminated token exceeding that bound is emitted as ordinary PTY
output and cannot complete an Execute. A partial prefix across callbacks remains bounded to the
prefix length. The real matching barrier is suppressed from observations only after exact token
comparison.

### Workspace and checkpoint paths

Workspace creation still requires `realpath` of an existing directory. A checkpoint cwd still
requires `realpath`, directory type, and relative containment inside the exact canonical workspace.
Fork revalidates both canonical paths immediately before reconstruction.

Public path failures use fixed messages and metadata-only path kinds. They do not echo a
caller-supplied path, platform filesystem message, symlink target, home directory, or other local
path detail. This containment validates reconstruction starting points; it does not restrict later
Shell commands, prevent same-user filesystem races, or create a sandbox.

### Console HTTP request rate

The loopback Console adds one process-local fixed-window request limiter for every `/api` HTTP
request and WebSocket upgrade after Host/Origin/Fetch-Metadata/header validation:

- default global limit: 600 requests per 10 seconds;
- default per known cookie-bound Actor limit: 120 requests per 10 seconds;
- requests without a currently known Actor share one anonymous bucket, so attacker-chosen cookie
  values cannot create limiter cardinality;
- a rejected request returns HTTP `429`, stable `RATE_LIMITED`, a bounded scope and retry delay, and
  `Retry-After`; it does not call RuntimeGateway or allocate an Actor/stream.

The rate window uses the Console clock and resets without retaining unbounded history. Existing
body, Actor, stream, per-Actor stream, client-message, and outbound-buffer limits remain independent.
Durable Action rate limits still run inside PostgreSQL admission and cannot be replaced by this
adapter-local cheap-request limit.

### Runtime RPC connection and framing bounds

One Runtime RPC connection still carries exactly one newline-terminated JSON request and one
response. Defaults are:

- at most 256 active accepted Unix sockets per server process;
- five seconds to receive the complete request frame;
- at most 1 MiB request and 16 MiB response;
- existing 30-second ordinary client timeout and explicit long bounded wait timeout.

An over-capacity connection or incomplete/oversized frame is destroyed before gateway dispatch.
Socket close aborts an active cancellable wait. Limits are configurable at server construction for
tests and deployment wrappers, but are not distributed quotas and do not authenticate a caller.

## Consequences

- Shell-produced framing and marker bytes have explicit cumulative memory bounds and cannot invent
  trusted control facts.
- Invalid local paths no longer become an error-reflection channel.
- Cheap Console traffic and idle local RPC sockets receive process-local backpressure before they
  accumulate unbounded adapter work.
- Legitimate bursty clients may receive retryable rate limits and must honor the supplied delay.
- Runtime RPC callers that take longer than five seconds to finish a request frame must reconnect;
  long-running work is unaffected after framing completes.

## Rejected alternatives

- **Treat PTY OSC text as trusted Shell Integration:** command output can forge it.
- **Discard every unknown barrier-looking string:** silently alters terminal output and hides
  evidence; unknown/oversized markers remain ordinary PTY bytes.
- **Use only PostgreSQL Action rate limits:** bootstrap, observations, malformed requests, and idle
  sockets consume adapter resources before Action admission.
- **Key anonymous rate limits by Cookie or query:** lets hostile caller-controlled identifiers create
  unbounded buckets.
- **Return raw `realpath` diagnostics:** exposes local paths and reflects hostile input without
  improving the stable client contract.
- **Describe path containment as filesystem isolation:** a real Shell intentionally retains the host
  user's filesystem authority.

## Not covered

- Remote bind, TLS proxy, multi-user quotas, distributed limit coordination, cgroup/file-descriptor
  enforcement, OS sandboxing, or protection from a hostile same-user process that can bypass the
  adapters.
- Shell command allow/deny classification, arbitrary terminal escape-sequence sanitization, or TUI
  content safety.
- Symlink or mount changes performed by the same user after validation, commands that intentionally
  leave the workspace, detached descendants, or host filesystem compromise.
- Long-duration hostile traffic soak, cross-platform Shell/PTY validation, normalized durable-fact
  retention, and whole-database disk alerts.
