# ADR 0022: Stable bounded screen-cell style DTO

- Status: Accepted for M6.4
- Date: 2026-08-30

## Context

M6.1–M6.3 expose plain text, regions, row diffs, search, and waits. Plain text cannot distinguish an error highlighted in red, inverse-video selection, invisible password input, or a styled blank background. Passing xterm.js `IBufferCell` objects through Application/RPC would leak a proposed dependency API into the domain and make clients depend on numeric color bitfields.

The pinned `@xterm/headless` 6.0.0 public buffer cell exposes glyph width, characters, default/palette/RGB color modes, and boolean SGR attributes. It does not expose a stable hyperlink target or image/sixel payload through that same API.

## Decision

- Domain defines an xterm-independent `TerminalScreenCell` DTO with absolute zero-based viewport row/column, text, terminal-cell width, and a sparse style object.
- Foreground/background colors are omitted when default. Non-default colors are represented as one explicit union:
  - `{ mode: "palette", index: 0..255 }`
  - `{ mode: "rgb", red: 0..255, green: 0..255, blue: 0..255 }`
- Supported boolean attributes are bold, italic, dim, underline, blink, inverse, invisible, strikethrough, and overline. Only enabled attributes appear as `true`; an empty style object means terminal defaults.
- An invisible cell preserves its width and `invisible: true` metadata, but its concealed buffer characters are mapped to visual blank text in full snapshots, regions, search, diffs, and cell results. This avoids presenting non-rendered content as visible evidence; it is not a substitute for the broader secret-redaction milestone.
- Runtime RPC and MCP add exact-generation `screen.cells` / `screen_cells`. The request uses the same validated 120×40 terminal-cell rectangle as `screen_region` and returns current frame metadata plus row-major material cells.
- Default blank cells and wide-character continuation cells are omitted. Styled blank cells are retained. A wide glyph is emitted only when its complete cell span is inside the requested rectangle; a clipped glyph is represented by absence, matching the blank clipping contract of `screen_region`.
- The natural fixed viewport is the hard response bound: at most 4,800 cells. Callers should request the smallest useful region.
- Cell/style reads are current live observations only. Plain-text `screen_diff` remains a row replacement protocol and does not claim style-diff parity.
- Hyperlink targets, underline variants/colors, images, sixel, mouse state, clipboard sequences, font metrics, and pixel screenshots remain explicitly unsupported rather than inferred from private xterm internals.

## Consequences

- Agents and a future Human Console can inspect standard SGR semantics without importing xterm types or decoding bitfields.
- Sparse default omission keeps ordinary screen responses materially smaller while preserving styled spaces and wide-character geometry.
- Style-only changes advance `screenVersion`, but incremental style consumers must reread the affected region; no style-diff contract exists yet.
- Upgrading xterm remains isolated to one adapter and requires fixture comparison of palette/RGB modes, attributes, wide cells, and styled blanks.
