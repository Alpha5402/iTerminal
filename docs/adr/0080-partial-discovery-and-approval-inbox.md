# ADR 0080: Bounded discovery and global approval inbox

Status: Accepted

`session.list.v2` is an authenticated read with a separate RPC operation. It uses ascending
Session ID keyset pagination (default 50, maximum 200). The PostgreSQL registry limits candidate
rows before querying live owners. At most four owner reads are in flight. Each returned item
separates the last durable status from `liveAvailability`; an unreachable owner never turns a
historical READY record into a live Session. Generation/owner disagreement is a conflict.
Failures of individual owners yield partial results; registry failure remains a top-level error.
The existing array-shaped session list and all write routing/fencing remain unchanged.

`approval.pending.list` is a separate authenticated Human capability read. It uses a bounded
compound Session/Approval ID cursor. It reports partial/unavailable owners and a lower-bound
count, not a global exact total. It does not decide or consume approvals. Decisions retain exact
Session/generation and expected approval version, and are never automatically replayed.

The current product is a shared local trust domain: separate Actor identities are audit and
capability boundaries, not per-Session ACLs. The inbox must require approval.decide capabilities.
Future Session ACL filtering must happen before pagination/counts (see the dedicated ACL design).

Owner probes have a two-second deadline. Pending-inbox transport cancellation propagates through
the router to the active probe and stops the remaining traversal; cancellation is not a successful
empty or partial inbox response. Read cancellation never replays or cancels an accepted Action.
