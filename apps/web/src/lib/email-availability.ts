'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth';

export type EmailAvailability = 'loading' | 'enabled' | 'disabled' | 'unavailable';

/** Fail closed while availability is unknown; a missing flag is not proof of delivery. */
export function useEmailAvailability() {
  const { request } = useAuth();
  const [state, setState] = useState<EmailAvailability>('loading');
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    void request<{ emailEnabled?: unknown }>('/platform', { auth: false, signal: controller.signal })
      .then(platform => {
        if (!controller.signal.aborted) {
          setState(typeof platform?.emailEnabled === 'boolean'
            ? platform.emailEnabled ? 'enabled' : 'disabled'
            : 'unavailable');
        }
      })
      .catch(() => { if (!controller.signal.aborted) setState('unavailable'); });
    return () => controller.abort();
  }, [attempt, request]);

  return { state, retry };
}
