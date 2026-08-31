# M10.15 contextual Console controls verification

**Result: PASS at L3**

## Scope

This report verifies the Human Console presentation change from an always-visible inspector to a
contextual side panel. It covers the default full-width terminal, explicit MCP and Advanced
controls, automatic Agent Approval and BROKEN Session recovery presentation, and the retained
underlying Actions rather than changing Runtime semantics.

Environment: macOS arm64, Node.js 24, pnpm 10, real Chromium through Playwright, real zsh and
node-pty, the official MCP client, and a local PostgreSQL test database.

## Automated gate

```sh
ITERM_DATABASE_URL=postgresql://iterminal:<redacted>@127.0.0.1:55432/iterminal_test \
  pnpm test:m5:browser
```

Result: four Browser scenarios passed.

## Browser observations

1. The page starts without `.inspector`, leaving the terminal as the only workspace column.
2. `Connect MCP` explicitly opens the side panel, exposes the complete JSON handoff, and closes
   without leaving an empty rail.
3. A pending Agent Execute Approval opens the Approval view automatically; the exact command and
   approve/deny Actions remain functional. The decision reason is absent from the empty state.
4. A BROKEN durable Session opens the recovery view automatically and preserves stale-boundary
   acknowledgement plus rebuild behavior.
5. Input policy, active guard details, terminal geometry, and raw Event activity remain available
   through `Advanced`, but no longer consume space during ordinary terminal use.
6. Session termination is labelled `Close Session`; a RUNNING Session requires explicit browser
   confirmation before its process is stopped.

## Not proven

- A formal usability study, product analytics, or measured task-completion improvement.
- Complete keyboard, screen-reader, contrast, zoom, mobile, or WCAG conformance.
- Pixel-identical rendering across browsers, operating systems, fonts, or display densities.
- The behavior of arbitrary third-party MCP clients beyond the exercised official client path.

## Conclusion

The exercised Browser path preserves MCP handoff, approvals, checkpoint rebuild, interaction
policy, geometry, Timeline, and Session close capabilities while removing their permanent layout
cost. L3 applies to the tested local Browser/PostgreSQL path, not to general usability or
accessibility certification.
