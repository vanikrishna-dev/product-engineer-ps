import { useCallback, useEffect, useRef, useState } from 'react';

// Persist cursor across full reloads so a hard refresh mid-stream still resumes
// exactly rather than starting a new turn.
const cursorKey = (runId) => `run:${runId}:cursor`;

const RECONNECT_MAX_MS = 5000;
const RECONNECT_MAX_ATTEMPTS = 8;

export function useRun(runId) {
  const [text, setText] = useState('');
  const [state, setState] = useState('idle'); // idle|connecting|connected|reconnecting|disconnected|completed|failed|interrupted
  const [error, setError] = useState(null);
  const esRef = useRef(null);
  const cursorRef = useRef(0);
  const attemptRef = useRef(0);
  const timerRef = useRef(null);

  const disconnect = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!runId) return;
    const saved = parseInt(localStorage.getItem(cursorKey(runId)) || '0', 10);
    if (saved > cursorRef.current) cursorRef.current = saved;

    setState((s) => (s === 'idle' ? 'connecting' : 'reconnecting'));
    const url = `/api/runs/${runId}/stream?cursor=${cursorRef.current}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('chunk', (e) => {
      const data = JSON.parse(e.data);
      cursorRef.current = data.seq;
      localStorage.setItem(cursorKey(runId), String(data.seq));
      setText((t) => t + (data.payload?.text ?? ''));
      setState('connected');
      attemptRef.current = 0;
    });
    const terminal = (finalState) => (e) => {
      const data = JSON.parse(e.data);
      cursorRef.current = data.seq;
      localStorage.setItem(cursorKey(runId), String(data.seq));
      setState(finalState);
      if (finalState !== 'completed' && data.payload?.reason) {
        setError(data.payload.reason);
      }
      es.close();
      esRef.current = null;
    };
    es.addEventListener('completed', terminal('completed'));
    es.addEventListener('failed', terminal('failed'));
    es.addEventListener('interrupted', terminal('interrupted'));
    es.addEventListener('cursor_invalid', (e) => {
      setError('cursor_invalid');
      setState('failed');
      es.close();
      esRef.current = null;
    });

    es.onopen = () => setState((s) => (s === 'reconnecting' ? 'connected' : s));
    es.onerror = async () => {
      es.close();
      esRef.current = null;
      // Before retrying, ask the server if the run even exists. A 404 means
      // the runId is stale (e.g., in-memory db was reset) — no point retrying.
      try {
        const probe = await fetch(`/api/runs/${runId}`);
        if (probe.status === 404) {
          setError('run_not_found');
          setState('failed');
          return;
        }
      } catch {
        // network really is down; fall through to backoff.
      }
      if (attemptRef.current >= RECONNECT_MAX_ATTEMPTS) {
        setState('disconnected');
        return;
      }
      attemptRef.current += 1;
      const backoff = Math.min(RECONNECT_MAX_MS, 200 * 2 ** attemptRef.current);
      const jitter = Math.random() * 200;
      setState('reconnecting');
      timerRef.current = setTimeout(connect, backoff + jitter);
    };
  }, [runId]);

  useEffect(() => {
    // Reset display + cursor whenever the runId changes so a new turn starts clean.
    setText('');
    setError(null);
    cursorRef.current = 0;
    attemptRef.current = 0;
    if (!runId) {
      setState('idle');
      return;
    }
    connect();
    return disconnect;
  }, [runId, connect, disconnect]);

  return { text, state, error, disconnect, reconnect: connect };
}
