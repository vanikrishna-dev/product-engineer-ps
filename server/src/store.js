const { Run, Event } = require('./models');

// Append one event to a run. Atomically:
//   1. increment run.lastSeq (only while state === 'running')
//   2. write the event with the new seq
// If the run is already terminal, this throws — a terminal run cannot grow.
async function appendEvent(runId, type, payload) {
  const isTerminalType = type !== 'chunk';
  const update = { $inc: { lastSeq: 1 } };
  if (isTerminalType) {
    update.$set = {
      state: type,
      terminalAt: new Date(),
      ...(payload && payload.reason ? { failureReason: payload.reason } : {}),
    };
  }
  // Only advance if run is still running. This is the core guard: once terminal,
  // no further events can be appended (prevents "failed later became completed").
  const run = await Run.findOneAndUpdate(
    { _id: runId, state: 'running' },
    update,
    { new: true }
  );
  if (!run) {
    throw new Error(`run ${runId} is not running (already terminal or missing)`);
  }
  const event = await Event.create({
    runId,
    seq: run.lastSeq,
    type,
    payload,
  });
  return event;
}

// Fetch events strictly after a cursor. Used by both replay and by clients
// polling for missed events.
async function eventsAfter(runId, afterSeq) {
  return Event.find({ runId, seq: { $gt: afterSeq } })
    .sort({ seq: 1 })
    .lean();
}

async function getRun(runId) {
  return Run.findById(runId).lean();
}

async function createRun({ runId, conversationId, userMessageId, userMessageContent }) {
  return Run.create({
    _id: runId,
    conversationId,
    userMessageId,
    userMessageContent,
    state: 'running',
    lastSeq: 0,
  });
}

// Mark every still-running run as interrupted. Called at server startup so that
// runs whose generator was killed by the crash have honest terminal state.
// A separate 'interrupted' event is appended so streaming clients observe it.
async function interruptOrphanedRuns() {
  const orphans = await Run.find({ state: 'running' }).lean();
  for (const run of orphans) {
    try {
      await appendEvent(run._id, 'interrupted', { reason: 'server_restart' });
    } catch {
      // race with another instance — ignore, terminal already set
    }
  }
  return orphans.length;
}

module.exports = {
  appendEvent,
  eventsAfter,
  getRun,
  createRun,
  interruptOrphanedRuns,
};
