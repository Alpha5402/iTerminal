# ADR-0063: Explicit file-backed MCP credentials

- Status: Accepted
- Date: 2026-09-02
- Refines: ADR-0048, ADR-0055, ADR-0059

## Context

A copied 24-hour grant in a client's static environment can expire even while the operator's local
`mcp.json` contains a newer issued grant. MCP initialization and tool discovery do not contact the
Runtime, so a listening stdio bridge is not evidence of Runtime authorization or readiness.

## Decision

The MCP bridge may explicitly receive `ITERM_MCP_CONFIG_FILE`, an absolute path to the private local
`mcp.json`. It is mutually exclusive with `ITERM_RPC_GRANT`; there is no automatic credential search,
fallback after denial, renewal, signing, or access to a Runtime signing key. Static grants remain
supported for clients that deliberately copy the handoff.

In file mode, each RPC attempt reads the bounded, same-user, private regular file without following
a final symlink. It extracts only the `iterminal` server's grant. File-specified command/arguments
are never executed. The configured socket and Actor must match the bridge's explicit fixed target;
the grant's declared Actor/capabilities must also match. A missing, invalid, insecure, mismatched, or
declared-expired source fails closed. Local source errors expose only fixed diagnostic messages,
never JSON/parser errors or credential bytes. Declared expiry is local diagnostic evidence, not a
substitute for server signature verification. Runtime verification retains the uniform denial
contract for signatures, audiences, operations, and Actor authorization.

The Unix RPC client accepts an optional asynchronous authorization provider, exclusive with a
static token. It resolves once before opening each request connection and never retries the
operation with another token. This is credential-source refresh between requests, not a change to
Action idempotency, UNKNOWN delivery, Actor capability, or server authentication semantics.

The initial client configuration change needs an MCP process restart. Later operator replacement
of the same private file is read on the next operation without restarting the Runtime or PTYs.
Expired grants still require an authorized operator to provide a valid grant. No existing Session
or Execution is restored by this mechanism.

## Boundaries

This is opt-in local same-user file delegation, not OAuth, a new issuer, remote login, automatic
24-hour renewal, revocation, or protection against hostile code running as the same OS user.
The bridge never hides transport unavailability behind an authentication diagnosis.
