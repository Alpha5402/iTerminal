# ADR-0056: Layered Capability, interaction policy, and Approval matrix

- Status: Accepted for M10.10
- Date: 2026-08-31

[ADR-0062](./0062-runtime-terminal-cursor-replies.md) adds a private Runtime-generated cursor
response exception. Public Input APIs retain the Human/Agent-only matrix below; a System caller
cannot use it to submit terminal response bytes.

## Context

ADR-0023 defines generation-scoped Input Policy and Human Interaction Guards. ADR-0047 adds
explicit Actor capabilities and immutable identity. ADR-0049 adds durable one-time Approval for
Agent Execute, and ADR-0050 adds Human-only secret input. Each decision is implemented, but the
combined authorization contract is spread across several documents and tests.

That fragmentation makes two unsafe interpretations plausible:

1. a capability might be treated as a role promotion or as a way to bypass Input Policy;
2. Approval might be treated as a generic terminal-write gate even though only Agent Execute has
   an Approval policy.

M10.10 freezes the combined contract and requires executable matrix coverage. It does not add a
command classifier, generic risk engine, or new Approval scope.

## Decision

### Independent layers

Authorization is the conjunction of independent layers:

1. the transport authenticates a scoped Runtime RPC grant and checks the operation plus Actor
   scope when the operation has an Actor;
2. Application validates the canonical, immutable Actor identity and required capability;
3. the operation's Actor-type restriction is applied;
4. generation, target Execution, Input Policy, active Guard, sensitive period, version, and other
   operation preconditions remain in force;
5. only a new Agent `execution.start` admission evaluates Agent Execute Approval policy.

A capability is an affirmative operation grant, not a role conversion. Giving an Agent every
closed capability does not make it a Human, giving a System terminal capabilities does not give it
Human/Agent interaction rights, and changing Input Policy does not create a missing capability.

### Actor-bearing operation matrix

| Operation                | Required capability                                     | Actor-type constraint                                        | Input Policy / Guard                                                                                           | Approval                                                                                               |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Execute                  | `session.execute`                                       | Human, Agent, Scheduler, or System                           | none                                                                                                           | Agent only, when `agentExecuteApproval=required`; optional matching Approval may otherwise be consumed |
| fork/rebuild             | `session.fork`                                          | any Actor type with the capability                           | none                                                                                                           | none                                                                                                   |
| Input                    | `terminal.input`                                        | Human or Agent                                               | exact generation/Execution plus current policy and Guard                                                       | none                                                                                                   |
| Control                  | `terminal.control`                                      | Human or Agent; only Human may request Guard bypass          | exact generation/Execution plus current policy and Guard; sensitive period keeps only initiating Human Control | none                                                                                                   |
| Resize                   | `terminal.resize`                                       | Human or Agent                                               | current policy and Guard plus geometry CAS                                                                     | none                                                                                                   |
| set Input Policy         | `interaction.policy.manage`                             | Human or System                                              | versioned generation state; changing policy clears Guard                                                       | none                                                                                                   |
| acquire Guard            | `interaction.guard.manage`                              | Human                                                        | `RUNNING`, `human_guarded`, no current Guard                                                                   | none                                                                                                   |
| renew/release Guard      | `interaction.guard.manage`                              | exact Human holder                                           | exact current Guard and state version                                                                          | none                                                                                                   |
| request Execute Approval | `approval.request`                                      | Agent                                                        | exact generation and proposed Execute identity                                                                 | creates Approval; does not admit an Action                                                             |
| get/list Approval        | own Agent: `approval.request`; Human: `approval.decide` | Agent sees only its own; Human sees exact-generation records | none                                                                                                           | read only, except lazy expiry materialization                                                          |
| decide Execute Approval  | `approval.decide`                                       | Human                                                        | exact pending version and unexpired record                                                                     | one terminal decision                                                                                  |
| begin secret input       | `secret.input`                                          | Human                                                        | exact generation/Execution plus current policy and Guard; no active sensitive period                           | none                                                                                                   |
| get secret-input state   | `secret.input`                                          | Human                                                        | exact generation                                                                                               | none                                                                                                   |
| finish secret input      | `secret.input`                                          | exact initiating Human                                       | exact active sensitive id/version                                                                              | none                                                                                                   |

The exported initial profiles remain construction defaults, not implied authority. In particular,
the System profile contains Control and Resize capabilities for explicit service identities, but the
current Human/Agent-only interaction policy still denies System Control and Resize.

### Denial and side-effect boundary

Capability, Actor-type, policy, or Guard denial must happen before allocating an accepted Action,
reserving an Execution, or touching the PTY. Interaction operations may append a bounded
`interaction.policy_denied` or `interaction.input_guarded` audit Event after a valid Session target
has been established; the Event never contains command, input, or secret bytes. Approval reads and
mutations, Execute, and fork use structured errors without creating an accepted Action.

Existing freshness and replay ordering is preserved:

- an exact already-accepted Input/Control/Resize replay remains stable after later policy changes;
- Execute still requires the Actor's immutable `session.execute` capability, while exact replay of
  an already admitted approved Execute remains possible after its Approval is `CONSUMED`;
- invalid request shape, stale generation/target/version, or unavailable durability may fail before
  a policy decision where the governing operation ADR already specifies that order;
- no denial after a possible PTY write is rewritten as a safe policy failure; uncertain delivery
  remains `UNKNOWN`.

### Operations outside the Actor capability matrix

Root Session creation, Session close, dispatch, wait, and current read-only observation APIs do not
all carry Actor context. They are not retroactively described as capability-protected. Runtime RPC
still requires an authenticated operation-scoped grant, Console supplies its fixed Human identity
where applicable, MCP supplies its fixed Agent identity, and Worker dispatch uses its exact System
service grant. Adding Actor-level authorization to those operations requires a separate protocol and
migration decision.

## Consequences

- Capability, role, Input Policy/Guard, and Approval can be tested without conflating their
  responsibilities.
- A forged or over-broad capability list cannot promote an Actor type or expand Approval scope.
- Agent Execute Approval remains reviewable raw-command admission rather than a heuristic risk
  classifier.
- Some trusted-service and read operations remain protected only by transport operation grants;
  this matrix makes that limit explicit instead of overstating coverage.
- Future Approval scopes require a new ADR, request identity, atomic-consumption rule, UI, and
  retention decision for each operation class.

## Rejected alternatives

- **One role-default allow table:** hides least-privilege capability subsets and makes a capability
  look like an implicit role property.
- **Capability overrides Actor type or Input Policy:** turns a narrow grant into privilege
  escalation and invalidates Human Guard semantics.
- **Approval for every PTY write:** raw Input and Control cannot use the Agent Execute command-review
  workflow without a distinct identity and usable interaction design.
- **Command-text risk classification:** Shell text is not a reliable statement of side effects and
  cannot become authorization truth.
- **Claim every RPC operation is Actor-capability protected:** several trusted-service and read
  operations intentionally have no Actor at the Application boundary today.
