const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const { createRun, getRun, eventsAfter } = require('./store');
const { startRun } = require('./runner');
const bus = require('./pubsub');

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

// SSE framing helper. `id:` is what the browser echoes back as Last-Event-ID.
// We use the event seq as the id so resume uses the same key as our log.
function sseWrite(res, event) {
  res.write(`id: ${event.seq}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify({ seq: event.seq, type: event.type, payload: event.payload })}\n\n`);
}

function buildApp({ generatorDelayMs } = {}) {
  const app = express();
  app.use(cors({ exposedHeaders: ['*'] }));
  app.use(express.json());

  // Track in-flight generators so we could cancel them (out of scope, but the
  // handle is here for restart-safety hooks).
  const inflight = new Map();

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Create a run for a user message. Returns runId — client then opens the
  // SSE stream separately. This split keeps the write path idempotent-friendly
  // and the read path a plain GET (which browsers reconnect for free).
  app.post('/messages', async (req, res) => {
    const { conversationId, content } = req.body || {};
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content required' });
    }
    const runId = newId();
    const userMessageId = newId();
    await createRun({
      runId,
      conversationId: conversationId || newId(),
      userMessageId,
      userMessageContent: content,
    });
    const handle = startRun(runId, content, { delayMs: generatorDelayMs ?? 8 });
    inflight.set(runId, handle);
    handle.promise.finally(() => inflight.delete(runId));
    res.json({ runId, userMessageId });
  });

  // SSE stream with resume. Client passes ?cursor=<lastSeenSeq> OR the
  // browser sends Last-Event-ID on auto-reconnect. Both are honored; explicit
  // cursor wins because it's what our React hook uses across full reloads.
  app.get('/runs/:runId/stream', async (req, res) => {
    const { runId } = req.params;
    const run = await getRun(runId);
    if (!run) {
      // AC6: unknown run — explicit error, not a silent empty stream.
      return res.status(404).json({ error: 'unknown_run' });
    }

    const cursorParam = req.query.cursor;
    const lastEventIdHeader = req.headers['last-event-id'];
    let cursor = 0;
    if (cursorParam !== undefined) cursor = parseInt(cursorParam, 10) || 0;
    else if (lastEventIdHeader) cursor = parseInt(lastEventIdHeader, 10) || 0;

    // AC6: cursor points past what's persisted — treat as invalid rather
    // than silently rewinding. Real system might expire old events; here we
    // keep everything but still detect ahead-of-truth cursors.
    if (cursor > run.lastSeq && run.state !== 'running') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      sseWrite(res, {
        seq: 0,
        type: 'cursor_invalid',
        payload: { reason: 'cursor_ahead_of_run', runLastSeq: run.lastSeq },
      });
      return res.end();
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // --- Replay -> live handoff ---
    // 1. Subscribe to live events into a buffer *first*, so nothing published
    //    during replay is lost.
    // 2. Replay persisted events > cursor from Mongo.
    // 3. Drain the buffer, filtering out anything <= last replayed seq to
    //    avoid duplicates when replay and live overlap.
    // 4. Then stream live events directly.
    // This ordering is the crux of AC3 (replay/live overlap).

    const liveBuffer = [];
    let handedOff = false;
    let lastSentSeq = cursor;

    const onLive = (event) => {
      if (!handedOff) {
        liveBuffer.push(event);
        return;
      }
      if (event.seq <= lastSentSeq) return; // dedup
      sseWrite(res, event);
      lastSentSeq = event.seq;
      if (event.type !== 'chunk') {
        // Terminal event delivered live — close the stream.
        res.end();
      }
    };
    const unsubscribe = bus.subscribe(runId, onLive);

    req.on('close', () => {
      unsubscribe();
    });

    try {
      const replayed = await eventsAfter(runId, cursor);
      for (const ev of replayed) {
        if (ev.seq <= lastSentSeq) continue;
        sseWrite(res, ev);
        lastSentSeq = ev.seq;
      }
      handedOff = true;
      // Drain buffered live events that landed during replay.
      const drained = liveBuffer.splice(0);
      for (const ev of drained) {
        if (ev.seq <= lastSentSeq) continue;
        sseWrite(res, ev);
        lastSentSeq = ev.seq;
        if (ev.type !== 'chunk') {
          res.end();
          return;
        }
      }

      // If the run was already terminal when we replayed, close now.
      const fresh = await getRun(runId);
      if (fresh.state !== 'running' && lastSentSeq >= fresh.lastSeq) {
        res.end();
      }
    } catch (err) {
      sseWrite(res, {
        seq: 0,
        type: 'stream_error',
        payload: { reason: err.message },
      });
      res.end();
    }
  });

  // Inspection endpoint — used by tests + demo. Returns run metadata + full
  // event log. Not something a chat client would poll; it exists so a
  // reviewer can see the durable history.
  app.get('/runs/:runId', async (req, res) => {
    const run = await getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'unknown_run' });
    const events = await eventsAfter(req.params.runId, 0);
    res.json({ run, events });
  });

  return app;
}

module.exports = { buildApp };
