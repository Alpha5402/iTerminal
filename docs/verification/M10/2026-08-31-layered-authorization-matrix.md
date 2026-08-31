# M10.10 layered authorization matrix verification

**Result: PASS at L2 for the local Capability, Actor-type, interaction policy/Guard, secret-input,
and Agent Execute Approval matrix.**

Date: 2026-08-31

Platform: macOS arm64, Node.js 24.15.0, pnpm 10.33.2, deterministic in-memory Action/PTY probes,
real local zsh through `node-pty`, and real mode-`0600` Unix Runtime RPC sockets

## Scope

- Freeze one normative matrix across the capability policy from ADR-0047, Input Policy and Guard
  from ADR-0023, Agent Execute Approval from ADR-0049, and Human-only secret input from ADR-0050.
- Prove that each Actor-bearing mutation requires its named capability before accepted Action or
  PTY side effects.
- Prove that presenting every closed capability does not promote Agent, Scheduler, or System to a
  Human/Agent interaction role.
- Prove that `agentExecuteApproval=required` affects only new Agent Execute admission; Human,
  Scheduler, and System Execute do not consume Agent Approval.
- Keep exact accepted replay, generation/Execution freshness, policy/Guard, sensitive-period,
  immutable Actor, and delivery-uncertainty ordering unchanged.
- State explicitly that root create, close, dispatch, wait, and current Actor-less reads remain
  protected by authenticated Runtime RPC operation scopes rather than an invented Actor capability.

## Commands and results

```sh
pnpm exec vitest run --maxWorkers=1 packages/application/src/authorization-matrix.test.ts
```

Result: 1 file and 4 tests passed. The table-driven probes covered all ten closed construction
profiles/capabilities, every Actor-bearing mutation family, missing-capability zero-Action/zero-PTY
behavior, over-capable role denial, Approval read isolation, and the four-Actor Execute Approval
scope.

```sh
pnpm test:m10:authorization
```

Result: 5 files and 32 tests passed outside the restricted sandbox. The gate combines the new
cross-operation matrix with the existing complete four-policy by four-Actor Input matrix, Guard
ownership/expiry/replay cases, real-zsh Approval and secret-input scenarios, and signed Unix Runtime
RPC grant/Actor-scope tests.

```sh
pnpm typecheck && pnpm lint && pnpm format:check
```

Result: TypeScript, ESLint, and repository formatting checks passed.

```sh
pnpm verify
```

Result: the final run passed format, lint, typecheck, the default test suite, documentation evidence
check, TypeScript build, and Console production build. The default suite reported 33 files passed,
32 skipped, 124 tests passed, and 99 skipped; the evidence checker validated 50 milestone reports.
The Vite build retained its advisory warning for a minified chunk larger than 500 kB and completed
successfully.

## Verified behavior

| Boundary                 | Evidence                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical profiles       | Exact Human, Agent, Scheduler, and System construction profiles are frozen against the closed ten-capability vocabulary.                                                                                                        |
| Capability denial        | Execute, fork, Input, Control, Resize, policy, Guard acquire/renew/release, Approval request/get/list/decide, and secret begin/get/finish reject the missing capability. No accepted Action sequence or executor call is added. |
| Bounded rejection audit  | Interaction denial may append bounded policy metadata after a valid target is established; unique input and secret sentinels are absent from Event serialization.                                                               |
| Role cannot be forged    | An Actor carrying every capability still cannot cross Human-only policy/Guard/secret/decision boundaries, non-requester Approval reads, or Scheduler/System interaction restrictions.                                           |
| Policy and Guard         | The existing four policies by four Actor types, exact Guard holder, emergency Human Control, expiry, renewal cap, and accepted replay cases remain green.                                                                       |
| Approval scope           | Under required policy, Human/Scheduler/System Execute complete without Approval, Agent Execute fails until exact Human approval, and a Human cannot consume an Agent Approval.                                                  |
| Transport authentication | Real Unix RPC tests retain signed expiry, operation allowlist, exact Actor binding, Router verified-context forwarding, and Human-only secret-operation authentication.                                                         |
| Real PTY path            | Existing focused Approval and secret-input tests create real local zsh PTYs and remain green alongside the deterministic no-side-effect probes.                                                                                 |

## Failed attempts and correction

- The first deterministic Resize matrix run had no Virtual Screen projection, so Resize correctly
  failed with `RUNTIME_UNAVAILABLE` before reaching authorization. The fixture was corrected with a
  bounded in-memory projection and the test then proved geometry CAS followed by policy denial and
  zero executor resize.
- The first full focused gate ran inside a restricted sandbox. Twelve Runtime RPC tests failed while
  binding temporary Unix sockets with `EPERM`; the other four files passed. The identical five-file
  gate passed 32/32 outside that sandbox. This was an execution-environment restriction, not a
  product authorization failure.
- The first two parallel full-suite runs exposed an existing host-scheduler race in the real PTY
  Guardian regression: under cross-file process pressure, its 300 ms watchdog did not run before an
  800 ms delayed descendant effect. The Guardian test passed four isolated repetitions and the
  complete 65-file suite passed with one worker. Because the default suite contains real PTY,
  process, and Unix-socket integration tests, `pnpm test` now fixes `--maxWorkers=1`; no Guardian
  timeout, assertion, or Runtime behavior was weakened.

## Not proven

- M10.10 does not add Approval to Input, Control, Resize, fork, policy, Guard, secret input, Human
  Execute, Scheduler Execute, System Execute, root creation, dispatch, or observation reads.
- Current Actor-less Application operations are not capability-protected merely because Runtime RPC
  authenticates an operation-scoped caller grant.
- The matrix is an application/transport authorization boundary inside one trusted local OS-user
  domain. It is not an OS sandbox, remote multi-user isolation, shell-command safety classifier, or
  protection from same-user code that can read process memory or environment.
- Durable PostgreSQL identity, Guard CAS, and Approval atomic-consumption evidence remains in the
  M10.1 and M10.3 reports; this slice did not change their schema or transaction semantics.
- HTTP request-rate limits, Shell hostile paths/markers beyond existing parser tests, normalized
  fact retention, whole-database disk alerts, cross-platform installation, and sustained dogfood
  remain open.

## Conclusion

M10.10 closes the planned combined authorization matrix at local L2: capability, Actor type,
Input Policy/Guard, secret input, and Agent Execute Approval are separate conjunctive layers with
executable no-side-effect and anti-role-promotion evidence. It does not broaden Approval or claim
release readiness.
