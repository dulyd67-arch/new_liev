'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Heart, LoaderCircle, RefreshCw } from 'lucide-react';
import { ApiError, useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { formatDu } from '@/lib/gifts';
import type { LikeResult, StreamLikes } from '@/lib/battles';
import styles from './live-likes.module.css';

type LikeFailure = 'network' | 'rate' | 'auth' | 'ended' | 'load';
interface Particle { id: number; drift: number; tilt: number; color: string; }
interface LikeOperation { count: number; idempotencyKey: string; }

/** Hearts animate on a tap; only a committed server response changes the counter. */
export function LiveLikeButton({ streamId, isLive, compact = false, className }: { streamId: string; isLive: boolean; compact?: boolean; className?: string }) {
  const { request, user, loading: authLoading } = useAuth(); const { pick, locale } = useLocale();
  const requestRef = useRef(request); requestRef.current = request;
  const [total, setTotal] = useState<string | null>(null);
  const [particles, setParticles] = useState<Particle[]>([]);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<LikeFailure | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [paused, setPaused] = useState(false);
  const countId = useId(); const errorId = useId();
  const nextParticle = useRef(0);
  const queue = useRef(0); const operation = useRef<LikeOperation | null>(null);
  const generation = useRef(0); const locked = useRef(false); const uncertain = useRef(false);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const flushRef = useRef<() => void>(() => undefined);
  const reloadRef = useRef<() => void>(() => undefined);
  const lastSentAt = useRef(0);
  const userId = user?.id;

  useEffect(() => {
    const current = ++generation.current;
    queue.current = 0; operation.current = null; locked.current = false; uncertain.current = false; lastSentAt.current = 0;
    setTotal(null); setParticles([]); setSending(false); setFailure(null); setQueuedCount(0); setPaused(false);
    let disposed = false; let polling = false; let pollAgain = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined; let readController: AbortController | null = null;
    const committed = (value: string) => setTotal(previous => {
      if (previous === null) return value;
      try { return BigInt(value) > BigInt(previous) ? value : previous; } catch { return previous; }
    });
    const scheduleSend = (initial = false) => {
      if (disposed || !isLive || !userId || uncertain.current || locked.current || sendTimer.current || (!queue.current && !operation.current)) return;
      sendTimer.current = setTimeout(() => { sendTimer.current = null; void flush(); }, initial ? 1500 : Math.max(0, 1500 - (Date.now() - lastSentAt.current)));
    };
    const flush = async () => {
      if (disposed || locked.current || !isLive || !userId || (!queue.current && !operation.current)) return;
      if (sendTimer.current) { clearTimeout(sendTimer.current); sendTimer.current = null; }
      if (!operation.current) {
        const count = Math.min(20, queue.current); queue.current -= count; setQueuedCount(queue.current);
        operation.current = { count, idempotencyKey: crypto.randomUUID() };
      }
      const pending = operation.current;
      locked.current = true; uncertain.current = false; setPaused(false); setSending(true); setFailure(null); lastSentAt.current = Date.now();
      const active = new AbortController(); controller.current = active;
      const timeout = setTimeout(() => active.abort(), 15_000);
      try {
        const result = await requestRef.current<LikeResult>('/streams/' + streamId + '/likes', { method: 'POST', signal: active.signal, body: JSON.stringify(pending) });
        if (disposed || current !== generation.current) return;
        committed(result.total); operation.current = null;
      } catch (cause) {
        if (disposed || current !== generation.current) return;
        const status = cause instanceof ApiError ? cause.status : null;
        if (status === 401) { setFailure('auth'); queue.current = 0; operation.current = null; setQueuedCount(0); }
        else if ([400, 403, 404, 409, 422].includes(status ?? 0)) { setFailure('ended'); queue.current = 0; operation.current = null; setQueuedCount(0); }
        else {
          // A timeout may occur after commit. Preserve both count and key for the next retry.
          uncertain.current = true; setPaused(true); setFailure(status === 429 ? 'rate' : 'network');
        }
      } finally {
        clearTimeout(timeout);
        if (!disposed && current === generation.current) { locked.current = false; setSending(false); controller.current = null; scheduleSend(); }
      }
    };
    const load = async () => {
      if (disposed) return;
      if (polling) { pollAgain = true; return; }
      if (pollTimer) clearTimeout(pollTimer);
      polling = true; readController = new AbortController();
      const timeout = setTimeout(() => readController?.abort(), 15_000);
      try {
        const result = await requestRef.current<StreamLikes>('/streams/' + streamId + '/likes', { auth: false, signal: readController.signal });
        if (!disposed && current === generation.current) { committed(result.total); setFailure(value => value === 'load' ? null : value); }
      } catch { if (!disposed && current === generation.current) setFailure(value => value || 'load'); }
      finally {
        clearTimeout(timeout); polling = false;
        if (!disposed && isLive) {
          if (pollAgain) { pollAgain = false; void load(); }
          else pollTimer = setTimeout(() => void load(), document.hidden ? 10_000 : 3_000);
        }
      }
    };
    flushRef.current = () => { if (uncertain.current) void flush(); else scheduleSend(true); };
    reloadRef.current = () => void load();
    const wake = () => {
      if (!document.hidden) void load();
      else { if (pollTimer) clearTimeout(pollTimer); if (!polling && isLive) pollTimer = setTimeout(() => void load(), 10_000); }
    };
    document.addEventListener('visibilitychange', wake); void load();
    return () => {
      disposed = true; ++generation.current; controller.current?.abort(); readController?.abort();
      if (sendTimer.current) clearTimeout(sendTimer.current); sendTimer.current = null;
      if (pollTimer) clearTimeout(pollTimer); document.removeEventListener('visibilitychange', wake);
      flushRef.current = () => undefined; reloadRef.current = () => undefined;
    };
  }, [streamId, userId, isLive]);

  function tap() {
    if (!userId || !isLive || authLoading || uncertain.current) return;
    // The server enforces 120 per user per minute. Bound the local queue too.
    if (queue.current + (operation.current?.count || 0) >= 120) { setFailure('rate'); return; }
    queue.current += 1; setQueuedCount(queue.current);
    const id = ++nextParticle.current;
    const colors = ['#ff527e', '#fb78b9', '#bd8dff', '#ff9eaf'];
    setParticles(items => [...items.slice(-17), { id, drift: ((id * 37) % 86) - 43, tilt: ((id * 13) % 40) - 20, color: colors[id % colors.length] }]);
    flushRef.current();
  }
  const counter = total === null ? '—' : formatDu(total, locale);
  const label = isLive ? pick('أرسل إعجابًا', 'Send a like') : pick('إعجابات البث', 'LIVE likes');
  const buttonClass = [className || styles.button, compact && styles.compact].filter(Boolean).join(' ');
  const messages: Record<LikeFailure, [string, string]> = {
    network: ['تعذّر تأكيد الإعجابات. أعد المحاولة لإكمالها مرة واحدة.', 'Likes could not be confirmed. Retry to complete them once.'],
    rate: ['حتى 120 إعجابًا في الدقيقة. انتظر قليلًا ثم أعد المحاولة.', 'Up to 120 likes per minute. Wait a moment, then retry.'],
    auth: ['سجّل الدخول مجددًا لإرسال الإعجابات.', 'Sign in again to send likes.'],
    ended: ['لا يمكن إرسال الإعجابات لهذا البث الآن.', 'Likes cannot be sent to this LIVE right now.'],
    load: ['تعذّر تحديث عدد الإعجابات.', 'The like count could not be refreshed.'],
  };
  return <div className={styles.root}>
    <div className={styles.particles} data-testid="live-like-particles" aria-hidden="true">{particles.map(particle => <span key={particle.id} className={styles.particle} data-testid="live-like-particle" style={{ '--drift': particle.drift + 'px', '--tilt': particle.tilt + 'deg', color: particle.color } as CSSProperties} onAnimationEnd={() => setParticles(items => items.filter(item => item.id !== particle.id))}><Heart size={23} fill="currentColor" strokeWidth={1} /></span>)}</div>
    {!userId && !authLoading && isLive ? <Link className={buttonClass} data-testid="live-like-login" href={'/login?returnTo=' + encodeURIComponent('/live/' + streamId)} aria-label={pick('سجّل الدخول للإعجاب', 'Sign in to like')}><Heart size={24} /><span id={countId} data-testid="live-like-count">{counter}</span>{!compact && <small>{pick('إعجاب', 'Likes')}</small>}</Link> : <button type="button" className={buttonClass} data-testid="live-like-button" onClick={tap} disabled={!isLive || authLoading || paused} aria-label={label} aria-describedby={failure ? errorId : countId} data-sending={sending} data-queued={queuedCount}><Heart size={24} /><span id={countId} data-testid="live-like-count">{counter}</span>{!compact && <small>{pick('إعجاب', 'Likes')}</small>}{sending && <LoaderCircle size={9} className={`${styles.sending} spin`} aria-label={pick('جارٍ تثبيت الإعجابات', 'Saving likes')} />}</button>}
    {failure && <div className={styles.error} id={errorId} data-testid="live-like-error" role="status"><span>{pick(...messages[failure])}</span>{(paused || failure === 'load') && <button type="button" data-testid="live-like-retry" disabled={sending} onClick={() => { if (paused) flushRef.current(); else reloadRef.current(); }}><RefreshCw size={11} />{pick('إعادة المحاولة', 'Retry')}</button>}{failure === 'auth' && <Link href={'/login?returnTo=' + encodeURIComponent('/live/' + streamId)}>{pick('تسجيل الدخول', 'Sign in')}</Link>}{!paused && <button className={styles.dismiss} type="button" aria-label={pick('إغلاق التنبيه', 'Dismiss notice')} onClick={() => setFailure(null)}>×</button>}</div>}
  </div>;
}

export { LiveLikeButton as LikeButton };
