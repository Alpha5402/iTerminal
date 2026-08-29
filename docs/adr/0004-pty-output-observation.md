# ADR-0004: Merged PTY output and two observation models

- Status: Accepted for M0
- Date: 2026-08-30

## Context

A PTY exposes a terminal byte stream rather than independent stdout/stderr pipes. TUI programs use ANSI/VT control sequences, so historical bytes alone do not describe the current screen.

Humans need a live high-bandwidth terminal. Agents need bounded, selective observations.

## Decision

- Persist PTY data as `pty_output` chunks; do not invent stdout/stderr attribution.
- Maintain append-only Session Events for history.
- Build a versioned Virtual Screen materialized view in M6.
- Human clients consume live PTY bytes plus structured metadata.
- Agent clients query bounded event ranges/search results and screen snapshots.
- Every result has hard limits, truncation metadata, and generation-scoped cursors.

## Consequences

- Tests must compare xterm.js and headless VT rendering at canonical geometry.
- Large raw output may move to an artifact backend while PostgreSQL retains indexes/refs.
- Slow consumers never block the PTY reader; they receive a resync boundary.
