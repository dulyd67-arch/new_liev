'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, Flag, Globe2, LoaderCircle, Maximize, MessageCircle, MoreHorizontal, Radio, RefreshCw, Send, Share2, ShieldCheck, UserPlus, Users, VideoOff, Volume2, VolumeX, Wallet, X } from 'lucide-react';
import { Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from 'livekit-client';
import { ApiError, useAuth, useErrorMessage } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import type { LiveStream, StreamMessage, StreamToken } from '@/lib/streams';
import { GiftFeed, GiftPanel } from './gift-panel';
import { OpponentFeed, type OpponentFeedHandle } from './opponent-feed';
import { PkScoreboard, useBattle } from './pk-controls';
import { LiveLikeButton } from './live-likes';
import styles from './watch.module.css';

type Sheet = 'share' | 'more' | 'report' | null;

function WatchChat({ streamId, live, actions }: { streamId: string; live: boolean; actions: ReactNode }) {
  const { user, request } = useAuth(); const { pick } = useLocale(); const errorMessage = useErrorMessage();
  const [items, setItems] = useState<StreamMessage[]>([]); const [body, setBody] = useState('');
  const [error, setError] = useState(''); const [sending, setSending] = useState(false); const sendingRef = useRef(false); const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try { const result = await request<{ items: StreamMessage[] }>(`/streams/${streamId}/messages`, { auth: false }); if (!cancelled) { setItems(result.items); setError(''); } }
      catch { if (!cancelled) setError(pick('تعذر تحديث التعليقات. سنحاول مجددًا.', 'Comments could not refresh. Retrying shortly.')); }
      finally { if (!cancelled && live) timer = setTimeout(() => { void load(); }, document.hidden ? 12000 : 3000); }
    };
    setItems([]); void load(); return () => { cancelled = true; clearTimeout(timer); };
  }, [streamId, live, request, pick]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }); }, [items.length]);
  async function send(event: FormEvent) {
    event.preventDefault(); if (!live || !body.trim() || sendingRef.current) return;
    sendingRef.current = true; setSending(true); setError('');
    try { const message = await request<StreamMessage>(`/streams/${streamId}/messages`, { method: 'POST', body: JSON.stringify({ body: body.trim() }) }); setItems(previous => [...previous.filter(item => item.id !== message.id), message].slice(-100)); setBody(''); }
    catch (failure) { setError(failure instanceof ApiError && failure.status === 409 ? pick('انتهى البث.', 'The stream has ended.') : errorMessage(failure)); }
    finally { sendingRef.current = false; setSending(false); }
  }
  return <><div className={styles.messages} ref={list} role="log" aria-live="polite" aria-relevant="additions" aria-label={pick('التعليقات المباشرة', 'Live comments')}>
    <div className={styles.welcome}><ShieldCheck size={16} /><p>{pick('أهلًا بك في LiveStar! شارك باحترام واحمِ خصوصيتك. هدايا DU الحالية ترويجية ولا تحمل قيمة نقدية.', 'Welcome to LiveStar! Be kind and protect your privacy. Current DU gifts are promotional and have no cash value.')}</p></div>
    {items.map(item => <p key={item.id} className={styles.message}><span className={styles.messageAvatar} aria-hidden="true">{item.sender.displayName.slice(0, 1)}</span><span><strong>{item.sender.displayName}</strong> {item.body}</span></p>)}
  </div>{error && <p className={styles.inlineError} role="status">{error}</p>}<div className={styles.toolbar}>
    {user ? <form className={styles.compose} onSubmit={send}><input data-testid="chat-input" value={body} maxLength={500} onChange={event => setBody(event.target.value)} aria-label={pick('رسالتك', 'Your message')} placeholder={pick(live ? 'أضف تعليقًا…' : 'انتهى البث', live ? 'Add a comment…' : 'Stream ended')} disabled={!live || sending} /><button data-testid="chat-send" type="submit" disabled={!live || sending || !body.trim()} aria-label={pick('إرسال التعليق', 'Send comment')}>{sending ? <LoaderCircle size={18} className="spin" /> : <Send size={18} />}</button></form> : <Link className={styles.loginComment} href={`/login?returnTo=${encodeURIComponent(`/live/${streamId}`)}`}><MessageCircle size={19} />{pick('أضف تعليقًا…', 'Add a comment…')}</Link>}
    {actions}
  </div></>;
}

