# M9.18 high-cardinality rolling soak verification — 2026-08-30

## Claim and level

**Result: PASS at L4 for the M9 local failure/pressure gate (real PostgreSQL 17, one independent Router, eight independent Runtime processes, eight independent Guardian processes, real Unix RPC/node-pty/zsh, 1,043 graceful owner drain/replacement rotations, 33,400 unique root Sessions, and an unshortened 30-minute sustained run).** Every accepted root-create identity settled to one distinct Session, each wave returned to zero unfinished intents/live Sessions/open leases, equal-weight placement debt reconciled exactly, every replacement advanced only its stable owner's epoch, and every old Guardian disappeared before replacement. PostgreSQL client connections and Runtime/Guardian RSS stayed within explicit bounds.

This closes the defined M9 multi-owner local chaos/pressure Exit Gate. It does not upgrade the whole repository to release L4 or production readiness; physical multi-host deployment, correlated database/broker failure under this load, cross-platform soak, security gates, and multi-week dogfood remain M8/M10 work.

## Environment and commands

- Host: macOS Darwin, arm64; Node.js 24.15.0.
- Database: PostgreSQL 17 Alpine, default `max_connections=100`, repository disposable M2 Compose fixture.
- High topology: one Router + eight Runtime/Guardian pairs; 16 rolling replacements; 32 concurrent creates per wave.
- Soak topology: one Router + eight Runtime/Guardian pairs; 32 concurrent creates per wave for at least 1,800,000 ms.

```bash
ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm test:m9:rolling:smoke

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm test:m9:rolling:high

ITERM_DATABASE_URL=postgresql://iterminal_test:iterminal_test@127.0.0.1:55432/iterminal_test \
  pnpm test:m9:rolling:soak

pnpm verify
```

- Final `pnpm verify`: 23 test files passed / 28 skipped; 88 tests passed / 85 skipped; 43 milestone reports verified; TypeScript and Console production builds passed. The existing 543.01 kB Vite chunk-size warning remains non-blocking.

## Recorded results

| Profile | Owners | Rotations | Sessions |     Elapsed | Create-wave P95 | Rotation P95 | PostgreSQL clients peak |  RSS baseline |      RSS peak |     RSS final |
| ------- | -----: | --------: | -------: | ----------: | --------------: | -----------: | ----------------------: | ------------: | ------------: | ------------: |
| smoke   |      6 |         6 |      126 |     3.331 s |          251 ms |       554 ms |                      42 | 1,140,192 KiB | 1,145,440 KiB | 1,092,688 KiB |
| high    |      8 |        16 |      536 |    11.683 s |          521 ms |       822 ms |                      54 | 1,546,864 KiB | 1,572,416 KiB | 1,410,896 KiB |
| soak    |      8 |     1,043 |   33,400 | 1,804.090 s |        5,147 ms |     5,604 ms |                      54 | 1,504,816 KiB | 1,542,880 KiB | 1,165,040 KiB |

The soak result line was:

```text
M9_ROLLING_RESULT {"baselineRssKilobytes":1504816,"createLatencyP95Milliseconds":5147,"elapsedMilliseconds":1804090,"finalRssKilobytes":1165040,"maximumDatabaseConnections":54,"maximumRssKilobytes":1542880,"ownerCount":8,"profile":"soak","rotationCount":1043,"rotationLatencyP95Milliseconds":5604,"totalSessions":33400,"waveSessions":32}
```

## Proven invariants

| Boundary                   | Evidence                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| High owner cardinality     | Eight boot-independent Runtime processes and eight independent Guardians remained composed behind one Router             |
| Root-create exactness      | 33,400 request rows bound 33,400 distinct Session IDs; final unfinished count was zero                                   |
| Rolling settlement         | Every target persisted `DRAINING`, settled exact-owner requests/responses, reached `STOPPED`, and exited normally        |
| Healthy-owner progress     | Every initial owner and one non-draining owner in each rotation completed a real zsh command                             |
| Session fencing cleanup    | Every wave returned to zero non-`CLOSED` Sessions and zero unreleased generation leases                                  |
| Guardian lifecycle         | Every drained Guardian PID disappeared before the same stable owner registered its replacement                           |
| Incarnation monotonicity   | Final instance IDs and registry epochs exactly matched the counted replacements for each stable owner                    |
| Placement fairness         | After all owners returned ACTIVE, a bounded reconciliation wave made all equal-weight `placement_count` values identical |
| Database connection budget | Sampled create-wave peak was 54, below the 90-client test ceiling and PostgreSQL's 100-client fixture limit              |
| Runtime resource bound     | Peak RSS stayed only 38,064 KiB above warm-up baseline and final RSS was 339,776 KiB below baseline                      |
| Final shutdown             | All eight final Runtime processes exited cleanly, all final Guardians disappeared, and all owners persisted `STOPPED`    |

## Failures observed and resolved

1. The first smoke waiter checked child exit before consuming its final stderr chunk. The Runtime had logged `drain settled` and exited 0, but the test reported a timeout. The waiter now accepts already-delivered expected text before classifying exit.
2. The first eight-owner high run reached PostgreSQL's default 100-client limit and returned `PostgreSQL durable journal is unavailable`. Container logs contained repeated `FATAL: sorry, too many clients already`. The cause was compositional: one Runtime created durability/admission/observation/owner-registry pools whose historical maxima totaled 55. Durable Runtime mode now applies `ITERM_DATABASE_POOL_MAX` (default 2) to each role, giving eight possible connections per Runtime/endpoint. The repeated high and soak runs peaked at 54 clients.
3. The first 30-minute attempt failed after 1,269 seconds. PostgreSQL logs showed `canceling statement due to statement timeout` while concurrent placement waited on the global advisory lock during sustained checkpoint writes. The fixture's artificial one-second statement deadline was below observed healthy checkpoint latency. M9.18 now uses a bounded five-second deadline, and root-create retries retryable route failures for at most 30 seconds with the exact same global idempotency key/payload. A two-minute debug run (143 rotations / 4,600 Sessions) passed before the complete 30-minute run restarted from zero. No Execute/Input/Control replay was added.

## Configuration and operator boundary

- `ITERM_DATABASE_POOL_MAX` is a positive per-role, per-endpoint Runtime pool bound and defaults to 2. A durable Runtime has four database roles, so its one-endpoint maximum is eight connections.
- Database-wide planning must include `runtime_count * endpoint_count * 4 * pool_max` plus Router, relay, worker, Console, migration, monitoring, and administrative reserve. Ordered endpoint failover can temporarily retain idle connections to an old endpoint.
- `pnpm test:m9:rolling:smoke` is suitable for ordinary PostgreSQL CI. `high` and `soak` are explicit heavier gates. The manual `M9 rolling soak` workflow defaults to the unshortened 1,800,000 ms profile.
- Lowering `ITERM_M9_SOAK_DURATION_MS`, owner count, wave size, or minimum rotations is useful for debugging but is not this qualification result.

## Not proven

- Separate physical hosts/VMs, container orchestrators, cgroups, external STONITH, cross-region latency, or a host/kernel/Guardian failure.
- Simultaneous Runtime failures, database minority/promotion, RabbitMQ loss, or correlated database/broker partition during the same sustained load.
- Linux 30-minute soak, macOS/Linux clean-machine release matrix, PostgreSQL saturation above this bounded pool topology, or a production traffic distribution.
- Multi-hour/multi-day runs, two-week dogfood, security/secret/approval gates, disk-full/storage-corruption behavior, M10, or v1.0 production readiness.
