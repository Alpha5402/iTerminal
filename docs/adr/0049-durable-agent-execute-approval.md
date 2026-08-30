# ADR-0049: Durable one-time Approval for Agent Execute

- Status: Accepted for M10.3
- Date: 2026-08-31

## Context

M10.1 and M10.2 establish stable Actor identity, explicit capabilities, and authenticated RPC callers. They do not let a Human review a proposed Agent shell command before admission. A transient Console dialog is insufficient: the request can change between display and execution, an owner restart can erase the decision, two retries can consume one decision twice, and a database failure can separate Approval consumption from Action admission.

The roadmap requires Approval to bind an immutable Action request hash, Session generation, requester, approver, expiry, and one-time use. The first slice must be small enough to prove that contract without claiming generic risk classification for every terminal mutation.

## Decision

### Initial operation and policy boundary

M10.3 applies Approval only to `execution.start` requested by an Agent. Runtime configuration has an explicit `agentExecuteApproval` policy:

- `optional`: an Agent may request and use Approval, but Execute retains the M10.1 capability/policy behavior;
- `required`: every new Agent Execute admission requires one matching approved record.

The default remains `optional` until the release profile and operator workflow are complete. Human, Scheduler, and System Execute do not inherit or consume Agent Approval. Input, Control, Resize, fork/rebuild, policy, Guard, root Session creation, and service dispatch remain outside this Approval slice. In particular, `bypassGuard` neither creates nor bypasses Approval; this slice simply has no Control Approval policy yet.

No command classifier is an authorization fact. The Runtime never guesses that a command is safe from text patterns, terminal output, or `TerminalState`.

### Proposed Execute identity

An Approval request contains:

- exact Session id and generation;
- exact authenticated requester Actor;
- future Execute idempotency key;
- command;
- bounded Human-facing reason;
- Approval-request idempotency key;
- requested TTL.

The Runtime computes an `actionRequestHash` from the canonical tuple:

```text
operation = execution.start
session id + generation
full Actor identity and canonical capabilities
future Execute idempotency key
Execute request hash
```

The Execute request hash remains the existing canonical hash of the command. The Approval row stores the exact proposed command so a Human can make an informed decision, but clients never supply or compare a separate trusted hash. Any change to the operation, generation, Actor field, capability list, idempotency key, or command produces a different `actionRequestHash` and cannot consume the Approval.

Approval request idempotency is scoped to Session plus requester Actor. Replaying the same key and proposal returns the original record; changing the proposal returns `IDEMPOTENCY_KEY_REUSED`. An expired or denied Approval is not renewed or reopened. A new request uses a new Approval-request idempotency key and creates a new Approval id.

### State machine

```text
PENDING ──approve──> APPROVED ──matching Action admission──> CONSUMED
   │                    │
   ├──deny────────> DENIED
   └──expiry──────> EXPIRED <── expiry before consumption ──┘
```

An Approval has a monotonically increasing version. Human decisions require the expected version and a decision idempotency key. Only a Human Actor with `approval.decide` may approve or deny. Only an Agent Actor with `approval.request` may create this Execute Approval. Reads require an Actor and expose an Agent only to its own requests; a Human with `approval.decide` may inspect all Approvals for the exact Session generation.

TTL is at least 30 seconds, at most 30 minutes, and defaults to 5 minutes. PostgreSQL time is authoritative in durable mode. Expiry is terminal and may be materialized lazily by a read, decision, or consumption attempt; the same transaction appends `approval.expired` at most once.

### One-time atomic consumption

`execution.start` keeps its existing idempotent replay order. If the exact Action was already admitted, replay returns it even though its Approval is now `CONSUMED`. For a new admission under `required` policy, the Runtime validates the Approval after capability, command, idempotency, and exact-generation checks but before Session reservation or PTY work.

Durable consumption and Execute admission occur in one PostgreSQL transaction under the exact owner/Session fence. The transaction must:

1. lock the Approval row;
2. verify `APPROVED`, unexpired, unconsumed, exact requester and `actionRequestHash`;
3. insert the Action, Execution, Events, and Outbox work using existing admission rules;
4. change the Approval to `CONSUMED`, bind its Action id, and append `approval.consumed`;
5. commit once.

Any failure rolls back both admission and consumption. A second non-replay Action cannot consume the row. In memory mode the same ordering executes beneath the Session mutation lock before any PTY dispatch.

Missing, pending, denied, expired, already-consumed, wrong-generation, wrong-Actor, or changed-request Approval returns `APPROVAL_REQUIRED` with bounded identifiers/status/expiry and no command echo. It creates no Action, Execution, Outbox row, or PTY write.

### Protocol and Console

Runtime RPC adds authenticated `approval.request`, `approval.get`, `approval.list`, and `approval.decide` operations. MCP exposes request/get/list to its fixed Agent Actor and never exposes decide. The Human Console exposes exact-generation pending/history reads and approve/deny controls; browser JSON cannot choose the Human Actor.

Events are append-only and bounded:

- `approval.requested` records Approval id, operation, request hash, expiry, and bounded reason metadata;
- `approval.approved` / `approval.denied` record decision metadata and approver;
- `approval.expired` records expiry without command content;
- `approval.consumed` binds the admitted Action id.

The command remains in the Approval record for Human review and later audit under the same storage/retention sensitivity as an Execute Action. It is not duplicated into Event payloads, logs, errors, grant claims, or metrics.

## Consequences

- A Human decision is durable and request-hash bound rather than a UI-only acknowledgement.
- Exact idempotent replay remains possible after one-time consumption.
- Required Agent Execute introduces an intentional two-step workflow and can expire while a Human is away.
- The Router remains stateless; Approval routes by exact Session owner and uses the authenticated caller grant on both hops.
- Durable Approval adds a migration, actor references, transactional event sequencing, retention/cardinality work, and Console/MCP protocol surface.
- This slice does not claim a complete operation-wide Approval matrix, automatic command risk scoring, secret handling, or remote authorization.

## Rejected alternatives

- **Approve only a command string:** omits generation, Actor, capabilities, and idempotency identity, so a decision can be replayed in another context.
- **Trust a client-supplied request hash:** lets a buggy or malicious adapter display one proposal and execute another under the same claimed hash.
- **Consume before Action admission:** database or owner failure can burn a valid decision without an admitted Action.
- **Consume after Action admission:** a crash window can admit multiple Actions with one Approval.
- **Make all terminal writes require Approval immediately:** creates an unreviewable raw-key workflow and overstates a matrix that has not been designed or tested.
- **Use a shell-command allow/deny regex as the safety policy:** Shell syntax and effects are not reliably classifiable from command text, and such a heuristic must not become authorization truth.
