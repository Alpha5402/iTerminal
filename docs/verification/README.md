# Verification evidence

This directory is the evidence archive behind iTerminal's milestone claims. These files are not
current-status pages and are not intended as onboarding documentation.

Each dated report records:

- the exact environment and dependencies used;
- the commands and real component path exercised;
- the observed result and evidence level;
- failures encountered while establishing the valid run;
- a mandatory `Not proven` boundary.

`pnpm verify:docs` checks the required report set for an explicit evidence-level PASS and retained
limitations. A later implementation may supersede a result, but it does not rewrite what the
original run proved. New evidence should be added only when it supports a concrete acceptance gate;
temporary logs, raw command output, and speculative progress notes do not belong here.

Reports are grouped by milestone from `M0/` through `M10/`. Use the corresponding ADR or
[TODO.md](../../TODO.md) acceptance gate to find the relevant report rather than treating directory
order as product documentation.
