// In-process pub/sub for live event fanout. Subscribers are keyed by runId.
// This is transient — restart-safe delivery relies on the Mongo event log,
// not this map. Pubsub only exists to avoid Mongo tailing on the hot path.

const { EventEmitter } = require('events');

class RunBus {
  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
  }

  publish(runId, event) {
    this.emitter.emit(runId, event);
  }

  subscribe(runId, handler) {
    this.emitter.on(runId, handler);
    return () => this.emitter.off(runId, handler);
  }
}

module.exports = new RunBus();
