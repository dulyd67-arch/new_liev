'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Copy, LoaderCircle, MessageCircle, Mic, MicOff, Radio, Send, Share2, Square, Users, Video, VideoOff, Volume2, Wifi } from 'lucide-react';
import { Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from 'livekit-client';
import { ApiError, RequireAuth, useAuth, useErrorMessage } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import type { LiveStream, StreamMessage, StreamToken } from '@/lib/streams';

function Chat({ streamId, live }: { streamId: string; live: boolean }) {
  const { user, request } = useAuth(); const { pick, locale } = useLocale(); const errorMessage = useErrorMessage();
  const [items, setItems] = useState<StreamMessage[]>([]); const [body, setBody] = useState('');
  const [error, setError] = useState(''); const [sending, setSending] = useState(false); const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try { const result = await request<{ items: StreamMessage[] }>(`/streams/${streamId}/messages`, { auth: false }); if (active) setItems(result.items); }
      catch { /* Keep already loaded messages when the connection is interrupted. */ }
    };
    void load(); const interval = window.setInterval(() => { void load(); }, 2500);
    return () => { active = false; clearInterval(interval); };
  }, [streamId, request]);
  useEffect(() => { const list = end.current?.parentElement; if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' }); }, [items.length]);
  async function send(event: FormEvent) {
    event.preventDefault(); if (!body.trim() || sending) return; setSending(true); setError('');
    try { const message = await request<StreamMessage>(`/streams/${streamId}/messages`, { method: 'POST', body: JSON.stringify({ body: body.trim() }) }); setItems(previous => previous.some(item => item.id === message.id) ? previous : [...previous, message].slice(-100)); setBody(''); }
    catch (failure) { setError(failure instanceof ApiError && failure.status === 409 ? pick('انتهى البث، ولم تعد المحادثة متاحة للإرسال.', 'This stream has ended and no longer accepts messages.') : errorMessage(failure)); } finally { setSending(false); }
  }
  return <section className="card chat-panel" aria-label={pick('المحادثة المباشرة', 'Live chat')}><div className="chat-header"><MessageCircle size={18} />{pick('المحادثة المباشرة', 'Live chat')}<span className="live-dot" /></div><div className="chat-messages" role="log" aria-live="polite" aria-relevant="additions">
    {items.length ? items.map(item => <div key={item.id} className="chat-message"><strong>{item.sender.displayName}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}</time><p>{item.body}</p></div>) : <div className="chat-empty"><MessageCircle size={30} strokeWidth={1} /><span>{pick('ابدأ الحديث. اللحظات أجمل معاً.', 'Say hello. Moments are better together.')}</span></div>}<div ref={end} />
  </div><div className="chat-compose">{user ? <form onSubmit={send}><div className="chat-input-row"><input value={body} maxLength={500} onChange={event => setBody(event.target.value)} placeholder={pick(live ? 'شارك في الحديث…' : 'انتهى البث', live ? 'Join the conversation…' : 'This stream has ended')} data-testid="chat-input" aria-label={pick('رسالتك', 'Your message')} disabled={!live || sending} /><button data-testid="chat-send" type="submit" disabled={!live || sending || !body.trim()} aria-label={pick('إرسال الرسالة', 'Send message')}>{sending ? <LoaderCircle size={16} className="spin" /> : <Send size={17} />}</button></div>{error && <p role="alert" className="chat-error">{error}</p>}</form> : <p className="chat-login"><Link href={`/login?returnTo=${encodeURIComponent(`/live/${streamId}`)}`}>{pick('سجّل الدخول', 'Sign in')}</Link>{pick(' للمشاركة في المحادثة.', ' to join the conversation.')}</p>}</div></section>;
}

function ShareButton({ streamId }: { streamId: string }) {
  const { pick } = useLocale(); const [copied, setCopied] = useState(false); const [fallback, setFallback] = useState('');
  async function share() {
    const url = new URL(`/live/${streamId}`, window.location.origin).toString();
    try { await navigator.clipboard.writeText(url); setCopied(true); window.setTimeout(() => setCopied(false), 3000); }
    catch { setFallback(url); }
  }
  return <div><button className="button secondary small" onClick={() => { void share(); }}>{copied ? <Check size={15} /> : <Share2 size={15} />}{pick(copied ? 'تم نسخ الرابط' : 'مشاركة البث', copied ? 'Link copied' : 'Share stream')}</button><Link data-testid="studio-sharelink" className="share-watch-link" href={`/live/${streamId}`} target="_blank" rel="noopener noreferrer">{pick('فتح صفحة المشاهدة', 'Open watch page')}</Link>{fallback && <p className="share-notice"><a href={fallback}>{fallback}</a></p>}</div>;
}

