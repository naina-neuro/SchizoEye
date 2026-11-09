import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchSessions } from '../api/sessions.ts';
import type { Session } from '../types/session.ts';

/** Loads GET /sessions on mount and on reload(). Stale responses (e.g. React StrictMode's double effect) are ignored. */
export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    const id = ++latest.current;
    setLoading(true);
    try {
      const rows = await fetchSessions();
      if (id !== latest.current) return;
      setSessions(rows);
      setError(null);
    } catch (e) {
      if (id !== latest.current) return;
      console.error('[Dashboard] Could not load sessions:', e);
      setSessions([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  return { sessions, loading, error, reload };
}
