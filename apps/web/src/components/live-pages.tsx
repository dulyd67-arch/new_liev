'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, MessageCircle, Radio, Send, Share2, Square, Users, VideoOff, Volume2, Wifi } from 'lucide-react';
import { Room, RoomEvent, Track, type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant } from 'livekit-client';
import { ApiError, useAuth, useErrorMessage } from '@/lib/auth';
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

export { StudioPage } from './studio-page';

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
