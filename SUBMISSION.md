# Resumable Realtime Conversation — Submission

Problem chosen: **#1 Resumable Realtime Conversation**.

## What it does

A client submits a message. The server streams a generated reply token-by-token over Server-Sent Events. If the connection drops, the browser is closed, or the server restarts mid-reply, the client reconnects and receives exactly the tokens it missed — no gaps, no duplicates, and terminal states (completed / failed / interrupted) are honest.

## Setup

Requirements: Node 18+ and either a local MongoDB or nothing (tests + benchmark use an in-memory Mongo).

```bash
npm install
```

### Run the demo (needs a local MongoDB running on 27017)

```bash
# terminal 1
npm run dev:server

# terminal 2
npm run dev:client
# open http://localhost:5173
```

If you don't have Mongo locally, set `MONGO_URL` to any reachable Mongo (e.g., a free Atlas cluster).

### Run tests (no Mongo needed — uses mongodb-memory-server)

```bash
npm test
```

### Run the verification benchmark

```bash
npm run benchmark
```

The benchmark:
1. Starts an in-process server + in-memory Mongo
2. Requests a 40-token reply
3. Reads ~10 tokens, hard-disconnects
4. Reconnects with the last-seen cursor
5. Drains to terminal
6. Prints `observedEvents`, `missing`, `duplicates`, `finalRunState`, and exits non-zero if any of them are wrong

## Architecture

### Wire model

Two entities, both in Mongo:

- **`Run`** — one generated reply. `{ _id, conversationId, userMessageId, userMessageContent, state, lastSeq, terminalAt, failureReason }`. `state ∈ {running, completed, failed, interrupted}`.
- **`Event`** — one durable, ordered entry in a run's log. `{ runId, seq, type, payload, createdAt }`. `type ∈ {chunk, completed, failed, interrupted}`. Unique index on `(runId, seq)`.

`seq` is assigned server-side by an atomic `findOneAndUpdate` that increments `Run.lastSeq` **only while the run is still `running`**. That single operation is where ordering and terminal-state safety are both enforced.

### Transport: SSE

Chosen over WebSocket because:
- The stream is one-way (server → client). WebSocket's bidirectionality is unused weight.
- SSE has native browser reconnect + `Last-Event-ID` — the browser already speaks our resume protocol, we just have to honor the header.
- Proxies and load balancers treat SSE as plain HTTP; WebSocket needs upgrade support end-to-end.

Trade-off: SSE has a hard cap of ~6 concurrent streams per origin in HTTP/1.1 browsers. Not relevant here; noted for production.

### Replay → live handoff (AC3)

The dangerous window is: a client reconnects while the run is still producing events. If we replay from Mongo first, live events emitted *during* replay would arrive out of order, or we'd deliver them twice, or we'd drop them.

The handoff:

