// Deterministic fake token generator. Same userMessage -> same token sequence.
// No paid API. Configurable delay between tokens so tests can control pacing.

const CANNED_REPLIES = [
  'Sure, here is what I think about that. It is a considered answer that arrives one token at a time so we can watch it stream.',
  'That is a good question. Let me break it down piece by piece so you can see the streaming behaviour work end to end.',
  'Okay, streaming a response now. Each word you see arrived as its own event and was persisted before it reached your screen.',
  'Great, let me walk you through it. Every word is written to durable storage the moment it is produced so nothing is lost if the connection drops.',
  'Interesting prompt. The important thing to notice is that these words are numbered in order, and the client remembers the last number it saw.',
  'Here is my take. If you disconnect halfway through, the server will replay the missed words from the database and then continue live seamlessly.',
  'Let me answer that. Notice how the reply appears smoothly even though each word is a separate persisted event under the hood.',
  'Alright, thinking about this now. The response is being generated deterministically, which means the same question always produces the same answer for testing.',
  'Good one. What you are watching is a resumable stream, meaning even a full page refresh mid-reply would pick up exactly where it left off.',
  'Let me explain. The client tracks a cursor of the last word it received, and on reconnect asks the server for everything after that cursor.',
  'Here is what I want to say. The design keeps durable history separate from the transient connection, which is why interruptions do not corrupt the reply.',
  'Sure thing. Every terminal state, whether completed, failed, or interrupted, is final and cannot be silently changed later on.',
  'Okay so, the fun part is that the fake model here is fully deterministic, which lets the tests assert exact output without flakiness.',
];

function pickReply(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return CANNED_REPLIES[h % CANNED_REPLIES.length];
}

// Trigger a failure by including the word 'FAIL' in the user message.
// Trigger a specific token count by 'COUNT:<n>'.
function tokensFor(userMessage) {
  const countMatch = /COUNT:(\d+)/i.exec(userMessage);
  if (countMatch) {
    const n = parseInt(countMatch[1], 10);
    return Array.from({ length: n }, (_, i) => `tok${i + 1}`);
  }
  return pickReply(userMessage).split(' ');
}

// Yields tokens one at a time. Fails partway if user message contains FAIL.
async function* generate(userMessage, { delayMs = 20, signal } = {}) {
  const tokens = tokensFor(userMessage);
  const shouldFail = /FAIL/.test(userMessage);
  const failAt = shouldFail ? Math.floor(tokens.length / 2) : -1;
  for (let i = 0; i < tokens.length; i++) {
    if (signal?.aborted) return;
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    if (i === failAt) {
      throw new Error('simulated_generator_failure');
    }
    yield tokens[i] + (i < tokens.length - 1 ? ' ' : '');
  }
}

module.exports = { generate, tokensFor };
