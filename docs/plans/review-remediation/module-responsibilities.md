# Remediation module and ownership map

This describes the integration implementation for E04/E05. Public DTOs and Runtime states retain
their existing owners; file size is not the acceptance criterion.

| Module                       | Responsibility and narrow input                                                                     | State deliberately retained elsewhere                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Application `RuntimeService` | Public facade, admission, per-Session mutation lane, durable ordering, fencing and settlement       | Sole owner of Session/Execution/Action state transitions                   |
| `execution-waiters.ts`       | Waiter registration, deadlines, AbortSignal cleanup; receives an Execution reader and scheduler     | Does not stop executions or mutate their status                            |
| `execution-cache.ts`         | Transient state/promise registration and identity-checked release                                   | Mutable dispatch and durable reconciliation stay in RuntimeService         |
| `retention-policy.ts`        | Pure limit validation and reserve policy                                                            | Eviction decisions cannot replay accepted operations                       |
| `observation-text.ts`        | Bounded UTF-8/control-text presentation                                                             | Durable byte stream and offsets remain authoritative                       |
| `discovery.ts`               | Cursor validation and pure pending-Approval projection; receives iterable and narrow Session lookup | Identity/capability admission and Approval mutation stay in facade         |
| Console `console-client.ts`  | HTTP envelope, errors and AbortSignal transport                                                     | No implicit retries or request identity generation                         |
| `stream-controller.ts`       | One socket and one reconnect timer per selection; cleanup on disposal                               | Render ACK is applied-screen evidence, not durability                      |
| `session-navigation.ts`      | One bounded discovery/pagination request chain and poll timer                                       | Session selection/dismissal and drafts remain in App                       |
| `approval-inbox.ts`          | Global bounded pending pages, polling, bootstrap prerequisite and cancellation                      | Decision submission retains frozen Approval/version and no automatic retry |
| `diagnostics.tsx`            | Pure diagnostics rendering                                                                          | No Runtime or transport state transitions                                  |
| `terminal-renderer.ts`       | Generated cursor/SGR from canonical cells; text control filtering                                   | Raw PTY OSC is never replayed                                              |
| `terminal-history.tsx`       | Generation-keyed bounded history overlay, cancellation and stable browsing position                 | No PTY resize to retrieve history                                          |

The existing submission-intent reducer retains uncertain request identity and draft revision.
App retains the coupled foreground input/secret/Guard/composer effects, terminal focus and geometry
coordination. Moving those state machines without another behavioral boundary would be a larger
change than this card. No new state library, event bus or microservice was introduced.

Dependency direction remains `domain <- application <- adapters/apps`. Application helpers import
only domain and Application ports; no Application module imports Console/RPC/PostgreSQL adapters.
The shared behavioral test suites, required integration/shared-path gates and final verification
report are the evidence; helper-by-helper mirror tests are intentionally avoided.
