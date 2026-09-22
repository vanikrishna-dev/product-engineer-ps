const mongoose = require('mongoose');
const { buildApp } = require('./app');
const { interruptOrphanedRuns } = require('./store');

const PORT = process.env.PORT || 4000;

async function resolveMongoUrl() {
  if (process.env.MONGO_URL) return process.env.MONGO_URL;
  // No external Mongo configured — spin up an in-memory one so `npm run dev`
  // works with zero setup. Data does not persist across restarts, which is
  // fine for demos. Set MONGO_URL to a real cluster for persistence.
  const { MongoMemoryServer } = require('mongodb-memory-server');
  const mem = await MongoMemoryServer.create();
  const url = mem.getUri();
  console.log(`(no MONGO_URL set — using in-memory Mongo at ${url})`);
  // Keep a reference so it isn't garbage-collected while the server runs.
  global.__memoryMongo = mem;
  return url;
}

async function main() {
  const url = await resolveMongoUrl();
  await mongoose.connect(url);
  // On startup, mark any run stuck in 'running' as interrupted.
  // Their generators died with the previous process — persisted history
  // remains intact, and clients reconnecting will see the interrupted event.
  const n = await interruptOrphanedRuns();
  if (n > 0) console.log(`marked ${n} orphaned run(s) as interrupted`);

  const app = buildApp();
  app.listen(PORT, () => {
    console.log(`server listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
