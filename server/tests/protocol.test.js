const request = require('supertest');
const http = require('http');
const { buildApp } = require('../src/app');
const { connect, disconnect, clearDb, collectSSE, waitUntil } = require('./helpers');
const { getRun, eventsAfter } = require('../src/store');
const { Run } = require('../src/models');

// All tests use a slow generator so we can reliably interrupt mid-stream.
const GEN_DELAY = 25;

let app;
let server;
let baseUrl;

beforeAll(async () => {
  await connect();
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await disconnect();
});
beforeEach(async () => {
  await clearDb();
  app = buildApp({ generatorDelayMs: GEN_DELAY });
  if (server) await new Promise((r) => server.close(r));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

async function startRun(content) {
  const res = await request(app).post('/messages').send({ content });
  expect(res.status).toBe(200);
  return res.body.runId;
}

// Consume the SSE stream using raw http so we can abort at will.
function openStream(runId, cursor = 0) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/runs/${runId}/stream?cursor=${cursor}`, (res) => {
      resolve({ res, req });
    });
    req.on('error', reject);
  });
}

async function readEvents({ res, req }, { until, abortAfter } = {}) {
  const events = [];
  let buffer = '';
  return new Promise((resolve) => {
    res.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = {};
        for (const line of raw.split('\n')) {
          if (line.startsWith('id: ')) ev.id = parseInt(line.slice(4), 10);
          else if (line.startsWith('event: ')) ev.type = line.slice(7);
          else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
        }
        events.push(ev);
        if (abortAfter && events.length >= abortAfter) {
          req.destroy();
          resolve(events);
          return;
        }
        if (until && ev.type === until) {
          resolve(events);
          return;
        }
      }
    });
    res.on('end', () => resolve(events));
    res.on('error', () => resolve(events));
  });
}

test('AC1: ordered live stream reaches completed', async () => {
  const runId = await startRun('COUNT:12');
  const stream = await openStream(runId);
  const events = await readEvents(stream, { until: 'completed' });
  const chunks = events.filter((e) => e.type === 'chunk');
  expect(chunks.length).toBe(12);
  // Seqs are strictly monotonic starting at 1.
  chunks.forEach((c, i) => expect(c.data.seq).toBe(i + 1));
  const terminal = events[events.length - 1];
  expect(terminal.type).toBe('completed');
  const run = await getRun(runId);
  expect(run.state).toBe('completed');
});

test('AC2 + AC3: missed-event recovery with replay/live overlap and no dups', async () => {
  const runId = await startRun('COUNT:30');
  // Read first ~8 events then abort.
  const s1 = await openStream(runId);
  const partial = await readEvents(s1, { abortAfter: 8 });
  const partialChunks = partial.filter((e) => e.type === 'chunk');
  const lastSeq = partialChunks[partialChunks.length - 1].data.seq;

  // Reconnect immediately (while run is still producing) — replay + live overlap.
  const s2 = await openStream(runId, lastSeq);
  const rest = await readEvents(s2, { until: 'completed' });

  const restChunks = rest.filter((e) => e.type === 'chunk');
  // Every chunk we see now has seq > lastSeq (no duplicate of what we already had).
  restChunks.forEach((c) => expect(c.data.seq).toBeGreaterThan(lastSeq));
  // Reconstructed sequence is complete: 1..30 across both connections.
  const allSeqs = [...partialChunks.map((c) => c.data.seq), ...restChunks.map((c) => c.data.seq)];
  expect(allSeqs).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
});

test('AC4: service restart — history persists, run marked interrupted, reconnect sees interrupted', async () => {
  const runId = await startRun('COUNT:30');
  // Read a few events so the run is definitely in progress.
  const s1 = await openStream(runId);
  await readEvents(s1, { abortAfter: 3 });

  // Simulate restart: rebuild app on the SAME db, run interrupt sweep.
  await new Promise((r) => server.close(r));
  const { interruptOrphanedRuns } = require('../src/store');
  const n = await interruptOrphanedRuns();
  expect(n).toBeGreaterThanOrEqual(1);

  app = buildApp({ generatorDelayMs: GEN_DELAY });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // Durable history is inspectable.
  const inspect = await request(app).get(`/runs/${runId}`);
  expect(inspect.status).toBe(200);
  expect(inspect.body.run.state).toBe('interrupted');
  const terminals = inspect.body.events.filter((e) => e.type === 'interrupted');
  expect(terminals.length).toBe(1);

  // Reconnect from cursor 0 replays everything including terminal.
  const s2 = await openStream(runId, 0);
  const events = await readEvents(s2, { until: 'interrupted' });
  expect(events[events.length - 1].type).toBe('interrupted');
});

test('AC5: generator failure — run terminal-failed, cannot become completed', async () => {
  const runId = await startRun('please FAIL now COUNT:10');
  const s = await openStream(runId);
  const events = await readEvents(s, { until: 'failed' });
  const failed = events[events.length - 1];
  expect(failed.type).toBe('failed');
  expect(failed.data.payload.reason).toMatch(/simulated_generator_failure/);

  const run = await getRun(runId);
  expect(run.state).toBe('failed');

  // Attempt to append a completed event directly — must be rejected.
  const { appendEvent } = require('../src/store');
  await expect(appendEvent(runId, 'completed', null)).rejects.toThrow(/not running/);
  const after = await getRun(runId);
  expect(after.state).toBe('failed');
});

test('AC6: cursor ahead of a terminal run yields explicit cursor_invalid', async () => {
  const runId = await startRun('COUNT:5');
  // Let it finish.
  const s1 = await openStream(runId);
  await readEvents(s1, { until: 'completed' });
  // Cursor > lastSeq on a completed run.
  const s2 = await openStream(runId, 9999);
  const events = await readEvents(s2, {});
  expect(events.some((e) => e.type === 'cursor_invalid')).toBe(true);
});

test('AC6b: unknown runId yields 404', async () => {
  const res = await request(app).get('/runs/deadbeefdeadbeef/stream');
  expect(res.status).toBe(404);
});

test('append-event uniqueness: two concurrent appends produce distinct seqs', async () => {
  // Not a strict AC, but this is the invariant everything else rests on.
  const { createRun, appendEvent } = require('../src/store');
  const { Run, Event } = require('../src/models');
  await createRun({
    runId: 'r1',
    conversationId: 'c1',
    userMessageId: 'u1',
    userMessageContent: 'x',
  });
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => appendEvent('r1', 'chunk', { text: `t${i}` }))
  );
  const seqs = results.map((e) => e.seq).sort((a, b) => a - b);
  expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  const events = await Event.find({ runId: 'r1' }).sort({ seq: 1 }).lean();
  expect(events.length).toBe(20);
});
