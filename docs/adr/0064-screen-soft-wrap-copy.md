# ADR-0064: Preserve terminal soft wraps when copying

- Status: Accepted
- Date: 2026-09-02
- Refines: ADR-0019, ADR-0021, ADR-0024

## Context

The Console repaints canonical viewport rows with CRLF separators. This loses xterm's soft-wrap
flags. Native browser-terminal selection then copies visual wraps as real newlines, corrupting
long paths and command arguments when pasted into the READY editor. Command dispatch correctly
preserves those bytes; stripping all pasted newlines would also destroy legitimate Shell grammar.

## Decision

Snapshots add optional `wrappedRows`, a bounded boolean array aligned with `lines`. Each flag says
whether the row continues its preceding terminal row, as observed by the canonical parser. The
current producer always supplies it; absence from an older producer means unknown, never inferred
from row width, prompt text, or Shell grammar. Row diffs add `wrapped` and include wrap-only changes.
Snapshot clones copy the array. Resizing and buffer changes retain their existing resync boundaries.

Rows followed by a soft continuation retain actual trailing space cells (but not unoccupied padding
before a wide glyph); other text rows retain the existing right-trimmed representation.

The Console uses the last completed rendered snapshot's flags and public xterm cell/selection APIs
for ordinary linear copy. It joins soft continuations without a newline and preserves hard breaks,
including empty lines. Partial selections use terminal-cell offsets, not JavaScript string offsets.
The handler is scoped to terminal output, not READY or secure editors. Legacy snapshots, column
selection, stale/pending renders and out-of-viewport selections keep the existing native behavior.
Clipboard content remains plain text. No command submission, history mutation, clipboard read,
automatic paste repair, additional PTY input, or sensitive-output bypass is introduced.

## Boundary

This fixes copying the currently displayed canonical viewport. It does not reconstruct erased
output, offscreen history, previously corrupted command history, or the original source of text
copied from other applications. Existing live Runtime instances need an explicit restart to emit
the new metadata; the change must not silently restart user programs.