export function WatchPage({ id }: { id: string }) {
  const { user, request } = useAuth(); const { pick, locale, setLocale } = useLocale(); const errorMessage = useErrorMessage();
  const [stream, setStream] = useState<LiveStream | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const [connection, setConnection] = useState('connecting'); const [hasVideo, setHasVideo] = useState(false); const [audioBlocked, setAudioBlocked] = useState(false);
  const [muted, setMuted] = useState(false); const [retry, setRetry] = useState(0); const [sheet, setSheet] = useState<Sheet>(null);
  const [shareUrl, setShareUrl] = useState(''); const [copied, setCopied] = useState(false); const [report, setReport] = useState(''); const [reporting, setReporting] = useState(false); const [notice, setNotice] = useState('');
  const [following, setFollowing] = useState(false); const [followBusy, setFollowBusy] = useState(false);
  const video = useRef<HTMLVideoElement>(null); const audio = useRef<HTMLDivElement>(null); const room = useRef<Room | null>(null); const mutedRef = useRef(false); const stage = useRef<HTMLElement>(null);
  const errorMessageRef = useRef(errorMessage); errorMessageRef.current = errorMessage;
  const dialog = useRef<HTMLDialogElement>(null); const dialogTitle = useId(); const followLock = useRef(false); const reportLock = useRef(false);
  const live = stream?.status === 'LIVE'; const owner = !!user && user.id === stream?.creator.id;
  const { battle, serverNow: battleNow } = useBattle(stream?.id ?? null, live);
  const duel = live && battle?.status === 'ACTIVE';
  const ownIsHost = battle?.host.streamId === id;
  const opponent = duel && battle ? (ownIsHost ? battle.guest : battle.host) : null;
  const opponentMedia = useRef<OpponentFeedHandle>(null);

  useEffect(() => {
    let cancelled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try { const result = await request<LiveStream>(`/streams/${id}`, { auth: false }); if (!cancelled) { setStream(result); setError(''); } }
      catch (failure) { if (!cancelled) setError(errorMessageRef.current(failure)); }
      finally { if (!cancelled) { setLoading(false); timer = setTimeout(() => { void load(); }, document.hidden ? 20000 : 10000); } }
    };
    setLoading(true); setStream(null); setError(''); void load(); return () => { cancelled = true; clearTimeout(timer); };
  }, [id, request]);
  useEffect(() => {
    if (!live || loading) { void room.current?.disconnect(); setConnection('disconnected'); return; }
    let cancelled = false; let timedOut = false; const controller = new AbortController(); const current = new Room({ adaptiveStream: true }); room.current = current; setConnection('connecting');
    const audioContainer = audio.current; const videoElement = video.current;
    const subscribed = (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (cancelled || timedOut || participant.identity !== stream?.creator.id) return;
      if (track.kind === Track.Kind.Video && videoElement) { track.attach(videoElement); setHasVideo(true); }
      else if (track.kind === Track.Kind.Audio && audioContainer) { const element = track.attach() as HTMLAudioElement; element.muted = mutedRef.current; element.setAttribute('data-stream-audio', 'true'); element.setAttribute('data-stream-id', id); audioContainer.append(element); }
    };
    current.on(RoomEvent.TrackSubscribed, subscribed);
    current.on(RoomEvent.TrackUnsubscribed, track => { track.detach().forEach(element => { if (element.tagName === 'AUDIO') element.remove(); }); if (track.kind === Track.Kind.Video && !cancelled) setHasVideo(false); });
    current.on(RoomEvent.Reconnecting, () => { if (!cancelled) setConnection('reconnecting'); });
    current.on(RoomEvent.Reconnected, () => { if (!cancelled) setConnection('connected'); });
    current.on(RoomEvent.Disconnected, () => { if (!cancelled) { setConnection(timedOut ? 'failed' : 'disconnected'); setHasVideo(false); } });
    current.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (!cancelled) setAudioBlocked(!current.canPlaybackAudio); });
    const timeout = setTimeout(() => { if (!cancelled && current.state !== 'connected') { timedOut = true; controller.abort(); setConnection('failed'); void current.disconnect(); } }, 45000);
    void (async () => {
      try { const credentials = await request<StreamToken>(`/streams/${id}/token`, { method: 'POST', auth: false, signal: controller.signal }); if (cancelled || timedOut) return; await current.connect(credentials.url, credentials.token); if (cancelled || timedOut) { await current.disconnect(); return; } clearTimeout(timeout); setConnection('connected'); setAudioBlocked(!current.canPlaybackAudio); }
      catch { clearTimeout(timeout); if (!cancelled) setConnection('failed'); }
    })();
    return () => { cancelled = true; controller.abort(); clearTimeout(timeout); void current.disconnect(); audioContainer?.replaceChildren(); setHasVideo(false); if (room.current === current) room.current = null; };
  }, [id, live, loading, request, retry, stream?.creator.id]);
  useEffect(() => { if (sheet) { if (!dialog.current?.open) dialog.current?.showModal(); } else dialog.current?.close(); }, [sheet]);
  useEffect(() => {
    if (!user || !stream || user.id === stream.creator.id) { setFollowing(false); return; }
    let cancelled = false;
    void request<{ following: boolean }>(`/social/${stream.creator.id}`).then(result => { if (!cancelled) setFollowing(result.following); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [user?.id, stream?.creator.id, request]);
  async function follow() {
    if (!stream || !user || followLock.current) return;
    followLock.current = true; setFollowBusy(true); setError('');
    try { const result = await request<{ following: boolean }>(`/social/${stream.creator.id}/follow`, { method: following ? 'DELETE' : 'POST' }); setFollowing(result.following); }
    catch (failure) { setError(errorMessage(failure)); } finally { followLock.current = false; setFollowBusy(false); }
  }
  async function share() {
    const url = new URL(`/live/${id}`, window.location.origin).toString(); setShareUrl(url); setCopied(false);
    if (navigator.share) { try { await navigator.share({ title: stream?.title || 'LiveStar', url }); return; } catch (failure) { if (failure instanceof DOMException && failure.name === 'AbortError') return; } }
    setSheet('share');
  }
  async function copy() { try { await navigator.clipboard.writeText(shareUrl); setCopied(true); } catch { setNotice(pick('يمكنك تحديد الرابط ونسخه يدويًا.', 'Select the link and copy it manually.')); } }
  async function toggleAudio() {
    if (audioBlocked) { try { await Promise.all([room.current?.startAudio(), opponentMedia.current?.startAudio()]); setAudioBlocked(false); } catch { setNotice(pick('لم يسمح المتصفح بتشغيل الصوت بعد. حاول مجددًا.', 'Your browser has not allowed audio yet. Try again.')); return; } }
    const next = !muted; mutedRef.current = next; setMuted(next); audio.current?.querySelectorAll('audio').forEach(element => { element.muted = next; });
  }
  async function fullscreen() {
    setSheet(null);
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await stage.current?.requestFullscreen(); }
    catch { setNotice(pick('المشاهدة تملأ الصفحة بالفعل. ملء شاشة الجهاز غير متاح في هذا المتصفح.', 'The player already fills the page. Device fullscreen is unavailable in this browser.')); }
  }
  async function submitReport(event: FormEvent) {
    event.preventDefault(); if (report.trim().length < 3 || reportLock.current) return;
    reportLock.current = true; setReporting(true); setError('');
    try { await request(`/streams/${id}/report`, { method: 'POST', body: JSON.stringify({ reason: report.trim() }) }); setReport(''); setSheet(null); setNotice(pick('تم استلام بلاغك للمراجعة.', 'Your report was submitted for review.')); }
    catch (failure) { setError(errorMessage(failure)); } finally { reportLock.current = false; setReporting(false); }
  }
  const mediaFailed = ['failed', 'disconnected'].includes(connection);
  return <section ref={stage} className={styles.page} data-testid="watch-stage" aria-label={pick('مشاهدة البث المباشر', 'Watch live stream')}>
    <video ref={video} muted autoPlay playsInline className={`${styles.video} ${duel ? styles.pkOwnVideo : ''} ${duel ? (ownIsHost ? styles.pkHost : styles.pkGuest) : ''}`} data-testid="watch-video" data-stream-id={id} aria-label={pick('فيديو البث المباشر', 'Live stream video')} /><div ref={audio} hidden />
    {opponent && <OpponentFeed ref={opponentMedia} streamId={opponent.streamId} creatorId={opponent.userId} displayName={opponent.displayName} side={ownIsHost ? 'guest' : 'host'} testId="watch-opponent-video" muted={muted} />}
    {duel && battle && <><strong className={`${styles.pkOwnName} ${ownIsHost ? styles.pkHost : styles.pkGuest}`}>{stream?.creator.displayName}</strong><div className={styles.pkGiftHost} data-testid="pk-host-gifts"><GiftPanel streamId={battle.host.streamId} isLive={live} isCreator={user?.id === battle.host.userId} recipientName={battle.host.displayName} compact /></div><div className={styles.pkGiftGuest} data-testid="pk-guest-gifts"><GiftPanel streamId={battle.guest.streamId} isLive={live} isCreator={user?.id === battle.guest.userId} recipientName={battle.guest.displayName} compact /></div></>}
    <div className={styles.shade} aria-hidden="true" />
    {live && <PkScoreboard battle={battle} serverNow={battleNow} streamId={id} />}
    <header className={styles.header}>
      {stream ? <div className={styles.creatorPill}><Link href={`/u/${stream.creator.username}`} className={styles.creatorLink}><span className={styles.avatar}>{stream.creator.displayName.slice(0, 1)}</span><span><strong>{stream.creator.displayName}</strong><small><span className={live ? styles.liveDot : styles.endedDot} />{pick(live ? 'مباشر' : 'انتهى البث', live ? 'LIVE' : 'ENDED')}</small></span></Link>{!owner && (user ? <button className={following ? styles.following : styles.follow} type="button" onClick={() => { void follow(); }} disabled={followBusy} data-testid="watch-follow" aria-pressed={following}>{followBusy ? <LoaderCircle size={14} className="spin" /> : following ? <Check size={14} /> : <UserPlus size={14} />}<span>{pick(following ? 'تتابعه' : 'متابعة', following ? 'Following' : 'Follow')}</span></button> : <Link className={styles.follow} href={`/login?returnTo=${encodeURIComponent(`/live/${id}`)}`}><UserPlus size={14} />{pick('متابعة', 'Follow')}</Link>)}</div> : <Link href="/" className={styles.wordmark}>Live<span>Star</span></Link>}
      <div className={styles.topActions}>{stream && <span className={styles.viewerCount} title={pick('المشاهدون الآن', 'Current viewers')}><Users size={15} /><span data-testid="watch-viewers">{stream.viewerCount ?? '…'}</span></span>}<button type="button" className={styles.round} onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} aria-label={pick('Switch to English', 'التبديل إلى العربية')}><Globe2 size={19} /></button><Link href="/" className={styles.round} aria-label={pick('مغادرة البث', 'Leave stream')} data-testid="watch-close"><X size={25} /></Link></div>
    </header>
    {stream && <div className={styles.titleRow}><h1>{stream.title}</h1>{live && <span className={styles.onAir}><Radio size={12} />LIVE</span>}</div>}
    {(loading || !stream || !live || !hasVideo) && <div className={`${styles.placeholder} ${duel ? styles.pkPaused : ''} ${duel ? (ownIsHost ? styles.pkHost : styles.pkGuest) : ''}`} role="status">
      {loading ? <LoaderCircle size={35} className="spin" /> : !stream || !live ? <VideoOff size={40} strokeWidth={1.3} /> : <Radio size={40} strokeWidth={1.3} />}
      <h2>{pick(loading ? 'نجهّز لك اللحظة…' : !stream ? 'البث غير متاح' : !live ? 'انتهت هذه اللحظة' : mediaFailed ? 'انقطع الاتصال بالبث' : connection === 'connected' ? 'بانتظار صورة المذيع' : 'جارٍ الاتصال بالبث…', loading ? 'One moment…' : !stream ? 'Stream unavailable' : !live ? 'This moment has ended' : mediaFailed ? 'Stream connection interrupted' : connection === 'connected' ? 'Waiting for the broadcaster’s video' : 'Connecting to the stream…')}</h2>
      <p>{pick(!stream && !loading ? error || 'ربما تغيّر الرابط أو لم يعد البث متاحًا.' : !live && !loading ? 'شكرًا لمشاركتك. اكتشف من يبث الآن.' : 'الصوت والتعليقات والهدايا تجتمع هنا.', !stream && !loading ? error || 'The link may have changed or this stream is no longer available.' : !live && !loading ? 'Thanks for joining. Discover who is live now.' : 'A place for voices, conversation and gifts.')}</p>
      {stream && live && mediaFailed ? <button className={styles.retry} type="button" onClick={() => setRetry(value => value + 1)} data-testid="watch-retry"><RefreshCw size={16} />{pick('إعادة الاتصال', 'Reconnect')}</button> : !loading && (!stream || !live) ? <Link href="/" className={styles.retry}>{pick('اكتشف بثوثًا أخرى', 'Explore live streams')}</Link> : null}
    </div>}
    {stream && <GiftFeed streamId={id} active={live} showTotals={!duel} side={duel ? (ownIsHost ? 'host' : 'guest') : undefined} />}{opponent && <GiftFeed streamId={opponent.streamId} active={live} showTotals={false} side={ownIsHost ? 'guest' : 'host'} />}
    {audioBlocked && live && <button className={styles.audioPrompt} type="button" onClick={() => { void toggleAudio(); }}><Volume2 size={18} />{pick('اضغط لتشغيل الصوت', 'Tap to enable sound')}</button>}
    {stream && <div className={styles.bottom}><WatchChat streamId={id} live={live} actions={<><button className={styles.round} type="button" onClick={() => { void share(); }} aria-label={pick('مشاركة البث', 'Share stream')} data-testid="watch-share"><Share2 size={23} /></button><GiftPanel streamId={id} isLive={live} isCreator={owner} recipientName={stream.creator.displayName} compact /><LiveLikeButton streamId={id} isLive={live} compact /><button type="button" className={styles.round} onClick={() => setSheet('more')} aria-label={pick('المزيد من الأدوات', 'More options')} data-testid="watch-more"><MoreHorizontal size={24} /></button></>} />{owner && live && <Link href="/go-live" className={styles.ownerLink}>{pick('العودة إلى أدوات إدارة بثك', 'Return to your studio')}</Link>}</div>}
    {notice && <div role="status" className={styles.notice}>{notice}<button type="button" onClick={() => setNotice('')} aria-label={pick('إغلاق التنبيه', 'Dismiss notice')}><X size={15} /></button></div>}
    {error && stream && !sheet && <div role="alert" className={styles.error}>{error}<button type="button" onClick={() => setError('')} aria-label={pick('إغلاق التنبيه', 'Dismiss alert')}><X size={15} /></button></div>}
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={dialogTitle} onCancel={() => setSheet(null)} onClose={() => setSheet(null)}>
      <div className={styles.handle} /><div className={styles.dialogHeader}><h2 id={dialogTitle}>{pick(sheet === 'share' ? 'شارك اللحظة' : sheet === 'report' ? 'الإبلاغ عن البث' : 'أدوات المشاهدة', sheet === 'share' ? 'Share the moment' : sheet === 'report' ? 'Report stream' : 'Viewing tools')}</h2><button type="button" className={styles.round} onClick={() => setSheet(null)} aria-label={pick('إغلاق', 'Close')}><X size={21} /></button></div>
      {sheet === 'share' && <><p>{pick('أرسل الرابط لأصدقائك وانضموا إلى الحديث.', 'Send the link to your friends and join the conversation.')}</p><div className={styles.copyRow}><input aria-label={pick('رابط البث', 'Stream link')} value={shareUrl} readOnly dir="ltr" onFocus={event => event.target.select()} /><button type="button" onClick={() => { void copy(); }}>{copied ? <Check size={19} /> : <Copy size={19} />}{pick(copied ? 'تم النسخ' : 'نسخ', copied ? 'Copied' : 'Copy')}</button></div></>}
      {sheet === 'more' && <div className={styles.optionList}><button type="button" onClick={() => { void fullscreen(); }} data-testid="watch-fullscreen"><Maximize size={21} />{pick('ملء الشاشة', 'Fullscreen')}</button><button type="button" onClick={() => { void toggleAudio(); }}>{muted ? <VolumeX size={21} /> : <Volume2 size={21} />}{pick(muted ? 'تشغيل الصوت' : 'كتم صوت المشاهدة', muted ? 'Unmute audio' : 'Mute stream audio')}</button><Link href="/wallet"><Wallet size={21} />{pick('محفظة DU', 'DU wallet')}</Link><button type="button" onClick={() => { void share(); }}><Share2 size={21} />{pick('مشاركة البث', 'Share stream')}</button>{user ? <button type="button" onClick={() => { setError(''); setSheet('report'); }}><Flag size={21} />{pick('الإبلاغ عن محتوى مخالف', 'Report inappropriate content')}</button> : <Link href={`/login?returnTo=${encodeURIComponent(`/live/${id}`)}`}><Flag size={21} />{pick('سجّل الدخول للإبلاغ', 'Sign in to report')}</Link>}<Link href="/terms"><ShieldCheck size={21} />{pick('إرشادات المجتمع والشروط', 'Community guidelines and terms')}</Link></div>}
      {sheet === 'report' && <form className={styles.reportForm} onSubmit={submitReport}><label>{pick('ما سبب البلاغ؟', 'What is the reason for this report?')}<textarea maxLength={500} minLength={3} required value={report} onChange={event => setReport(event.target.value)} placeholder={pick('صِف المخالفة باختصار…', 'Briefly describe the issue…')} /></label><p>{pick('يُحفظ البلاغ للمراجعة. لا يؤدي الإرسال وحده إلى إيقاف البث.', 'Your report is saved for review. Submitting it does not automatically stop the stream.')}</p>{error && <p role="alert" className={styles.inlineError}>{error}</p>}<button type="submit" className={styles.reportSubmit} disabled={reporting || report.trim().length < 3}>{reporting && <LoaderCircle size={17} className="spin" />}{pick('إرسال البلاغ', 'Submit report')}</button></form>}
    </dialog>
  </section>;
}
