# Resumable Realtime Conversation

Solution for Problem 1 of the challenge. Full write-up in [SUBMISSION.md](./SUBMISSION.md).

## Quick start

```bash
npm install
npm test          # runs all AC tests against an in-memory Mongo
npm run benchmark # verification benchmark — 40 tokens, 1 mid-stream reconnect
```

## Demo

Requires a local MongoDB on `mongodb://127.0.0.1:27017` (or set `MONGO_URL`).

```bash
npm run dev:server   # http://localhost:4000
npm run dev:client   # http://localhost:5173
```

Try in the browser:
1. Type a message and hit Send.
2. Click **Force disconnect** mid-stream — watch the status pill go `reconnecting`.
3. Click **Reconnect** — the reply picks up where it left off.
4. Send a message containing `FAIL` to see the failure path.
5. Send `COUNT:50` to force a longer reply.
6. Refresh the page mid-stream — the runId + cursor are in `localStorage`, so it resumes across full reloads too.

## Layout

```
server/    Express + Mongo + SSE stream + resume protocol
client/    React + Vite chat UI with connection-state pill
```

See [SUBMISSION.md](./SUBMISSION.md) for architecture, trade-offs, and the AC-to-test map.
