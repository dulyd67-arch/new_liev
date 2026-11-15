'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Camera, Check, ChevronDown, Copy, ExternalLink, FlipHorizontal2, Globe2, LoaderCircle, MessageCircle, Mic, MicOff, MoreHorizontal, Power, Radio, Send, Settings2, Share2, ShieldCheck, Star, Users, Video, VideoOff, X } from 'lucide-react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { ApiError, RequireAuth, useAuth, useErrorMessage } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import type { LiveStream, StreamMessage, StreamToken } from '@/lib/streams';
import styles from './studio.module.css';
import { GiftFeed } from './gift-panel';

type Sheet = 'settings' | 'category' | 'audience' | 'share' | 'end' | null;
type Phase = 'idle' | 'capture' | 'connect' | 'publish' | 'activate' | 'live' | 'end';
const classes = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' ');

function Tool({ children, label, id, onClick, disabled, active, danger }: {
  children: ReactNode; label: string; id?: string; onClick: () => void; disabled?: boolean; active?: boolean; danger?: boolean;
}) {
  return <button type="button" data-testid={id} className={classes(styles.tool, active && styles.toolActive, danger && styles.toolDanger)} onClick={onClick} disabled={disabled} aria-label={label} title={label} aria-pressed={active === undefined ? undefined : active}>
    <span>{children}</span><small>{label}</small>
  </button>;
}

function BottomSheet({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null); const titleId = useId();
  const { pick } = useLocale();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.querySelector<HTMLElement>('button, input, select, a[href]')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab' || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')].filter(item => item.offsetParent !== null);
      const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [close]);
  return <div className={styles.scrim} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={ref} className={styles.sheet} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={styles.handle} /><div className={styles.sheetHeading}><h2 id={titleId}>{title}</h2><button data-testid="studio-dialog-close" type="button" className={styles.round} onClick={close} aria-label={pick('إغلاق', 'Close')}><X size={21} /></button></div>
      {children}
    </div>
  </div>;
}

function StudioChat({ streamId }: { streamId: string }) {
  const { request } = useAuth(); const { pick } = useLocale(); const errorMessage = useErrorMessage();
  const [items, setItems] = useState<StreamMessage[]>([]); const [body, setBody] = useState(''); const [error, setError] = useState(''); const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const load = async () => { try { const result = await request<{ items: StreamMessage[] }>('/streams/' + streamId + '/messages', { auth: false }); if (active) setItems(result.items); } catch { /* Retain messages during a short interruption. */ } };
    void load(); const timer = window.setInterval(() => { void load(); }, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [request, streamId]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }); }, [items.length]);
  async function send(event: FormEvent) {
    event.preventDefault(); if (!body.trim() || sending) return;
    setSending(true); setError('');
    try { const message = await request<StreamMessage>('/streams/' + streamId + '/messages', { method: 'POST', body: JSON.stringify({ body: body.trim() }) }); setItems(previous => [...previous.filter(item => item.id !== message.id), message].slice(-100)); setBody(''); }
    catch (failure) { setError(errorMessage(failure)); } finally { setSending(false); }
  }
  return <div className={styles.chat}>
    <div ref={list} className={styles.messages} role="log" aria-live="polite" aria-relevant="additions">
      {!items.length && <div className={styles.welcome}><ShieldCheck size={17} /><p>{pick('أهلًا بك في LiveStar. شارك باحترام، واحمِ خصوصيتك وخصوصية الآخرين.', 'Welcome to LiveStar. Share respectfully and protect everyone’s privacy.')}</p></div>}
      {items.map(item => <div key={item.id} className={styles.message}><strong>{item.sender.displayName}</strong><span>{item.body}</span></div>)}
    </div>
    <form className={styles.compose} onSubmit={send}><input data-testid="chat-input" aria-label={pick('رسالتك', 'Your message')} value={body} onChange={event => setBody(event.target.value)} maxLength={500} placeholder={pick('أضف تعليقًا…', 'Add a comment…')} disabled={sending} /><button data-testid="chat-send" type="submit" aria-label={pick('إرسال الرسالة', 'Send message')} disabled={sending || !body.trim()}>{sending ? <LoaderCircle size={19} className="spin" /> : <Send size={19} />}</button></form>
    {error && <p className={styles.inlineError} role="alert">{error}</p>}
  </div>;
}

