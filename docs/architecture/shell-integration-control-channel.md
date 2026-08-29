# Shell Integration control-channel compatibility

This matrix settles the M0 transport direction. It does not turn the spike transport into the production adapter.

| Property                                       | Separate close-on-exec FD / supervisor channel        | Private POSIX FIFO (M0 spike)            | Authenticated OSC/DCS in PTY output                   |
| ---------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| Separation from visible PTY bytes              | Physical                                              | Physical                                 | Logical only                                          |
| Ordinary output can accidentally forge a frame | No                                                    | No                                       | Mitigated by nonce and strict parser                  |
| Same-user malicious code is isolated           | No; not a sandbox                                     | No; path/FD attacks remain possible      | No; terminal stream and shell state are observable    |
| Survives arbitrary read chunking               | Yes, with framed decoder                              | Yes; verified with NUL-framed decoder    | Yes only with a streaming VT-aware parser             |
| Child process inheritance                      | Prevented with `CLOEXEC`/supervisor ownership         | FIFO path can be inherited or discovered | Inherent access to PTY output                         |
| Portability                                    | POSIX FD passing; Windows needs an equivalent channel | POSIX only (`mkfifo`)                    | Broad terminal transport, parser compatibility varies |
| Terminal/user-visible pollution                | None                                                  | None                                     | Sequences traverse the user-visible channel           |
| M0 evidence                                    | Direction selected, not yet production-built          | bash/zsh L2 spike passes                 | Analysed fallback; not implemented                    |

## Decision

- M1 builds a Runtime-owned, close-on-exec out-of-band channel or an equivalent local supervisor channel.
- The FIFO remains disposable spike code because it proves framing and separation but has weaker inheritance and portability properties.
- OSC/DCS is allowed only as a documented compatibility fallback with a per-session nonce, strict length-bounded streaming parser, and explicit trust-boundary tests.
- None of these channels is an OS sandbox. Same-user adversarial code requires process isolation and policy outside Shell Integration.

## Required production checks

- Shell builtins can emit HELLO/PREEXEC/RESULT/READY after child descriptors are closed on exec.
- Partial, coalesced, oversized, unknown, duplicated, and out-of-order frames fail closed.
- User rc, prompt frameworks, aliases, traps, and nested shells cannot silently replace managed hooks.
- Linux bash/zsh and supported macOS versions repeat the M0 scenario set in CI.
