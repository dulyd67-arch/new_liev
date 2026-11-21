'use client';

import { createPortal } from 'react-dom';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Clock3, Flag, LoaderCircle, RefreshCw, Swords, Trophy, Users, X } from 'lucide-react';
import { ApiError, useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { formatDu } from '@/lib/gifts';
import { battleHostPercent, type BattleInvitations, type BattleState, type BattleView } from '@/lib/battles';
import type { LiveStream } from '@/lib/streams';
import styles from './pk.module.css';

/** One abortable polling loop per stream. Changing locale or auth callbacks does not restart it. */
export function useBattle(streamId: string | null, active = true) {
  const { request } = useAuth();
  const requestRef = useRef(request); requestRef.current = request;
  const [battle, setBattle] = useState<BattleView | null>(null);
  const [serverNow, setServerNow] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    setBattle(null); setServerNow(null); setError(null); setLoading(Boolean(streamId && active));
    if (!streamId || !active) { refreshRef.current = () => undefined; return; }
    let disposed = false; let pending = false; let again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const schedule = () => { if (!disposed) timer = setTimeout(() => void load(), document.hidden ? 10_000 : 3_000); };
    const load = async () => {
      if (disposed) return;
      if (pending) { again = true; return; }
      if (timer) clearTimeout(timer);
      pending = true; controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15_000);
      try {
        const result = await requestRef.current<BattleState>('/streams/' + streamId + '/battle', { auth: false, signal: controller.signal });
        if (!disposed) { setBattle(result.battle); setServerNow(result.serverNow); setError(null); }
      } catch (cause) { if (!disposed) setError(cause); }
      finally {
        clearTimeout(timeout); pending = false;
        if (!disposed) { setLoading(false); if (again) { again = false; void load(); } else schedule(); }
      }
    };
    const wake = () => {
      if (!document.hidden) void load();
      else { if (timer) clearTimeout(timer); if (!pending) schedule(); }
    };
    const gift = (event: Event) => { if ((event as CustomEvent<{ streamId: string }>).detail?.streamId === streamId) void load(); };
    refreshRef.current = () => void load();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('livestar:gift-sent', gift);
    void load();
    return () => {
      disposed = true; controller?.abort(); if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake); window.removeEventListener('livestar:gift-sent', gift);
      refreshRef.current = () => undefined;
    };
  }, [streamId, active]);
  return { battle, serverNow, loading, error, refresh };
}