export function StudioPage() { return <RequireAuth><Studio /></RequireAuth>; }

function Studio() {
  const { user, request } = useAuth(); const { pick, locale, setLocale } = useLocale(); const errorMessage = useErrorMessage(); const router = useRouter();
  const [title, setTitle] = useState(''); const [category, setCategory] = useState('chat'); const [stream, setStream] = useState<LiveStream | null>(null);
  const [phase, setPhase] = useState<Phase>('idle'); const [previewReady, setPreviewReady] = useState(false); const [live, setLive] = useState(false); const [connected, setConnected] = useState(false);
  const [micOn, setMicOn] = useState(true); const [cameraOn, setCameraOn] = useState(true); const [mirrored, setMirrored] = useState(true); const [showChat, setShowChat] = useState(true);
  const [sheet, setSheet] = useState<Sheet>(null); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [copied, setCopied] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]); const [switching, setSwitching] = useState(false); const [clock, setClock] = useState(Date.now());
  const video = useRef<HTMLVideoElement>(null); const media = useRef<MediaStream | null>(null); const room = useRef<Room | null>(null); const currentStream = useRef<LiveStream | null>(null);
  const operation = useRef(0); const mounted = useRef(true); const requestRef = useRef(request); requestRef.current = request;
  const busy = phase !== 'idle' && phase !== 'live'; const name = user?.profile?.displayName || user?.profile?.username || 'LiveStar';
  const cameras = devices.filter(device => device.kind === 'videoinput'); const microphones = devices.filter(device => device.kind === 'audioinput');
  const activeCamera = media.current?.getVideoTracks()[0]?.getSettings().deviceId || ''; const activeMic = media.current?.getAudioTracks()[0]?.getSettings().deviceId || '';
  const categories = [['chat', pick('دردشة', 'Just chatting')], ['music', pick('موسيقى', 'Music')], ['gaming', pick('ألعاب', 'Gaming')], ['talent', pick('مواهب', 'Talent')]];
  const categoryLabel = categories.find(item => item[0] === category)?.[1];
  const phaseLabel = phase === 'capture' ? pick('جارٍ تشغيل الكاميرا…', 'Starting camera…') : phase === 'connect' ? pick('جارٍ الاتصال بخدمة البث…', 'Connecting to the stream…') : phase === 'publish' ? pick('جارٍ نشر الصوت والصورة…', 'Publishing camera and microphone…') : phase === 'activate' ? pick('لحظة، نجهّز بثك…', 'Getting your stream ready…') : phase === 'end' ? pick('جارٍ إنهاء البث…', 'Ending stream…') : '';
  const elapsed = live && stream?.startedAt ? Math.max(0, Math.floor((clock - Date.parse(stream.startedAt)) / 1000)) : 0;
  const elapsedLabel = String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0');
  function remember(value: LiveStream | null) { currentStream.current = value; if (mounted.current) setStream(value); }
  function stopCapture() { media.current?.getTracks().forEach(track => track.stop()); media.current = null; if (video.current) video.current.srcObject = null; }
  async function endRemote(id: string) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 12000);
    try { await requestRef.current('/streams/' + id + '/end', { method: 'POST', keepalive: true, signal: controller.signal }); }
    finally { window.clearTimeout(timer); }
  }
  async function enumerate() { if (navigator.mediaDevices?.enumerateDevices) setDevices(await navigator.mediaDevices.enumerateDevices()); }
  useEffect(() => {
    mounted.current = true; let active = true;
    void requestRef.current<{ stream: LiveStream | null }>('/streams/mine').then(result => { if (active && result.stream) { remember(result.stream); setTitle(result.stream.title); setCategory(result.stream.category || 'chat'); } }).catch(() => undefined);
    const cleanup = () => {
      ++operation.current; stopCapture(); const connection = room.current; room.current = null; void connection?.disconnect();
      const id = currentStream.current?.id; currentStream.current = null; if (id) void endRemote(id).catch(() => undefined);
    };
    window.addEventListener('pagehide', cleanup);
    return () => { active = false; mounted.current = false; window.removeEventListener('pagehide', cleanup); cleanup(); };
    // Capture ownership follows the page lifetime, not auth-token refreshes.
  }, []);
  useEffect(() => {
    if (!live || !stream?.id) return;
    let active = true;
    const load = async () => { try { const value = await request<LiveStream>('/streams/' + stream.id, { auth: false }); if (active) remember(value); } catch { /* Keep the last confirmed count. */ } };
    void load(); const timer = window.setInterval(() => { void load(); }, 10000);
    const clockTimer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { active = false; window.clearInterval(timer); window.clearInterval(clockTimer); };
  }, [live, stream?.id, request]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(''), 4000); return () => window.clearTimeout(timer); }, [notice]);
  const closeSheet = useCallback(() => setSheet(null), []);
  async function preview() {
    if (busy) return; const generation = ++operation.current; setPhase('capture'); setError('');
    try {
      const capture = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: true });
      if (!mounted.current || generation !== operation.current) { capture.getTracks().forEach(track => track.stop()); return; }
      stopCapture(); media.current = capture; setMicOn(true); setCameraOn(true); setMirrored(true);
      if (video.current) { video.current.srcObject = capture; await video.current.play(); }
      setPreviewReady(true); await enumerate().catch(() => undefined);
    } catch { if (mounted.current && generation === operation.current) { stopCapture(); setPreviewReady(false); setError(pick('اسمح باستخدام الكاميرا والميكروفون من إعدادات المتصفح، ثم حاول مجددًا.', 'Allow camera and microphone access in your browser, then try again.')); } }
    finally { if (mounted.current && generation === operation.current) setPhase('idle'); }
  }
  async function start(event: FormEvent) {
    event.preventDefault(); if (!previewReady || !media.current || busy || switching || !title.trim()) return;
    const generation = ++operation.current; let cancelled = false; let createdId: string | null = null; let connection: Room | null = null; let timer: number | undefined;
    const ensureCurrent = () => { if (cancelled || !mounted.current || generation !== operation.current) throw new Error('CANCELLED'); };
    setError(''); setPhase('connect'); setSheet(null);
    const work = async () => {
      let credentials: StreamToken; let current = currentStream.current;
      if (current) credentials = await request<StreamToken>('/streams/' + current.id + '/host-token', { method: 'POST' });
      else {
        const created = await request<{ stream: LiveStream } & StreamToken>('/streams', { method: 'POST', body: JSON.stringify({ title: title.trim(), category }) });
        createdId = created.stream.id;
        if (cancelled || !mounted.current || generation !== operation.current) { await endRemote(createdId).catch(() => undefined); throw new Error('CANCELLED'); }
        current = created.stream; remember(current); credentials = created;
      }
      ensureCurrent(); connection = new Room({ adaptiveStream: true, dynacast: true }); room.current = connection;
      connection.on(RoomEvent.Reconnecting, () => { if (mounted.current) setConnected(false); });
      connection.on(RoomEvent.Reconnected, () => { if (mounted.current) setConnected(true); });
      connection.on(RoomEvent.Disconnected, () => { if (mounted.current && room.current === connection) { setConnected(false); setLive(false); } });
      await connection.connect(credentials.url, credentials.token, { websocketTimeout: 15000, peerConnectionTimeout: 15000, maxRetries: 1 });
      ensureCurrent(); setPhase('publish');
      for (const track of media.current?.getTracks() || []) { await connection.localParticipant.publishTrack(track, { source: track.kind === 'video' ? Track.Source.Camera : Track.Source.Microphone }); ensureCurrent(); }
      if (!cameraOn) await connection.localParticipant.setCameraEnabled(false);
      if (!micOn) await connection.localParticipant.setMicrophoneEnabled(false);
      ensureCurrent(); setPhase('activate');
      const active = await request<LiveStream>('/streams/' + current!.id + '/activate', { method: 'POST' });
      ensureCurrent(); remember(active); setClock(Date.now()); setLive(true); setConnected(true); setPhase('live');
    };
    try {
      await Promise.race([work(), new Promise<never>((_, reject) => { timer = window.setTimeout(() => { cancelled = true; void connection?.disconnect(); reject(new Error('CONNECTION_TIMEOUT')); }, 60000); })]);
    } catch (failure) {
      cancelled = true; await (connection as Room | null)?.disconnect().catch(() => undefined);
      if (generation === operation.current && mounted.current) {
        room.current = null; const id = currentStream.current?.id || createdId;
        if (id) { try { await endRemote(id); remember(null); } catch { /* Retain ownership so the user can close it again. */ } }
        stopCapture(); setPreviewReady(false); setLive(false); setConnected(false); setPhase('idle');
        setError(failure instanceof ApiError ? errorMessage(failure) : pick('تعذر إكمال الاتصال بالبث. تحقق من الشبكة ثم شغّل الكاميرا وحاول مجددًا.', 'The stream could not connect. Check your network, enable the camera and try again.'));
      }
    } finally { if (timer) window.clearTimeout(timer); }
  }
  async function end(exit = false) {
    ++operation.current; setPhase('end'); setError(''); const connection = room.current; room.current = null;
    await connection?.disconnect().catch(() => undefined); stopCapture(); setPreviewReady(false); setLive(false); setConnected(false);
    try { const id = currentStream.current?.id; if (id) await endRemote(id); remember(null); setSheet(null); if (exit) router.push('/'); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { if (mounted.current) setPhase('idle'); }
  }
  function exit() { if (stream || busy || live) setSheet('end'); else { stopCapture(); router.push('/'); } }
  async function toggle(kind: 'audio' | 'video') {
    if (!previewReady || busy || switching) return; setError('');
    const enabled = kind === 'audio' ? !micOn : !cameraOn;
    try {
      if (live && room.current) { if (kind === 'audio') await room.current.localParticipant.setMicrophoneEnabled(enabled); else await room.current.localParticipant.setCameraEnabled(enabled); }
      else media.current?.getTracks().filter(track => track.kind === kind).forEach(track => { track.enabled = enabled; });
      if (kind === 'audio') setMicOn(enabled); else setCameraOn(enabled);
    } catch { setError(pick('تعذر تغيير هذا الجهاز. حاول مجددًا.', 'Unable to change this device. Try again.')); }
  }
  async function changeDevice(kind: 'video' | 'audio', deviceId: string) {
    if (!deviceId || !media.current || switching || busy) return; setSwitching(true); setError('');
    let next: MediaStreamTrack | undefined;
    try {
      const capture = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false } : { video: false, audio: { deviceId: { exact: deviceId } } });
      next = capture.getTracks()[0]; if (!next || !media.current) { capture.getTracks().forEach(track => track.stop()); return; }
      const old = kind === 'video' ? media.current.getVideoTracks()[0] : media.current.getAudioTracks()[0];
      const publication = room.current?.localParticipant.getTrackPublication(kind === 'video' ? Track.Source.Camera : Track.Source.Microphone);
      if (live && publication?.track) await publication.track.replaceTrack(next, { userProvidedTrack: true });
      next.enabled = kind === 'video' ? cameraOn : micOn;
      if (old) media.current.removeTrack(old); media.current.addTrack(next); old?.stop();
      if (video.current) { video.current.srcObject = media.current; await video.current.play().catch(() => undefined); }
      if (kind === 'video') setMirrored(next.getSettings().facingMode ? next.getSettings().facingMode !== 'environment' : /front|user|facetime/i.test(cameras.find(item => item.deviceId === deviceId)?.label || ''));
      await enumerate().catch(() => undefined);
    } catch { next?.stop(); setError(pick('تعذر التبديل إلى الجهاز المحدد. الجهاز الحالي لم يتغير.', 'Unable to switch to that device. Your current device is unchanged.')); }
    finally { setSwitching(false); }
  }
  function flip() { const index = cameras.findIndex(device => device.deviceId === activeCamera); const next = cameras[(index + 1) % cameras.length]; if (next && cameras.length > 1) void changeDevice('video', next.deviceId); }
  async function share() {
    if (!stream || !live) return; const url = new URL('/live/' + stream.id, window.location.origin).toString();
    try { if (navigator.share) await navigator.share({ title: stream.title, url }); else { await navigator.clipboard.writeText(url); setCopied(true); } }
    catch (failure) { if (!(failure instanceof DOMException && failure.name === 'AbortError')) setNotice(pick('يمكنك نسخ رابط البث من الحقل أدناه.', 'You can copy the stream link from the field below.')); }
  }
  const shareUrl = stream && typeof window !== 'undefined' ? new URL('/live/' + stream.id, window.location.origin).toString() : '';
  return <div className={styles.stage} data-testid="studio-screen">
    <video ref={video} className={classes(styles.cameraFeed, mirrored && styles.mirrored, !cameraOn && styles.cameraHidden)} autoPlay muted playsInline aria-label={pick('معاينة الكاميرا', 'Camera preview')} />
    <div className={styles.shade} />
    <header className={styles.top}>
      <div className={styles.profile}><span className={styles.avatar}>{name.slice(0, 1)}</span><div><strong>{name}</strong><span>{live ? <><i className={styles.liveDot} />{pick(connected ? 'مباشر الآن' : 'جارٍ إعادة الاتصال', connected ? 'LIVE NOW' : 'RECONNECTING')}<bdi>{elapsedLabel}</bdi></> : <><Star size={11} fill="currentColor" /> LiveStar Studio</>}</span></div></div>
      <div className={styles.topActions}><button className={styles.viewerPill} data-testid="studio-audience" onClick={() => setSheet('audience')} aria-label={pick('المشاهدون', 'Viewers')}><Users size={16} /><span data-testid="studio-viewers">{live ? stream?.viewerCount ?? '—' : 0}</span></button><button className={styles.round} data-testid="studio-close" onClick={exit} aria-label={pick('الخروج من الاستوديو', 'Exit studio')}>{live ? <Power size={23} /> : <X size={25} />}</button></div>
    </header>
    <div className={styles.statusBar}><span className={classes(styles.modePill, live && styles.modeLive)}><Radio size={13} />{pick(live ? 'على الهواء' : 'معاينة قبل البث', live ? 'ON AIR' : 'PREVIEW')}</span>{live && stream && <Link href={'/live/' + stream.id} data-testid="studio-sharelink" target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />{pick('صفحة المشاهدة', 'Watch page')}</Link>}</div>
    {!previewReady && !busy && <div className={styles.empty}><div className={styles.cameraOrb}><Video size={38} strokeWidth={1.3} /></div><h1>{pick('هذه لحظتك', 'Make it your moment')}</h1><p>{pick('جهّز الكاميرا والميكروفون. لن يراك أحد حتى تبدأ البث.', 'Get your camera and microphone ready. You are only visible after going live.')}</p><button type="button" data-testid="studio-preview" className={styles.previewButton} onClick={() => { void preview(); }}><Camera size={18} />{pick('تشغيل الكاميرا والميكروفون', 'Enable camera and microphone')}</button></div>}
    {previewReady && !cameraOn && <div className={styles.cameraMuted}><VideoOff size={35} /><span>{pick('الفيديو متوقف مؤقتًا', 'Camera video is paused')}</span></div>}
    {busy && <div className={styles.connecting} role="status"><LoaderCircle size={25} className="spin" /><p>{phaseLabel}</p><small>{pick('يمكنك الإلغاء من زر الإغلاق في الأعلى.', 'You can cancel with the close button above.')}</small></div>}
    {error && !sheet && <div className={styles.error} role="alert">{error}<button aria-label={pick('إغلاق التنبيه', 'Dismiss alert')} onClick={() => setError('')}><X size={16} /></button></div>}
    {notice && <div className={styles.notice} role="status">{notice}</div>}
    {live && stream && <GiftFeed streamId={stream.id} active={live} />}
    <div className={classes(styles.bottom, live && styles.bottomLive)}>
      {live && stream && showChat && <StudioChat streamId={stream.id} />}
      {!live && <div className={styles.previewTools}>
        <Tool id="studio-flip" label={pick('قلب', 'Flip')} disabled={!previewReady || cameras.length < 2 || busy || switching} onClick={flip}><FlipHorizontal2 size={26} /></Tool>
        <Tool id="studio-camera" label={pick(cameraOn ? 'الكاميرا' : 'تشغيل الكاميرا', cameraOn ? 'Camera' : 'Enable camera')} active={!cameraOn} disabled={!previewReady || busy || switching} onClick={() => { void toggle('video'); }}>{cameraOn ? <Video size={26} /> : <VideoOff size={26} />}</Tool>
        <Tool id="studio-mic" label={pick(micOn ? 'الميكروفون' : 'تشغيل الصوت', micOn ? 'Microphone' : 'Unmute')} active={!micOn} disabled={!previewReady || busy || switching} onClick={() => { void toggle('audio'); }}>{micOn ? <Mic size={26} /> : <MicOff size={26} />}</Tool>
        <Tool id="studio-settings" label={pick('الإعدادات', 'Settings')} onClick={() => setSheet('settings')}><Settings2 size={26} /></Tool>
      </div>}
      {!live ? <form className={styles.startCard} onSubmit={start}><div className={styles.titleRow}><span className={styles.smallAvatar}>{name.slice(0, 1)}</span><input data-testid="studio-title" aria-label={pick('عنوان البث', 'Stream title')} value={title} onChange={event => setTitle(event.target.value)} placeholder={pick('إضافة عنوان لبثك…', 'Add your live title…')} maxLength={160} required disabled={busy || !!stream} /><button type="button" className={styles.categoryButton} onClick={() => setSheet('category')} disabled={busy || !!stream}>{categoryLabel}<ChevronDown size={15} /></button></div><button data-testid="studio-start" type="submit" className={styles.startButton} disabled={!previewReady || !title.trim() || busy || switching}>{busy ? <LoaderCircle className="spin" size={22} /> : <Radio size={21} />}<span>{pick(stream ? 'استئناف LIVE' : 'بدء LIVE', stream ? 'Resume LIVE' : 'Go LIVE')}</span></button><p>{pick('بثك عام. شارك محتوى تملك حق مشاركته.', 'Your stream is public. Share content you have the right to share.')}</p></form> : <div className={styles.liveTools}>
        <Tool id="studio-mic" label={pick(micOn ? 'كتم الصوت' : 'تشغيل الصوت', micOn ? 'Mute' : 'Unmute')} active={!micOn} disabled={busy || switching} onClick={() => { void toggle('audio'); }}>{micOn ? <Mic size={24} /> : <MicOff size={24} />}</Tool>
        <Tool id="studio-camera" label={pick(cameraOn ? 'إيقاف الفيديو' : 'تشغيل الفيديو', cameraOn ? 'Pause video' : 'Enable video')} active={!cameraOn} disabled={busy || switching} onClick={() => { void toggle('video'); }}>{cameraOn ? <Video size={24} /> : <VideoOff size={24} />}</Tool>
        <Tool id="studio-flip" label={pick('قلب', 'Flip')} disabled={cameras.length < 2 || busy || switching} onClick={flip}><FlipHorizontal2 size={24} /></Tool>
        <Tool id="studio-share" label={pick('مشاركة', 'Share')} onClick={() => setSheet('share')}><Share2 size={24} /></Tool>
        <Tool id="studio-settings" label={pick('المزيد', 'More')} onClick={() => setSheet('settings')}><MoreHorizontal size={25} /></Tool>
        <Tool id="studio-end" label={pick('إنهاء', 'End')} danger onClick={() => setSheet('end')}><Power size={24} /></Tool>
      </div>}
      {!live && <div className={styles.modeTabs}><span><Camera size={15} />{pick('كاميرا الجهاز', 'Device camera')}</span><strong>LIVE</strong><button type="button" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} aria-label={pick('Switch to English', 'التبديل إلى العربية')}><Globe2 size={15} />{locale === 'ar' ? 'EN' : 'عربي'}</button></div>}
    </div>
    {sheet && <BottomSheet title={sheet === 'end' ? pick(live ? 'إنهاء البث المباشر؟' : 'مغادرة الاستوديو؟', live ? 'End your live stream?' : 'Leave the studio?') : sheet === 'audience' ? pick('المشاهدون', 'Your viewers') : sheet === 'share' ? pick('شارك اللحظة', 'Share the moment') : sheet === 'category' ? pick('اختر تصنيف البث', 'Choose a category') : pick('أدوات البث', 'Stream controls')} close={closeSheet}>
      {sheet === 'end' && <><div className={styles.endIcon}><Power size={27} /></div><p className={styles.sheetDescription}>{pick(stream ? 'سيتوقف الصوت والفيديو ويُغلق بثك للمشاهدين.' : 'ستُغلق الكاميرا والميكروفون عند المغادرة.', stream ? 'Your camera and audio will stop and the stream will close for viewers.' : 'Your camera and microphone will close when you leave.')}</p>{error && <p role="alert" className={styles.inlineError}>{error}</p>}<button data-testid="studio-confirm-end" className={styles.startButton} disabled={phase === 'end'} onClick={() => { void end(true); }}>{phase === 'end' ? <LoaderCircle className="spin" size={20} /> : <Power size={19} />}{pick(stream ? 'إنهاء البث والمغادرة' : 'إغلاق الاستوديو', stream ? 'End stream and leave' : 'Close studio')}</button><button className={styles.secondaryButton} onClick={closeSheet}>{pick('البقاء هنا', 'Stay here')}</button></>}
      {sheet === 'category' && <div className={styles.categoryList}>{categories.map(([value, label]) => <button key={value} type="button" className={category === value ? styles.selectedCategory : ''} onClick={() => { setCategory(value); closeSheet(); }}><span>{label}</span>{category === value && <Check size={20} />}</button>)}</div>}
      {sheet === 'audience' && <><div className={styles.audienceNumber}><Users size={30} /><strong>{live ? stream?.viewerCount ?? '—' : 0}</strong></div><p className={styles.sheetDescription}>{pick(live ? 'عدد المشاهدين المتصلين بخدمة البث الآن. قد يستغرق تحديثه بضع ثوانٍ.' : 'سيظهر عدد المشاهدين الفعلي عند بدء بثك.', live ? 'Viewers currently connected to the media service. Updates can take a few seconds.' : 'Your actual viewer count appears when you go live.')}</p></>}
      {sheet === 'share' && <><p className={styles.sheetDescription}>{pick('أرسل الرابط ودع الآخرين ينضمون إلى بثك.', 'Send the link and invite people to your live stream.')}</p><input className={styles.shareInput} readOnly value={shareUrl} aria-label={pick('رابط البث', 'Stream link')} onFocus={event => event.currentTarget.select()} /><button className={styles.startButton} onClick={() => { void share(); }}>{copied ? <Check size={20} /> : <Share2 size={20} />}{pick(copied ? 'تم نسخ الرابط' : 'مشاركة الرابط', copied ? 'Link copied' : 'Share link')}</button><button className={styles.secondaryButton} onClick={() => { void navigator.clipboard.writeText(shareUrl).then(() => setCopied(true)).catch(() => setNotice(pick('حدد الرابط وانسخه من الحقل.', 'Select and copy the link from the field.'))); }}><Copy size={16} />{pick('نسخ الرابط', 'Copy link')}</button></>}
      {sheet === 'settings' && <div className={styles.settings}>
        <p className={styles.sheetDescription}>{pick('تحكم بما ترسله من جهازك إلى البث.', 'Control what your device sends to the stream.')}</p>
        <label>{pick('الكاميرا', 'Camera')}<select aria-label={pick('اختيار الكاميرا', 'Select camera')} value={activeCamera} onChange={event => { void changeDevice('video', event.target.value); }} disabled={!previewReady || busy || switching}>{!cameras.length && <option value="">{pick('شغّل المعاينة أولًا', 'Enable preview first')}</option>}{cameras.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || pick('كاميرا ', 'Camera ') + (index + 1)}</option>)}</select></label>
        <label>{pick('الميكروفون', 'Microphone')}<select aria-label={pick('اختيار الميكروفون', 'Select microphone')} value={activeMic} onChange={event => { void changeDevice('audio', event.target.value); }} disabled={!previewReady || busy || switching}>{!microphones.length && <option value="">{pick('شغّل المعاينة أولًا', 'Enable preview first')}</option>}{microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || pick('ميكروفون ', 'Microphone ') + (index + 1)}</option>)}</select></label>
        <label className={styles.checkRow}><input type="checkbox" checked={showChat} onChange={event => setShowChat(event.target.checked)} /><span>{pick('إظهار المحادثة على شاشتي', 'Show chat on my screen')}</span><MessageCircle size={18} /></label>
        <button className={styles.settingsRow} onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}><Globe2 size={19} />{pick('اللغة: العربية', 'Language: English')}<span>{locale === 'ar' ? 'EN' : 'عربي'}</span></button>
        <Link className={styles.settingsRow} href="/terms" target="_blank" rel="noopener noreferrer"><ShieldCheck size={19} />{pick('الشروط وإرشادات المشاركة', 'Terms and sharing guidelines')}<ExternalLink size={15} /></Link>
        <p className={styles.deviceHelp}>{pick('كتم الكاميرا يوقف إرسال الفيديو. إغلاق الاستوديو يوقف أجهزة الالتقاط.', 'Pausing the camera stops sending video. Closing the studio releases your capture devices.')}</p>
      </div>}
    </BottomSheet>}
  </div>;
}
