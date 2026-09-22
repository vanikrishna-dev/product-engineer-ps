import React, { useState } from 'react';
import { useRun } from './useRun.js';

const stateColor = {
  idle: '#5a5f6a',
  connecting: '#d4a017',
  connected: '#2ea043',
  reconnecting: '#d4a017',
  disconnected: '#f85149',
  completed: '#2ea043',
  failed: '#f85149',
  interrupted: '#f85149',
};

const surface = '#161a22';
const border = '#262c36';
const textMuted = '#8b95a5';

function StatusPill({ state, error }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 12px',
        borderRadius: 14,
        background: stateColor[state] || '#5a5f6a',
        color: 'white',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: 0.3,
        fontFamily: "'Space Mono', ui-monospace, monospace",
      }}
      title={error || ''}
    >
      {state}
      {error ? ` (${error})` : ''}
    </span>
  );
}

const btnStyle = {
  padding: '8px 14px',
  background: '#1f2530',
  color: '#e6e8ee',
  border: `1px solid ${border}`,
  borderRadius: 6,
  fontSize: 13,
  fontFamily: 'inherit',
  cursor: 'pointer',
};

const primaryBtnStyle = {
  ...btnStyle,
  background: '#2ea043',
  border: '1px solid #2ea043',
  fontWeight: 600,
};

export default function App() {
  const [input, setInput] = useState('Tell me about streaming.');
  const [runId, setRunId] = useState(() => localStorage.getItem('activeRunId') || null);
  const { text, state, error, disconnect, reconnect } = useRun(runId);

  const send = async () => {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: input }),
    });
    const { runId: newRunId } = await res.json();
    localStorage.setItem('activeRunId', newRunId);
    setRunId(newRunId);
  };

  const clear = () => {
    if (runId) localStorage.removeItem(`run:${runId}:cursor`);
    localStorage.removeItem('activeRunId');
    setRunId(null);
  };

  return (
    <div style={{ maxWidth: 760, margin: '40px auto', padding: 20 }}>
      <h1 style={{ margin: 0, fontSize: 32, letterSpacing: -0.5 }}>Resumable Conversation</h1>
      <p style={{ color: textMuted, marginTop: 8, lineHeight: 1.5 }}>
        Kill the tab or stop the server mid-stream. Reopen. The reply should pick up exactly where it left off.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 20 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          style={{
            flex: 1,
            padding: '10px 12px',
            fontSize: 14,
            background: surface,
            color: '#e6e8ee',
            border: `1px solid ${border}`,
            borderRadius: 6,
            fontFamily: 'inherit',
            outline: 'none',
          }}
          placeholder="Include FAIL to trigger failure. Include COUNT:30 for 30 tokens."
        />
        <button onClick={send} style={primaryBtnStyle}>Send</button>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '14px 0' }}>
        <StatusPill state={state} error={error} />
        {runId ? (
          <code style={{ fontSize: 12, color: textMuted, fontFamily: "'Space Mono', monospace" }}>
            runId: {runId}
          </code>
        ) : null}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={disconnect} disabled={!runId} style={btnStyle}>Force disconnect</button>
          <button onClick={reconnect} disabled={!runId} style={btnStyle}>Reconnect</button>
          <button onClick={clear} disabled={!runId} style={btnStyle}>Clear</button>
        </div>
      </div>

      <div
        style={{
          minHeight: 200,
          padding: 18,
          border: `1px solid ${border}`,
          borderRadius: 8,
          background: surface,
          color: '#e6e8ee',
          fontFamily: "'Space Mono', ui-monospace, monospace",
          fontSize: 14,
          lineHeight: 1.7,
          whiteSpace: 'pre-wrap',
        }}
      >
        {text || <span style={{ color: textMuted }}>Reply will stream here.</span>}
      </div>
    </div>
  );
}
