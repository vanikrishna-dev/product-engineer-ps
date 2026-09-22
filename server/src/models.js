const mongoose = require('mongoose');

// A Run is one generated reply for one user message.
// state transitions: running -> completed | failed | interrupted (terminal)
// Once terminal, state cannot change (enforced by conditional updates in store.js).
const RunSchema = new mongoose.Schema(
  {
    _id: { type: String }, // runId (string uuid-ish)
    conversationId: { type: String, required: true, index: true },
    userMessageId: { type: String, required: true },
    userMessageContent: { type: String, required: true },
    state: {
      type: String,
      enum: ['running', 'completed', 'failed', 'interrupted'],
      default: 'running',
      index: true,
    },
    lastSeq: { type: Number, default: 0 }, // last assigned event seq
    failureReason: { type: String, default: null },
    createdAt: { type: Date, default: () => new Date() },
    terminalAt: { type: Date, default: null },
  },
  { versionKey: false }
);

// Event is an append-only entry in the run's ordered log.
// seq is monotonically assigned per run by an atomic increment on Run.lastSeq.
// type: 'chunk' carries a token; 'completed'/'failed'/'interrupted' are terminal markers
// persisted as events so the client sees the same terminal transition on replay and live.
const EventSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, index: true },
    seq: { type: Number, required: true },
    type: {
      type: String,
      enum: ['chunk', 'completed', 'failed', 'interrupted'],
      required: true,
    },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false }
);

// Unique (runId, seq) guarantees no two events share a position — even under a race.
EventSchema.index({ runId: 1, seq: 1 }, { unique: true });

const Run = mongoose.model('Run', RunSchema);
const Event = mongoose.model('Event', EventSchema);

module.exports = { Run, Event };
