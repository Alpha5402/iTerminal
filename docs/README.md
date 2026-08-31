# iTerminal documentation

This directory contains durable product contracts and operational evidence. It is intentionally
organized by purpose so that current guidance is not mixed with milestone history.

## Start here

- [Canonical terminology](./TERMINOLOGY.md) defines the domain language used by code, protocols,
  and ADRs.
- [Architecture](./architecture/) explains the stable runtime boundaries that span multiple
  components.
- [Protocols](./protocol/) documents supported external and local adapter contracts.
- [Operations](./operations/) contains runnable setup, security, retention, storage, and capacity
  procedures.
- [Architecture Decision Records](./adr/README.md) preserve why important runtime contracts were
  chosen.
- [Verification evidence](./verification/README.md) records the real environments, commands,
  results, and limitations behind milestone claims.

The changing delivery plan and open acceptance gates live in [TODO.md](../TODO.md), not in this
directory's product guides.

## Directory roles

| Directory       | Audience                         | Lifecycle                                                                 |
| --------------- | -------------------------------- | ------------------------------------------------------------------------- |
| `architecture/` | Implementers and reviewers       | Updated when a cross-component runtime boundary changes                   |
| `protocol/`     | Adapter and client authors       | Updated with the supported wire/API contract                              |
| `operations/`   | Local operators and contributors | Updated in place with executable procedures                               |
| `adr/`          | Architecture reviewers           | Append-only decision history; supersession is explicit                    |
| `verification/` | Reviewers validating claims      | Evidence records retained with their original environment and limitations |

## Documentation policy

- Product status, milestone checklists, and future work belong in `TODO.md`.
- Current setup instructions belong in `operations/`; command dumps do not belong in the root
  README.
- A decision that changes runtime truth requires an ADR. Accepted ADRs are not deleted merely
  because a later ADR refines them.
- Verification reports are evidence, not user guides. They are kept because release claims and
  `pnpm verify:docs` depend on them.
- Experimental notes stay beside their spike under `spikes/`. Temporary drafts, implementation
  scratchpads, and obsolete generated summaries should not be committed under `docs/`.
- The in-memory JSONL CLI remains a developer fixture in `apps/cli`; it is not a supported public
  protocol or onboarding path.