1. **Subscribe to live pub/sub first** (buffer, don't emit yet). Nothing published during replay is lost.
2. **Replay events with `seq > cursor` from Mongo.** Track `lastSentSeq`.
3. **Flip a `handedOff` flag**, then drain the buffer, filtering `seq ≤ lastSentSeq` (dedup).
4. **Live events go straight through** with the same dedup guard.

Dedup is trivial because `seq` is monotonic and server-assigned. The client's cursor comparison and the server's `lastSentSeq` are the same invariant applied at both ends.

### Ownership of ordering

The server. `seq` is only ever assigned by Mongo's atomic increment. The client never guesses a position or reorders — it just accumulates by `seq` and remembers the highest one seen.

### What survives restart

Everything in Mongo: run metadata, every event, terminal state. On boot, `interruptOrphanedRuns()` sweeps `state: 'running'` and appends an `interrupted` event to each. This is the honest-restart policy: the previous process's generator is dead, so the run cannot honestly claim to still be producing.

A client reconnecting to an interrupted run gets the persisted history followed by the `interrupted` terminal event. It never sees a fake "still streaming" state.

Alternative policy considered: resume the generator itself. Rejected because our generator is deterministic and would produce the same tokens from scratch, which means either (a) we'd need to skip already-persisted tokens (complexity), or (b) we'd double-persist. Fake-generator resumability isn't the interesting part of this problem — durable history is.

### Terminal-state guard

Every append checks `{ _id: runId, state: 'running' }` in the filter. Once a run flips to `completed`, `failed`, or `interrupted`, no further events can be appended. Tests exercise this directly (AC5): after a failure, an attempt to append `completed` throws. This is how "a failed run cannot later become a completed run" is enforced structurally, not by convention.

### Cursor semantics (AC6)

- **Unknown run** → `404`, not a silent empty stream.
- **Cursor > `run.lastSeq` on a terminal run** → server emits an explicit `cursor_invalid` SSE event and closes. Client sees a real error, not silence.
- **Cursor < 0 or missing** → treated as `0` (full replay).

### Client reconnect policy

Exponential backoff, jittered, capped at 5s, bounded to 8 attempts. After the cap the client shows `disconnected` (not `reconnecting`) — the UI never lies about connectivity.

## Assumptions and non-goals

- **No auth, no multi-tenant.** Any client can read any run by id.
- **No real model.** A deterministic fake generator produces tokens. Failure is triggered by `FAIL` in the user message; token count by `COUNT:<n>`.
- **No cancellation.** Marked optional in the spec.
- **One assistant run per conversation at a time.** Not enforced by schema; per spec, out of scope.
- **Event log grows unbounded.** In production we'd retain a bounded window and treat older cursors as `cursor_invalid`. The `cursor_invalid` path is already implemented for the ahead-of-run case; extending it to a retention window would be a filter change plus a background pruner.

## Trade-off to discuss on video

**Per-event Mongo writes vs. batched writes.** Right now every token is one insert. That's the simplest thing that gives us exact resume — the cursor and the durable log agree on a per-token granularity. It's also the most write-heavy option. For high-QPS deployments I would batch chunks (e.g., every 50ms or every 20 tokens into a single doc holding a `chunks[]` array), and change resume to seek to `(chunk_doc_seq, offset_within_chunk)`. That's ~10× cheaper on writes but adds complexity to the replay/live overlap logic and to the client cursor. For a 6–8 hour exercise, the simpler per-event model is the right call, and it maps directly to what the spec describes as "an ordered position for every streamed event."

## Test map (which test proves which AC)

| AC | Test |
| --- | --- |
| AC1 ordered live stream | `AC1: ordered live stream reaches completed` |
| AC2 missed-event recovery | `AC2 + AC3: missed-event recovery with replay/live overlap and no dups` |
| AC3 replay/live overlap | same |
| AC4 service restart | `AC4: service restart — history persists, run marked interrupted, reconnect sees interrupted` |
| AC5 generation failure | `AC5: generator failure — run terminal-failed, cannot become completed` |
| AC6 unknown/stale cursor | `AC6: cursor ahead of a terminal run yields explicit cursor_invalid` + `AC6b: unknown runId yields 404` |
| Ordering invariant | `append-event uniqueness: two concurrent appends produce distinct seqs` |

## File map

```
server/src/
  models.js      Mongo schemas + unique(runId, seq)
  store.js      appendEvent atomic-seq + terminal guard, interruptOrphanedRuns
  generator.js  deterministic fake token stream (FAIL / COUNT:<n> hooks)
  pubsub.js     in-process live fanout
  runner.js     drives one run to terminal, persists + publishes each event
  app.js        Express, /messages, /runs/:id/stream (SSE + resume + AC6)
  index.js      boot, mongoose connect, orphan sweep
  benchmark.js  40-token run with a mid-stream reconnect; asserts 0 miss/0 dup
server/tests/
  helpers.js    memory-mongo lifecycle + SSE parser
  protocol.test.js  all ACs
client/src/
  useRun.js     SSE + resume + reconnect state machine + cursor persistence
  App.jsx       chat UI, status pill, force-disconnect for demoing
```
