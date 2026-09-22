const { generate } = require('./generator');
const { appendEvent } = require('./store');
const bus = require('./pubsub');

// Drive one run to a terminal state. Each yielded token is:
//   1. persisted as an event (assigns seq atomically)
//   2. published to live subscribers
// Terminal events ('completed' | 'failed') are also persisted and published.
// The generator itself is fire-and-forget from the request handler's POV.
async function startRun(runId, userMessage, opts = {}) {
  const controller = new AbortController();
  const promise = (async () => {
    try {
      for await (const token of generate(userMessage, {
        delayMs: opts.delayMs ?? 20,
        signal: controller.signal,
      })) {
        const event = await appendEvent(runId, 'chunk', { text: token });
        bus.publish(runId, event.toObject ? event.toObject() : event);
      }
      const done = await appendEvent(runId, 'completed', null);
      bus.publish(runId, done.toObject ? done.toObject() : done);
    } catch (err) {
      try {
        const failed = await appendEvent(runId, 'failed', {
          reason: err.message || 'unknown',
        });
        bus.publish(runId, failed.toObject ? failed.toObject() : failed);
      } catch {
        // run may already be terminal (e.g. interrupted) — nothing to do
      }
    }
  })();
  return { controller, promise };
}

module.exports = { startRun };
