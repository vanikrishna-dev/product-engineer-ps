// Deterministic fake token generator. Same userMessage -> same token sequence.
// No paid API. Configurable delay between tokens so tests can control pacing.

const CANNED_REPLIES = [
  'Sure, here is what I think about that. It is a considered answer that arrives one token at a time so we can watch it stream.',
  'That is a good question. Let me break it down piece by piece so you can see the streaming behaviour work end to end.',
  'Okay, streaming a response now. Each word you see arrived as its own event and was persisted before it reached your screen.',
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