export function StudioPage() { return <RequireAuth><Studio /></RequireAuth>; }

function Studio() {
  const { request } = useAuth(); const { pick } = useLocale(); const genericError = useErrorMessage();
  const [title, setTitle] = useState(''); const [category, setCategory] = useState('chat');
  const [stream, setStream] = useState<LiveStream | null>(null); const [previewReady, setPreviewReady] = useState(false);
  const [micOn, setMicOn] = useState(true); const [cameraOn, setCameraOn] = useState(true);
  const [busy, setBusy] = useState(false); const [live, setLive] = useState(false); const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const video = useRef<HTMLVideoElement>(null); const media = useRef<MediaStream | null>(null); const room = useRef<Room | null>(null);
  const ownedStream = useRef<string | null>(null); const streamRef = useRef<LiveStream | null>(null);
  useEffect(() => { streamRef.current = stream; }, [stream]);
  useEffect(() => {
    let active = true;
    void request<{ stream: LiveStream | null }>('/streams/mine').then(result => { if (active && result.stream) { setStream(result.stream); setTitle(result.stream.title); setCategory(result.stream.category || 'chat'); } }).catch(() => undefined);
    return () => { active = false; };
  }, [request]);
  useEffect(() => {
    const cleanup = () => {
      media.current?.getTracks().forEach(track => track.stop());
      void room.current?.disconnect();
      const id = ownedStream.current; ownedStream.current = null;
      if (id) void request(`/streams/${id}/end`, { method: 'POST', keepalive: true }).catch(() => undefined);
    };
    window.addEventListener('pagehide', cleanup);
    return () => { window.removeEventListener('pagehide', cleanup); cleanup(); };
  }, [request]);
  async function preview() {
    setBusy(true); setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('MEDIA_UNAVAILABLE');
      media.current?.getTracks().forEach(track => track.stop());
      const capture = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: true });
      media.current = capture; setCameraOn(true); setMicOn(true);
      if (video.current) { video.current.srcObject = capture; await video.current.play(); }
      setPreviewReady(true);
    } catch { setError(pick('تعذر الوصول إلى الكاميرا أو الميكروفون. اسمح باستخدامهما من إعدادات المتصفح، وافتح الموقع عبر اتصال آمن.', 'Unable to access your camera or microphone. Allow them in your browser settings and open the site over a secure connection.')); }
    finally { setBusy(false); }
  }
  async function start(event: FormEvent) {
    event.preventDefault(); if (!previewReady || !media.current || busy) return; setBusy(true); setError('');
    let current = streamRef.current;
    try {
      let credentials: StreamToken;
      if (current) credentials = await request<StreamToken>(`/streams/${current.id}/host-token`, { method: 'POST' });
      else { const created = await request<{ stream: LiveStream } & StreamToken>('/streams', { method: 'POST', body: JSON.stringify({ title: title.trim(), category }) }); current = created.stream; setStream(current); streamRef.current = current; credentials = created; }
      ownedStream.current = current.id;
      const connection = new Room({ adaptiveStream: true, dynacast: true }); room.current = connection;
      connection.on(RoomEvent.Reconnecting, () => setConnected(false));
      connection.on(RoomEvent.Reconnected, () => setConnected(true));
      connection.on(RoomEvent.Disconnected, () => { setConnected(false); setLive(false); });
      await connection.connect(credentials.url, credentials.token);
      for (const track of media.current.getTracks()) await connection.localParticipant.publishTrack(track, { source: track.kind === 'video' ? Track.Source.Camera : Track.Source.Microphone });
      if (!cameraOn) await connection.localParticipant.setCameraEnabled(false);
      if (!micOn) await connection.localParticipant.setMicrophoneEnabled(false);
      const active = await request<LiveStream>(`/streams/${current.id}/activate`, { method: 'POST' }); setStream(active); setLive(true); setConnected(true);
    } catch (failure) {
      void room.current?.disconnect(); room.current = null;
      if (ownedStream.current) { const id = ownedStream.current; ownedStream.current = null; await request(`/streams/${id}/end`, { method: 'POST' }).catch(() => undefined); setStream(null); streamRef.current = null; }
      media.current?.getTracks().forEach(track => track.stop()); media.current = null; setPreviewReady(false);
      setError(failure instanceof ApiError && failure.status === 409 ? pick('لديك بث نشط بالفعل. حدّث الصفحة لاستعادته أو أنهِ البث السابق.', 'You already have an active stream. Refresh to resume it, or end the previous stream.') : failure instanceof ApiError ? genericError(failure) : pick('تعذر الاتصال بخدمة البث. تحقق من اتصالك وحاول مجدداً.', 'Unable to connect to the streaming service. Check your connection and try again.'));
    } finally { setBusy(false); }
  }
  async function end() {
    if (!stream || busy) return; setBusy(true); setError('');
    try { await request(`/streams/${stream.id}/end`, { method: 'POST' }); ownedStream.current = null; await room.current?.disconnect(); room.current = null; media.current?.getTracks().forEach(track => track.stop()); media.current = null; setLive(false); setConnected(false); setPreviewReady(false); setStream(null); streamRef.current = null; }
    catch (failure) { setError(genericError(failure)); } finally { setBusy(false); }
  }
  async function toggle(kind: 'audio' | 'video') {
    const enabled = kind === 'audio' ? !micOn : !cameraOn;
    if (room.current && live) {
      if (kind === 'audio') await room.current.localParticipant.setMicrophoneEnabled(enabled);
      else await room.current.localParticipant.setCameraEnabled(enabled);
    } else media.current?.getTracks().filter(track => track.kind === kind).forEach(track => { track.enabled = enabled; });
    if (kind === 'audio') setMicOn(enabled); else setCameraOn(enabled);
  }
  return <div><div className="page-heading"><div><p className="eyebrow">{pick('مكانك أمام الكاميرا', 'YOUR PLACE IN FRONT OF THE CAMERA')}</p><h1>{pick('استوديو البث', 'Your live studio')}</h1><p className="muted">{pick('جهّز الكاميرا والصوت، وأخبر العالم بما تحب.', 'Check your camera and sound, and share what you love.')}</p></div><div className="icon-orb"><Video size={25} /></div></div>
    <div className="studio-grid"><div><div className="video-stage preview"><video ref={video} autoPlay muted playsInline aria-label={pick('معاينة الكاميرا', 'Camera preview')} />{!previewReady && <div className="stage-placeholder"><Video size={43} strokeWidth={1} /><p>{pick('الكاميرا مغلقة. شغّل المعاينة عندما تكون مستعداً.', 'Your camera is off. Start the preview when you are ready.')}</p><button type="button" data-testid="studio-preview" className="button secondary" onClick={() => { void preview(); }} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Video size={17} />}{pick('تشغيل الكاميرا والميكروفون', 'Enable camera and microphone')}</button></div>}{live && <span className="stage-status"><span className="live-dot" />{pick(connected ? 'أنت على الهواء' : 'جارٍ إعادة الاتصال', connected ? 'YOU ARE LIVE' : 'RECONNECTING')}</span>}</div><div className="camera-controls"><button className={`control-button ${!micOn ? 'off' : ''}`} disabled={!previewReady || busy} onClick={() => { void toggle('audio').catch(() => setError(pick('تعذر تغيير الميكروفون.', 'Unable to change microphone.'))); }} aria-label={pick(micOn ? 'كتم الميكروفون' : 'تشغيل الميكروفون', micOn ? 'Mute microphone' : 'Enable microphone')}>{micOn ? <Mic size={20} /> : <MicOff size={20} />}</button><button className={`control-button ${!cameraOn ? 'off' : ''}`} disabled={!previewReady || busy} onClick={() => { void toggle('video').catch(() => setError(pick('تعذر تغيير الكاميرا.', 'Unable to change camera.'))); }} aria-label={pick(cameraOn ? 'إيقاف الكاميرا' : 'تشغيل الكاميرا', cameraOn ? 'Disable camera' : 'Enable camera')}>{cameraOn ? <Video size={20} /> : <VideoOff size={20} />}</button></div><p className="video-help">{pick('لن يبدأ البث حتى تضغط «ابدأ البث». احتفظ بهذه الصفحة مفتوحة أثناء البث.', 'You will only go live after selecting “Go live”. Keep this page open while broadcasting.')}</p>{error && <p className="form-error" role="alert">{error}</p>}{live && stream && <div className="studio-live-note"><p><Radio size={14} style={{ display: 'inline', marginInlineEnd: 7 }} />{pick('بثك متاح للمشاهدة الآن.', 'Your stream is ready for viewers.')}</p><ShareButton streamId={stream.id} /></div>}</div>
      <div className="card studio-settings"><h2>{pick(live ? 'تفاصيل بثك' : stream ? 'استعد لبثك السابق' : 'تفاصيل البث', live ? 'Your stream' : stream ? 'Resume your stream' : 'Stream details')}</h2><form className="form-stack" onSubmit={start}><label className="field">{pick('عنوان البث', 'Stream title')}<input data-testid="studio-title" value={title} onChange={event => setTitle(event.target.value)} placeholder={pick('ما الذي تود مشاركته؟', 'What would you like to share?')} required maxLength={160} minLength={1} disabled={live || !!stream} /></label><label className="field">{pick('التصنيف', 'Category')}<select value={category} onChange={event => setCategory(event.target.value)} disabled={live || !!stream}><option value="chat">{pick('دردشة', 'Just chatting')}</option><option value="music">{pick('موسيقى', 'Music')}</option><option value="gaming">{pick('ألعاب', 'Gaming')}</option><option value="talent">{pick('مواهب', 'Talent')}</option></select></label>{live ? <button data-testid="studio-end" type="button" className="button danger" onClick={() => { void end(); }} disabled={busy}><Square size={15} fill="currentColor" />{pick('إنهاء البث', 'End stream')}</button> : <button data-testid="studio-start" className="button gold" type="submit" disabled={!previewReady || !title.trim() || busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <Radio size={18} />}{pick(stream ? 'استئناف البث' : 'ابدأ البث', stream ? 'Resume stream' : 'Go live')}</button>}{stream && !live && <button type="button" className="button secondary small" onClick={() => { void end(); }} disabled={busy}>{pick('إلغاء البث السابق', 'Close previous stream')}</button>}</form><p className="video-help">{pick('شارك باحترام. لا تبث محتوى لا تملك حق مشاركته.', 'Share respectfully. Only broadcast content you have the right to share.')}</p></div>
    </div>{live && stream && <div className="section"><Chat streamId={stream.id} live /></div>}
  </div>;
}

