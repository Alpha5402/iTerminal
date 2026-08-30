# M6.4 styled screen cells verification — 2026-08-30

## Claim and level

**Result: PASS at L2 (real node-pty/zsh, pinned headless ANSI/VT parser, Unix RPC, official MCP SDK client, sparse material cells, palette/RGB colors, standard SGR attributes, styled blanks, and wide-cell clipping).** `screen_cells` returns an xterm-independent bounded DTO tied to one exact current `screenVersion`.

This proves standard live cell/style observation. It does not prove style diffs, hyperlink/image protocols, frontend renderer parity, Human Console behavior, durable style reconstruction, or M6 L3 acceptance.

## Environment

- Host: macOS Darwin 25.5.0, arm64
- Node.js: 24.15.0
- Shell path: real persistent zsh under node-pty
- Terminal emulator: exactly pinned `@xterm/headless` 6.0.0
- Geometry: canonical 120 columns × 40 rows; at most 4,800 returned cells
- Client path: official MCP TypeScript SDK v2 client → stdio bridge → Unix Runtime RPC → live Runtime projection

## Commands and results

```bash
pnpm exec vitest run packages/terminal-screen/src/index.test.ts packages/runtime-rpc/src/index.test.ts apps/mcp/src/screen-observation.test.ts apps/mcp/src/mcp-stdio.test.ts
pnpm verify
```

- M6 projection, RPC, and real MCP integration: 4 test files passed, 16 tests passed.
- Full repository gate: 11 test files passed, 42 tests passed, 12 environment-gated files skipped; format, lint, typecheck, 19-report verification gate, and build passed.

## Proven scenarios

| Scenario                   | Result                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Stable dependency boundary | Domain/Application/RPC/MCP use plain DTOs; only the terminal-screen adapter imports xterm buffer-cell types                      |
| Palette foreground         | ANSI 256-color foreground is returned as `{ mode: "palette", index }`                                                            |
| RGB background             | ANSI true-color background is returned as explicit red, green, and blue channels                                                 |
| Standard SGR attributes    | Bold, italic, dim, underline, blink, inverse, invisible, strikethrough, and overline survive parser and MCP serialization        |
| Invisible text boundary    | Concealed buffer characters become visual blanks in snapshot/region/search/cells while width and `invisible: true` remain        |
| Default style              | A reset ordinary glyph has an empty style object rather than xterm bitfields or invented color values                            |
| Sparse default blanks      | Unstyled empty/space cells and wide continuation cells are omitted                                                               |
| Styled blank               | A blank carrying active color/SGR attributes remains a material cell                                                             |
| Wide-character geometry    | A CJK base cell reports width two; a region beginning on its continuation omits the clipped glyph                                |
| Exact frame                | Cell results include current Session/generation, buffer, cursor, geometry, and applied `screenVersion` metadata                  |
| Official MCP path          | A real SDK client drives styled ANSI output through zsh and reads the same palette/RGB/SGR DTO through `screen_cells` over stdio |

## Runtime contract

- `TerminalScreenCell` coordinates are absolute zero-based cells in the active viewport; result order is row-major.
- `text` may contain one normal glyph, a wide glyph, emoji, or a combined Unicode sequence. `width` is terminal-cell width, not JavaScript string length. Invisible cells return empty text while retaining their width and style.
- Missing foreground/background means terminal default. Enabled boolean attributes appear only as `true`; absence means disabled/default.
- A default blank is absence from the sparse list. A styled blank is present even when its `text` is empty or one space.
- Reads share the serialized parser lane and are current-only. Style-only PTY output still advances `screenVersion`, but plain `screen_diff` does not report a style patch.

## Not proven

- Style/cell diffs, historic style revisions, durable style snapshots, daemon restart resume, or cross-owner reconstruction.
- Hyperlink targets, underline variants/colors, images, sixel, mouse modes, clipboard sequences, font metrics, pixel dimensions, or screenshots.
- Complete ECMA-48/xterm conformance, custom OSC/DCS protocols, Unicode version parity, grapheme edge cases, or every terminal emulator quirk.
- Frontend xterm.js renderer parity, themes/palette resolution, accessibility semantics, WebSocket subscription/fan-out, or Human Console resynchronization.
- Resize/reflow, geometry ownership, Input Guard/policy modes, TerminalState heuristics, secret redaction, Approval flow, multi-Worker fencing, cross-platform behavior, long soak, security review, L3 Human-Agent acceptance, or release readiness.