function useServerClock(serverNow: string | null | undefined) {
  const [now, setNow] = useState(() => serverNow ? Date.parse(serverNow) : Date.now());
  useEffect(() => {
    const base = serverNow ? Date.parse(serverNow) : Date.now(); const received = performance.now();
    const update = () => setNow(base + performance.now() - received);
    update(); const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [serverNow]);
  return now;
}

function timeLeft(end: string | null, now: number) {
  const seconds = end ? Math.max(0, Math.ceil((Date.parse(end) - now) / 1000)) : 0;
  return { seconds, label: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` };
}

export function PkScoreboard({ battle, serverNow, streamId, className }: { battle: BattleView | null; serverNow?: string | null; streamId?: string; className?: string }) {
  const { pick, locale } = useLocale();
  const now = useServerClock(serverNow || battle?.serverNow);
  if (!battle || !['ACTIVE', 'FINISHED'].includes(battle.status)) return null;
  const clock = timeLeft(battle.endsAt, now);
  const finished = battle.status === 'FINISHED';
  const winner = battle.winnerStreamId === battle.host.streamId ? battle.host : battle.winnerStreamId === battle.guest.streamId ? battle.guest : null;
  const tied = finished && battle.finishReason === 'COMPLETED' && battle.hostScore === battle.guestScore;
  const left = battleHostPercent(battle);
  return <section className={[styles.scoreboard, className].filter(Boolean).join(' ')} data-testid="pk-scoreboard" data-battle-id={battle.id} data-status={battle.status} aria-label={pick('نتيجة جولة PK', 'PK round score')}>
    <div className={styles.roundHeader}><span><Swords size={13} />{pick('تحدي PK', 'PK BATTLE')}</span><strong className={clock.seconds <= 30 && !finished ? styles.urgent : ''} data-testid="pk-timer"><Clock3 size={12} /><bdi>{finished ? pick('انتهت', 'FINAL') : clock.label}</bdi></strong><span>{pick('هدايا DU', 'DU GIFTS')}</span></div>
    <div className={styles.scoreNames} dir="ltr"><div className={styles.hostName} data-own={battle.host.streamId === streamId}><span dir="auto">{battle.host.displayName}</span><strong data-testid="pk-host-score">{formatDu(battle.hostScore, locale)}</strong></div><b className={styles.vs}>VS</b><div className={styles.guestName} data-own={battle.guest.streamId === streamId}><span dir="auto">{battle.guest.displayName}</span><strong data-testid="pk-guest-score">{formatDu(battle.guestScore, locale)}</strong></div></div>
    <div className={styles.scoreTrack} dir="ltr" aria-hidden="true"><span style={{ width: `${left}%` }} /><i><Swords size={13} /></i><span style={{ width: `${100 - left}%` }} /></div>
    {finished ? <p className={styles.result} data-testid="pk-result"><Trophy size={13} />{winner ? <>{winner.displayName}{pick(' يفوز بالجولة', ' wins the round')}</> : tied ? pick('تعادل', 'It’s a tie') : pick('انتهت الجولة دون فائز', 'Round ended without a winner')}{battle.finishReason && battle.finishReason !== 'COMPLETED' && <small>{pick('انتهت الجولة مبكرًا', 'Round ended early')}</small>}</p> : clock.seconds === 0 ? <p className={styles.settling} role="status">{pick('جارٍ تثبيت نتيجة الجولة…', 'Confirming the final result…')}</p> : null}
  </section>;
}

type Action = 'accept' | 'decline' | 'cancel' | 'leave';
type Failure = 'auth' | 'forbidden' | 'unavailable' | 'rate' | 'network';
function failureKind(cause: unknown): Failure {
  if (!(cause instanceof ApiError)) return 'network';
  if (cause.status === 401) return 'auth';
  if (cause.status === 403) return 'forbidden';
  if (cause.status === 429) return 'rate';
  if ([400, 404, 409, 422].includes(cause.status)) return 'unavailable';
  return 'network';
}

export function PkHostControls({ streamId, isLive, battle, serverNow, onChange, triggerClassName }: { streamId: string; isLive: boolean; battle: BattleView | null; serverNow?: string | null; onChange: () => void; triggerClassName?: string }) {
  const { request, user } = useAuth(); const { pick, locale } = useLocale();
  const requestRef = useRef(request); requestRef.current = request;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Element | null>(null);
  const [candidates, setCandidates] = useState<LiveStream[]>([]);
  const [invitations, setInvitations] = useState<BattleView[]>([]);
  const [invitationNow, setInvitationNow] = useState<string | null>(null);
  const [invitationsError, setInvitationsError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId(); const noteId = useId();
  const submitLock = useRef(false); const generation = useRef(0);
  const inviteOperation = useRef<{ opponentStreamId: string; idempotencyKey: string } | null>(null);
  const activeMutation = useRef<AbortController | null>(null);
  const userId = user?.id;
  const now = useServerClock(serverNow || invitationNow || battle?.serverNow);
  const occupied = battle?.status === 'ACTIVE' || (battle?.status === 'INVITED' && Date.parse(battle.invitationExpiresAt) > now);
  const incoming = [...new Map([...(battle?.status === 'INVITED' ? [battle] : []), ...invitations].map(item => [item.id, item])).values()].filter(item => item.guest.streamId === streamId && item.inviterId !== userId && item.status === 'INVITED' && Date.parse(item.invitationExpiresAt) > now);
  const outgoing = battle?.status === 'INVITED' && battle.inviterId === userId && Date.parse(battle.invitationExpiresAt) > now ? battle : null;
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const update = () => setTarget(document.fullscreenElement || document.body);
    update(); document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  useEffect(() => {
    ++generation.current; setCandidates([]); setInvitations([]); setInvitationsError(false); setBusy(null); setError(null); setSuccess(null); setUncertain(false); setConfirmLeave(false);
    submitLock.current = false; inviteOperation.current = null; activeMutation.current?.abort();
    return () => { ++generation.current; activeMutation.current?.abort(); };
  }, [streamId, userId]);

  useEffect(() => {
    if (!isLive || !userId) { setInvitations([]); return; }
    let disposed = false; let pending = false; let timer: ReturnType<typeof setTimeout> | undefined; let controller: AbortController | null = null;
    const load = async () => {
      if (disposed || pending) return;
      if (timer) clearTimeout(timer); pending = true; controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15_000);
      try {
        const data = await requestRef.current<BattleInvitations>('/battles/invitations', { signal: controller.signal });
        if (!disposed) { setInvitations(data.items); setInvitationNow(data.serverNow); setInvitationsError(false); }
      } catch { if (!disposed) setInvitationsError(true); }
      finally { clearTimeout(timeout); pending = false; if (!disposed) timer = setTimeout(() => void load(), document.hidden ? 10_000 : 3_000); }
    };
    const wake = () => {
      if (!document.hidden) void load();
      else { if (timer) clearTimeout(timer); if (!pending) timer = setTimeout(() => void load(), 10_000); }
    };
    document.addEventListener('visibilitychange', wake); void load();
    return () => { disposed = true; controller?.abort(); if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', wake); };
  }, [isLive, userId, streamId, reload]);

  useEffect(() => {
    if (!open || !target) return;
    const element = dialog.current; if (!element) return;
    const previous = document.activeElement as HTMLElement | null; const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (!element.open) element.showModal();
    element.querySelector<HTMLElement>('button')?.focus();
    return () => { if (element.open) element.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, [open, target]);

  useEffect(() => {
    if (!open || !isLive || !userId) return;
    let disposed = false; const current = generation.current; const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000); setLoading(true); setError(null);
    void requestRef.current<{ items: LiveStream[] }>('/battles/candidates', { signal: controller.signal }).then(data => {
      if (!disposed && generation.current === current) setCandidates(data.items.filter(item => item.id !== streamId && item.creator.id !== userId && item.status === 'LIVE' && item.publisherConnected));
    }).catch(cause => { if (!disposed && generation.current === current) setError(failureKind(cause)); })
      .finally(() => { clearTimeout(timeout); if (!disposed && generation.current === current) setLoading(false); });
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [open, isLive, userId, streamId, reload]);

  async function mutate(action: Action, item: BattleView) {
    if (submitLock.current || !isLive || !userId) return;
    submitLock.current = true; setBusy(action + item.id); setError(null); setSuccess(null);
    const current = generation.current; const controller = new AbortController(); activeMutation.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      await requestRef.current<BattleState>('/battles/' + item.id + '/' + action, { method: 'POST', body: '{}', signal: controller.signal });
      if (current !== generation.current) return;
      setSuccess(action); setConfirmLeave(false); setInvitations(items => items.filter(invite => invite.id !== item.id)); setReload(value => value + 1); changeRef.current();
      if (action === 'accept') setOpen(false);
    } catch (cause) { if (current === generation.current) { setError(failureKind(cause)); changeRef.current(); } }
    finally { clearTimeout(timeout); if (current === generation.current) { submitLock.current = false; setBusy(null); activeMutation.current = null; } }
  }

  async function invite(opponentStreamId: string) {
    if (submitLock.current || !isLive || !userId || (occupied && !uncertain)) return;
    submitLock.current = true; setBusy(opponentStreamId); setError(null); setSuccess(null);
    inviteOperation.current ??= { opponentStreamId, idempotencyKey: crypto.randomUUID() };
    const operation = inviteOperation.current; const current = generation.current;
    const controller = new AbortController(); activeMutation.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      await requestRef.current<BattleState>('/streams/' + streamId + '/battles', { method: 'POST', signal: controller.signal, body: JSON.stringify(operation) });
      if (current !== generation.current) return;
      inviteOperation.current = null; setUncertain(false); setSuccess('invite'); changeRef.current();
    } catch (cause) {
      if (current !== generation.current) return;
      const kind = failureKind(cause); setError(kind);
      if (kind === 'network') setUncertain(true); else { setUncertain(false); inviteOperation.current = null; }
      changeRef.current();
    } finally { clearTimeout(timeout); if (current === generation.current) { submitLock.current = false; setBusy(null); activeMutation.current = null; } }
  }

  const messages: Record<Failure, [string, string]> = {
    auth: ['سجّل الدخول مجددًا لإدارة التحدي.', 'Sign in again to manage this challenge.'],
    forbidden: ['هذا التحدي غير متاح بين هذين الحسابين.', 'This challenge is unavailable between these accounts.'],
    unavailable: ['تغيّرت حالة التحدي أو البث. حدّث القائمة وحاول مجددًا.', 'The challenge or LIVE changed. Refresh the list and try again.'],
    rate: ['انتظر قليلًا قبل المحاولة التالية.', 'Wait a moment before trying again.'],
    network: ['تعذّر تأكيد الطلب. تحقق من الاتصال وأعد المحاولة.', 'We could not confirm the request. Check your connection and retry.'],
  };
  const succeeded = success === 'invite' && (!battle || outgoing) ? pick('أُرسلت الدعوة. تبدأ الجولة عند قبول المضيف الآخر.', 'Invite sent. The round starts when the other host accepts.') : success === 'decline' ? pick('رُفضت الدعوة.', 'Invite declined.') : success === 'cancel' ? pick('أُلغيت الدعوة.', 'Invite canceled.') : success === 'leave' ? pick('غادرت جولة PK. بثك مستمر.', 'You left the PK round. Your LIVE continues.') : null;
  const modal = open && target ? <dialog ref={dialog} className={styles.dialog} data-testid="pk-dialog" aria-labelledby={titleId} aria-describedby={noteId} onCancel={event => { event.preventDefault(); close(); }} onClose={close} onClick={event => { if (event.target !== event.currentTarget) return; const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); }}>
    <header className={styles.dialogHeader}><div><span><Swords size={12} />LIVE TOGETHER</span><h2 id={titleId}>{pick('تحدي PK', 'Start a PK battle')}</h2></div><button type="button" onClick={close} className={styles.close} aria-label={pick('إغلاق تحدي PK', 'Close PK battle')}><X size={21} /></button></header>
    <p className={styles.note} id={noteId}>{pick('مضيفان، شاشة مقسومة، وجولة من 5 دقائق. هدايا DU المجانية خلال الجولة تحدد النتيجة.', 'Two hosts, a split screen, and a 5-minute round. Free DU gifts received during the round decide the score.')}</p>
    {!isLive && <p className={styles.notice}>{pick('ابدأ بثًا مباشرًا أولًا لدعوة مضيف آخر.', 'Go LIVE before inviting another host.')}</p>}
    {invitationsError && <p className={styles.notice} role="status">{pick('تعذّر تحديث الدعوات الواردة. قد تكون القائمة غير محدثة.', 'Incoming invites could not be refreshed. This list may be out of date.')}<button type="button" className={styles.secondary} onClick={() => setReload(value => value + 1)}><RefreshCw size={12} />{pick('تحديث', 'Refresh')}</button></p>}
    {battle && (battle.status === 'CANCELED' || (battle.status === 'INVITED' && !occupied)) && <p className={styles.notice} data-testid="pk-closed" role="status">{battle.finishReason === 'INVITATION_EXPIRED' || battle.status === 'INVITED' ? pick('انتهت صلاحية دعوة PK. يمكنك إرسال دعوة جديدة.', 'This PK invite expired. You can send a new invite.') : pick('أُغلقت دعوة PK. يمكنك دعوة مضيف آخر.', 'This PK invite was closed. You can invite another host.')}</p>}
    {battle?.status === 'DECLINED' && <p className={styles.notice} data-testid="pk-closed" role="status">{pick('رُفضت دعوة PK. يمكنك دعوة مضيف آخر.', 'The PK invite was declined. You can invite another host.')}</p>}
    {battle?.status === 'ACTIVE' && <div className={styles.activeRound}><div><Swords size={22} /><strong>{pick('الجولة مباشرة الآن', 'Your round is LIVE')}</strong><span><bdi>{timeLeft(battle.endsAt, now).label}</bdi>{pick(' متبقية', ' remaining')}</span></div><p>{pick('المغادرة تنهي الجولة لكلا المضيفين. سيستمر بثك المباشر.', 'Leaving ends the round for both hosts. Your own LIVE continues.')}</p>{confirmLeave ? <div className={styles.confirmRow}><button type="button" className={styles.danger} data-testid="pk-confirm-leave" disabled={Boolean(busy)} onClick={() => void mutate('leave', battle)}>{busy ? <LoaderCircle size={15} className="spin" /> : <Flag size={15} />}{pick('إنهاء الجولة والمغادرة', 'End round and leave')}</button><button type="button" className={styles.secondary} disabled={Boolean(busy)} onClick={() => setConfirmLeave(false)}>{pick('البقاء', 'Stay')}</button></div> : <button type="button" className={styles.secondary} data-testid="pk-leave" onClick={() => setConfirmLeave(true)}><Flag size={15} />{pick('مغادرة PK', 'Leave PK')}</button>}</div>}
    {incoming.length > 0 && <section className={styles.incoming}><h3>{pick('دعوات واردة', 'Incoming challenges')}<b>{formatDu(String(incoming.length), locale)}</b></h3>{incoming.map(item => <div key={item.id} className={styles.invitation} data-testid={'pk-incoming-' + item.id}><div className={styles.person}><span>{item.host.displayName.slice(0, 1)}</span><div><strong>{item.host.displayName}</strong><small>{item.host.title}</small><em><Clock3 size={11} /><bdi>{timeLeft(item.invitationExpiresAt, now).label}</bdi>{pick(' للرد', ' to respond')}</em></div></div><div className={styles.inviteActions}><button type="button" className={styles.primary} data-testid={'pk-accept-' + item.id} disabled={Boolean(busy)} onClick={() => void mutate('accept', item)}>{busy === 'accept' + item.id ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{pick('قبول', 'Accept')}</button><button type="button" className={styles.secondary} data-testid={'pk-decline-' + item.id} disabled={Boolean(busy)} onClick={() => void mutate('decline', item)}>{pick('رفض', 'Decline')}</button></div></div>)}</section>}
    {outgoing && <div className={styles.waiting}><span className={styles.waitingIcon}><Swords size={24} /></span><strong>{pick('بانتظار ', 'Waiting for ')}{outgoing.guest.displayName}</strong><p>{pick('ستبدأ الجولة بعد القبول. تنتهي صلاحية الدعوة خلال ', 'The round begins after acceptance. Invite expires in ')}<bdi>{timeLeft(outgoing.invitationExpiresAt, now).label}</bdi></p><button type="button" className={styles.secondary} data-testid="pk-cancel" disabled={Boolean(busy)} onClick={() => void mutate('cancel', outgoing)}>{busy ? <LoaderCircle size={15} className="spin" /> : <X size={15} />}{pick('إلغاء الدعوة', 'Cancel invite')}</button></div>}
    {error && <p className={styles.error} data-testid="pk-error" role="alert">{pick(...messages[error])}{uncertain && inviteOperation.current && <button type="button" className={styles.secondary} disabled={Boolean(busy)} data-testid="pk-retry-invite" onClick={() => void invite(inviteOperation.current!.opponentStreamId)}><RefreshCw size={13} />{pick('إعادة الدعوة نفسها', 'Retry the same invite')}</button>}</p>}
    {succeeded && <p className={styles.success} data-testid="pk-success" role="status"><Check size={15} />{succeeded}</p>}
    {!occupied && isLive && <section className={styles.candidates}><div className={styles.listHeader}><h3><Users size={15} />{pick('مضيفون مباشرون', 'Hosts LIVE now')}</h3><button type="button" className={styles.refresh} data-testid="pk-refresh-hosts" disabled={loading || Boolean(busy)} onClick={() => { setReload(value => value + 1); changeRef.current(); }} aria-label={pick('تحديث المضيفين', 'Refresh hosts')}><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div>{loading ? <p className={styles.loading} role="status"><LoaderCircle size={20} className="spin" />{pick('جارٍ البحث عن مضيفين…', 'Finding LIVE hosts…')}</p> : candidates.length ? candidates.map(item => <div className={styles.candidate} key={item.id}><div className={styles.person}><span>{item.creator.displayName.slice(0, 1)}</span><div><strong>{item.creator.displayName}<b className={styles.liveBadge}>LIVE</b></strong><small>{item.title}</small><em>{item.viewerCount !== null && <><Users size={11} />{formatDu(String(item.viewerCount), locale)}</>}</em></div></div><button type="button" className={styles.inviteButton} data-testid={'pk-invite-' + item.id} disabled={Boolean(busy) || uncertain} onClick={() => void invite(item.id)}>{busy === item.id ? <LoaderCircle size={14} className="spin" /> : <Swords size={14} />}{pick('دعوة', 'Invite')}</button></div>) : <p className={styles.empty}>{pick('لا يوجد مضيف متاح الآن. اطلب من صديق بدء LIVE ثم حدّث القائمة.', 'No hosts are available right now. Ask a friend to go LIVE, then refresh.')}</p>}</section>}
    <p className={styles.disclosure}>{pick('DU عملات ترويجية مجانية بلا قيمة نقدية. الإعجابات لا تُحتسب في نتيجة PK.', 'DU are free promotional coins with no cash value. Likes do not count toward the PK score.')}</p>
  </dialog> : null;
  return <><button type="button" className={triggerClassName || styles.trigger} data-testid="pk-trigger" disabled={!isLive} aria-haspopup="dialog" aria-expanded={open} onClick={() => { setOpen(true); setConfirmLeave(false); }}><Swords size={24} /><span>{incoming.length ? pick('دعوة PK', 'PK invite') : 'PK'}</span>{incoming.length > 0 && <b className={styles.badge}>{incoming.length}</b>}</button>{modal && target && createPortal(modal, target)}</>;
}
