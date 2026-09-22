const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongod;

async function connect() {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
}

async function disconnect() {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
}

async function clearDb() {
  const collections = mongoose.connection.collections;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
}

// Consume an SSE stream from a supertest response. Returns array of parsed
// events. Resolves when the response ends OR after `until` events are seen.
function collectSSE(res, { until } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const lines = raw.split('\n');
        const ev = {};
        for (const line of lines) {
          if (line.startsWith('id: ')) ev.id = parseInt(line.slice(4), 10);
          else if (line.startsWith('event: ')) ev.type = line.slice(7);
          else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
        }
        events.push(ev);
        if (until && events.length >= until) {
          res.destroy();
          resolve(events);
          return;
        }
      }
    });
    res.on('end', () => resolve(events));
    res.on('error', (e) => {
      // supertest destroys the socket; treat as normal end.
      resolve(events);
    });
  });
}

// Wait until predicate returns truthy or timeout. Poll-free waits are done via
// event subscription in tests, but this is useful for eventual-state checks.
async function waitUntil(fn, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitUntil timed out');
}

module.exports = { connect, disconnect, clearDb, collectSSE, waitUntil };