export function WatchPage({ id }: { id: string }) {
  const { user, request } = useAuth(); const { pick } = useLocale(); const errorMessage = useErrorMessage();
  const [stream, setStream] = useState<LiveStream | null>(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [ending, setEnding] = useState(false);
  const [connection, setConnection] = useState('connecting'); const [hasVideo, setHasVideo] = useState(false); const [audioBlocked, setAudioBlocked] = useState(false);
  const video = useRef<HTMLVideoElement>(null); const audio = useRef<HTMLDivElement>(null); const room = useRef<Room | null>(null);
  useEffect(() => {
    let active = true;
    const load = async () => { try { const result = await request<LiveStream>(`/streams/${id}`, { auth: false }); if (active) { setStream(result); setError(''); } } catch (failure) { if (active) setError(errorMessage(failure)); } finally { if (active) setLoading(false); } };
    void load(); const interval = window.setInterval(() => { void load(); }, 10000);
    return () => { active = false; clearInterval(interval); };
  }, [id, request, errorMessage]);
  const live = stream?.status === 'LIVE';
  useEffect(() => {
    if (!live) { void room.current?.disconnect(); setConnection('disconnected'); return; }
    let cancelled = false; const connection = new Room({ adaptiveStream: true }); room.current = connection; setConnection('connecting');
    const refreshMetadata = async () => { try { const result = await request<LiveStream>(`/streams/${id}`, { auth: false }); if (!cancelled) setStream(result); } catch { /* The existing polling loop also retries metadata. */ } };
    const subscribed = (track: RemoteTrack, _publication: RemoteTrackPublication, _participant: RemoteParticipant) => {
      if (track.kind === Track.Kind.Video && video.current) { track.attach(video.current); setHasVideo(true); }
      else if (track.kind === Track.Kind.Audio && audio.current) { const element = track.attach(); element.setAttribute('data-stream-audio', 'true'); audio.current.append(element); }
    };
    connection.on(RoomEvent.TrackSubscribed, subscribed);
    connection.on(RoomEvent.TrackUnsubscribed, track => { track.detach().forEach(element => { if (element.tagName === 'AUDIO') element.remove(); }); if (track.kind === Track.Kind.Video) setHasVideo(false); });
    connection.on(RoomEvent.Reconnecting, () => setConnection('reconnecting'));
    connection.on(RoomEvent.Reconnected, () => setConnection('connected'));
    connection.on(RoomEvent.Disconnected, () => { if (!cancelled) { setConnection('disconnected'); setHasVideo(false); void refreshMetadata(); } });
    connection.on(RoomEvent.ParticipantConnected, () => { void refreshMetadata(); });
    connection.on(RoomEvent.ParticipantDisconnected, () => { void refreshMetadata(); });
    connection.on(RoomEvent.AudioPlaybackStatusChanged, () => setAudioBlocked(!connection.canPlaybackAudio));
    void (async () => {
      try { const credentials = await request<StreamToken>(`/streams/${id}/token`, { method: 'POST', auth: false }); if (cancelled) return; await connection.connect(credentials.url, credentials.token); if (cancelled) { await connection.disconnect(); return; } setConnection('connected'); setAudioBlocked(!connection.canPlaybackAudio); void refreshMetadata(); }
      catch { if (!cancelled) setConnection('failed'); }
    })();
    return () => { cancelled = true; void connection.disconnect(); audio.current?.replaceChildren(); setHasVideo(false); };
  }, [id, live, request]);
  async function end() { setEnding(true); try { const result = await request<LiveStream>(`/streams/${id}/end`, { method: 'POST' }); setStream(result); } catch (failure) { setError(errorMessage(failure)); } finally { setEnding(false); } }
  if (loading) return <div className="card empty-state" role="status"><LoaderCircle className="spin" /><p>{pick('جارٍ تحميل البث…', 'Loading live stream…')}</p></div>;
  if (!stream) return <div className="card empty-state"><Radio size={32} /><h1>{pick('هذا البث غير متاح', 'This stream is unavailable')}</h1><p className="muted">{error || pick('ربما انتهى البث أو تغير الرابط.', 'The stream may have ended or the link may have changed.')}</p><Link href="/" className="button gold">{pick('اكتشف بثوثاً أخرى', 'Explore other streams')}</Link></div>;
  return <div className="watch-layout"><div><div className="video-stage"><video ref={video} muted autoPlay playsInline data-testid="watch-video" aria-label={pick('فيديو البث المباشر', 'Live stream video')} /><div ref={audio} hidden />{(!live || !hasVideo) && <div className="stage-placeholder">{live ? <Radio size={42} strokeWidth={1} /> : <VideoOff size={40} strokeWidth={1} />}<p>{pick(!live ? 'انتهى هذا البث. شكراً لمشاركتك اللحظة.' : connection === 'failed' ? 'تعذر الاتصال بالبث. أعد تحميل الصفحة للمحاولة مجدداً.' : connection === 'connecting' || connection === 'reconnecting' ? 'جارٍ الاتصال بالبث…' : 'بانتظار صورة المذيع. يمكنك الاستماع والمشاركة في الحديث.', !live ? 'This stream has ended. Thanks for sharing the moment.' : connection === 'failed' ? 'Unable to connect. Reload the page to try again.' : connection === 'connecting' || connection === 'reconnecting' ? 'Connecting to the stream…' : 'Waiting for the broadcaster’s video. You can listen and join the chat.')}</p></div>}{live && <span className="stage-status"><span className="live-dot" />{pick('مباشر', 'LIVE')}</span>}{audioBlocked && live && <button className="audio-toggle" onClick={() => { void room.current?.startAudio().then(() => setAudioBlocked(false)); }}><Volume2 size={18} />{pick('تشغيل الصوت', 'Enable audio')}</button>}</div><div className="stream-info"><div><h1>{stream.title}</h1><Link href={`/u/${stream.creator.username}`} className="creator-line"><span className="avatar">{stream.creator.displayName.slice(0,1)}</span>{stream.creator.displayName}</Link></div><div className="stream-info-actions"><span className="count-pill"><Users size={15} />{stream.viewerCount ?? '—'} {pick('مشاهد', 'watching')}</span><ShareButton streamId={stream.id} />{live && user?.id === stream.creator.id && <button className="button danger small" onClick={() => { void end(); }} disabled={ending}><Square size={13} />{pick('إنهاء البث', 'End stream')}</button>}</div></div>{live && <div className="connection-note"><Wifi size={14} />{pick(connection === 'connected' ? 'متصل بالبث المباشر' : connection === 'reconnecting' ? 'جارٍ إعادة الاتصال…' : 'جارٍ الاتصال…', connection === 'connected' ? 'Connected to the live stream' : connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…')}</div>}{error && <p className="form-error" role="alert">{error}</p>}</div><Chat streamId={id} live={live} /></div>;
}
