# Bounded event observation

M3 defines the durable read boundary between the append-only terminal timeline and an Agent. It does not stream the complete PTY history into a model context. Every read is scoped to one Session generation, explicitly bounded, and resumable while retained history remains continuous.

## Read model

`PostgresObservationRepository` exposes five operations:

1. `getEvent(eventId)` returns one structured Event with Action, Execution, and Actor attribution when present.
2. `getExecution(executionId)` returns Execution metadata, its observed Event range, and aggregate PTY output bytes without returning the output body.
3. `queryEvents(query)` filters by generation-scoped sequence, time, Execution, and Event type. A page contains at most 500 Events.
4. `searchEvents(query)` uses PostgreSQL full-text search and returns at most 50 matches. Each match carries at most ten Events before and ten after it.
5. `readArtifact(id, offset, limit)` returns at most 64 KiB as base64 and declares `truncated` plus `nextOffset` when more bytes remain.

Timeline rows join Actor identity from the accepted Action when attribution exists. PTY output observed outside an Action may legitimately have no Actor; the repository does not invent one.

## Cursor contract

The Event cursor is an opaque base64url document containing:

- protocol version;
- Session ID and generation;
- last returned Event sequence;
- a hash of the immutable query filters.

Changing the Session, generation, or filters while reusing a cursor returns `RESYNC_REQUIRED`. Page size may change because it does not change membership. A malformed cursor also returns `RESYNC_REQUIRED`.

Retention removes only an old prefix. Before serving a nonzero cursor, the repository compares its next expected sequence with the minimum retained sequence. If the cursor falls into the removed prefix, it returns `RESYNC_REQUIRED` with `minimumAvailableSequence`; it never silently pretends the missing history was observed.

Cursors are continuity tokens, not authorization capabilities. Transport adapters must authenticate the caller and authorize the Session before calling this repository.

## Output and artifact boundary

PTY remains one merged byte stream. Each persisted output Event records:

- `byteCount`;
- a 2 KiB `tailPreview`;
- inline `data` when the UTF-8 chunk is at most 4 KiB; or
- an `artifactRef` when the chunk is larger.

Large content is stored in `artifacts` with content type, byte size, SHA-256, creation time, and a seven-day expiry. Artifact and Event writes share one SQL transaction and one generation-scoped Event sequence allocation. A large payload is therefore addressable without being copied into every timeline response.

The artifact table is the M3 local PostgreSQL implementation, not a claim that PostgreSQL should hold unlimited production blobs. A later storage adapter may replace the content column with object storage while preserving the reference/read contract.

## Search and memory bounds

`session_events.search_text` has a `simple`-configuration GIN full-text index. Output ingest stores the original searchable text independently of the bounded Event payload. This makes sparse tokens such as `FAIL` discoverable without scanning or returning the full terminal transcript.

The 100,000-line fixture is generated and inserted inside PostgreSQL, then consumed through a 50-Event page and four bounded search results. Application response memory is proportional to page/context limits rather than retained Event count. This proves the observation adapter's response bound; it is not a production load or soak claim.

## Consistency boundary

M3 proves the PostgreSQL observation repository independently. The live M1 PTY Runtime still writes to the in-memory RuntimeStore. Wiring PTY ingestion to PostgreSQL requires a nonblocking append loop with backpressure and crash semantics; that remains future work and is not implied by these read APIs.
