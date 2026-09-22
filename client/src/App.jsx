import React, { useState } from 'react';
import { useRun } from './useRun.js';

const stateColor = {
  idle: '#888',
  connecting: '#e0a800',
  connected: '#28a745',
  reconnecting: '#e0a800',
  disconnected: '#dc3545',
  completed: '#28a745',
  failed: '#dc3545',
  interrupted: '#dc3545',
};

function StatusPill({ state, error }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 12,
        background: stateColor[state] || '#888',
        color: 'white',
        fontSize: 12,
        fontFamily: 'monospace',
      }}
      title={error || ''}
    >
      {state}
      {error ? ` (${error})` : ''}
    </span>
  );
}

export default function App() {
  const [input, setInput] = useState('Tell me about streaming.');
  const [runId, setRunId] = useState(() => {
    // Restore in-progress runId across full reload so refresh mid-stream resumes.
    return localStorage.getItem('activeRunId') || null;
  });
  const { text, state, error, disconnect, reconnect } = useRun(runId);

  const send = async () => {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: input }),
    });
    const { runId: newRunId } = await res.json();
    localStorage.setItem('activeRunId', newRunId);
    // Wipe old cursor for the new run so we start from 0.
    setRunId(newRunId);
  };

  const clear = () => {
    if (runId) localStorage.removeItem(`run:${runId}:cursor`);
    localStorage.removeItem('activeRunId');
    setRunId(null);
  };

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', fontFamily: 'system-ui, sans-serif', padding: 16 }}>
      <h1>Resumable Conversation</h1>
      <p style={{ color: '#555' }}>
        Kill the tab or stop the server mid-stream. Reopen. The reply should pick up exactly where it left off.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={{ flex: 1, padding: 8, fontSize: 14 }}
          placeholder="Say something. Include FAIL to test failure. Include COUNT:30 for 30 tokens."
        />
        <button onClick={send} style={{ padding: '8px 16px' }}>Send</button>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <StatusPill state={state} error={error} />
        {runId ? <code style={{ fontSize: 12 }}>runId: {runId}</code> : null}
        <button onClick={disconnect} disabled={!runId} style={{ marginLeft: 'auto' }}>Force disconnect</button>
        <button onClick={reconnect} disabled={!runId}>Reconnect</button>
        <button onClick={clear} disabled={!runId}>Clear</button>
      </div>

      <div
        style={{
          minHeight: 160,
          padding: 16,
          border: '1px solid #ddd',
          borderRadius: 8,
          background: '#fafafa',
          fontFamily: 'ui-monospace, monospace',
          whiteSpace: 'pre-wrap',
        }}
      >
        {text || <span style={{ color: '#aaa' }}>Reply will stream here.</span>}
      </div>
    </div>
  );
}
