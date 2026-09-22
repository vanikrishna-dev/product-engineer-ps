// Verification benchmark. Requirements from problem statement:
//   1. Generate at least 30 ordered text events for one run
//   2. Interrupt and reconnect the client at least once while generation is active
//   3. Reconstruct expected final response with zero missing and zero duplicate events
//   4. Report observed event count and final run state
//
// Runs entirely in-process against an in-memory Mongo. No external services.

const http = require('http');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const { buildApp } = require('./app');
const { getRun } = require('./store');

function openStream(baseUrl, runId, cursor) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/runs/${runId}/stream?cursor=${cursor}`, (res) => {
      resolve({ res, req });
    });
    req.on('error', reject);
  });
}

function readEvents({ res, req }, { abortAfter, untilTerminal } = {}) {
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
          return resolve(events);
        }
        if (untilTerminal && ['completed', 'failed', 'interrupted'].includes(ev.type)) {
          return resolve(events);
        }
      }
    });
    res.on('end', () => resolve(events));
    res.on('error', () => resolve(events));
  });
}

async function main() {
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  const app = buildApp({ generatorDelayMs: 20 });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const TOKEN_COUNT = 40;
  const { body } = await request(app).post('/messages').send({ content: `COUNT:${TOKEN_COUNT}` });
  const runId = body.runId;
  console.log(`started run ${runId}, expecting ${TOKEN_COUNT} chunks`);

  // First leg: read ~10 events, then hard-disconnect.
  const s1 = await openStream(baseUrl, runId, 0);
  const partial = await readEvents(s1, { abortAfter: 10 });
  const partialChunks = partial.filter((e) => e.type === 'chunk');
  const lastSeq = partialChunks[partialChunks.length - 1].data.seq;
  console.log(`leg 1: read ${partialChunks.length} chunks, last seq = ${lastSeq}, disconnected`);

  // Second leg: reconnect at cursor and drain until terminal.
  const s2 = await openStream(baseUrl, runId, lastSeq);
  const rest = await readEvents(s2, { untilTerminal: true });
  const restChunks = rest.filter((e) => e.type === 'chunk');
  console.log(`leg 2: read ${restChunks.length} chunks after resume`);

  const allSeqs = [...partialChunks.map((c) => c.data.seq), ...restChunks.map((c) => c.data.seq)];
  const expected = Array.from({ length: TOKEN_COUNT }, (_, i) => i + 1);

  const missing = expected.filter((s) => !allSeqs.includes(s));
  const dupes = allSeqs.filter((s, i) => allSeqs.indexOf(s) !== i);

  const run = await getRun(runId);
  const terminal = rest[rest.length - 1];

  const report = {
    runId,
    expectedEvents: TOKEN_COUNT,
    observedEvents: allSeqs.length,
    missing,
    duplicates: dupes,
    finalRunState: run.state,
    terminalEventType: terminal?.type,
    reconnections: 1,
  };
  console.log('\n=== BENCHMARK REPORT ===');
  console.log(JSON.stringify(report, null, 2));

  const ok =
    missing.length === 0 &&
    dupes.length === 0 &&
    allSeqs.length === TOKEN_COUNT &&
    run.state === 'completed';

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mongod.stop();

  if (!ok) {
    console.error('\nFAIL');
    process.exit(1);
  }
  console.log('\nPASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
