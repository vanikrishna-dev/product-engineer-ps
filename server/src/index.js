const mongoose = require('mongoose');
const { buildApp } = require('./app');
const { interruptOrphanedRuns } = require('./store');

const PORT = process.env.PORT || 4000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017/resumable-conv';

async function main() {
  await mongoose.connect(MONGO_URL);
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
