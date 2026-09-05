# ADR 0078: Shared CLI and renewable local identity

- Status: Accepted for D04/D05/D06
- Date: 2026-09-05

CLI defaults to authenticated Runtime RPC. Actor identity is configuration-bound, body actors are rejected, and EOF cancels bounded client waits without closing shared Sessions. Explicit --standalone retains the isolated development runtime. Concurrent responses are correlated by requestId; at most 32 requests are in flight.

The local supervisor atomically replaces private MCP and Console credential files using the existing issuer and unchanged secret/Actor/operation scope. Public MCP bootstrap references a private credential file rather than embedding a startup grant. Renewal is scheduled before expiry (five minutes or 20 percent of the remaining short TTL), single-flight, with capped retry backoff. Expired grants remain invalid; renewal never changes Session/generation/PTY identity. Shutdown stops scheduling and awaits an in-flight replacement.

Stable optional Agent names produce separate bootstrap and credential filenames and exact Actor identities. This is identity separation, not session ACL or an OS sandbox. Managed shell and existing Application authorization rules stay unchanged.

Renewal rechecks wall-clock deadlines at most every 30 seconds, so a clock jump cannot leave a
24-hour monotonic timer pretending grants are current. Status distinguishes scheduled, refreshing,
retrying, expired, and stopped; it contains only expiry and failure count. Actual RPC validation
remains authoritative. A stopped supervisor cannot promise further renewal. Invalid or already
expired refresh results are failures, and clock movement never replays an operation.
