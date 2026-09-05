# Astra direct-execution experiment

Start baseline: `5c59a49ed034bb3d6e59231a4c3e93f20128d4ea`, 19/36 accepted.

Astra takes direct ownership; no delegated implementation. D01 working diff (about 484 additions / 66 removals plus three new files) is inherited from Sol, not Astra-from-scratch work. D04 had no implementation. Coordinator and workers stopped before takeover.

Scope: C04/C05, D01/D02/D04/D05/D06/D07, E01–E06, F02–F04. Compare verified behavior and inherited work, not raw card counts. Experiment start is the takeover user turn in thread `01a06f9b-45e1-7c53-96f9-1a37ca54bfdc`; measure per-response usage for that turn.

Validation: scoped tests per semantic change, full gate at cohesive commit/push closure. No repeat merely for status documentation. Only isolated runtime/PG/browser fixtures.
