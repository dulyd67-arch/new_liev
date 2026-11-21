'use client';

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { LoaderCircle, RefreshCw, Volume2, VolumeX, VideoOff } from 'lucide-react';
import { Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack, type RemoteTrackPublication } from 'livekit-client';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import type { StreamToken } from '@/lib/streams';
import styles from './opponent-feed.module.css';

export interface OpponentFeedHandle { startAudio: () => Promise<void>; }

/** A second subscribe-only connection. The broadcaster keeps publishing to their own room. */
export function OpponentFeed({ streamId, creatorId, displayName, side, testId, muted = false, ref }: {
  streamId: string; creatorId: string; displayName: string; side: 'host' | 'guest'; testId: string;
  muted?: boolean; ref?: Ref<OpponentFeedHandle>;
}) {
  const { request } = useAuth(); const { pick } = useLocale();
  const video = useRef<HTMLVideoElement>(null); const audio = useRef<HTMLDivElement>(null); const room = useRef<Room | null>(null);
  const mutedRef = useRef(muted); mutedRef.current = muted;
  const [hasVideo, setHasVideo] = useState(false); const [state, setState] = useState('connecting');
  const [blocked, setBlocked] = useState(false); const [audioError, setAudioError] = useState(false); const [retry, setRetry] = useState(0);
  const [locallyMuted, setLocallyMuted] = useState(false); const localMutedRef = useRef(false);
  async function startAudio() {
    await room.current?.startAudio(); setBlocked(false); setAudioError(false);
  }
  useImperativeHandle(ref, () => ({ startAudio }));
  useEffect(() => {
    let stopped = false; let expired = false; const controller = new AbortController();
    const current = new Room({ adaptiveStream: true }); room.current = current;
    const videoElement = video.current; const audioContainer = audio.current;
    setHasVideo(false); setState('connecting'); setBlocked(false); setAudioError(false);
    const subscribed = (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (stopped || expired || participant.identity !== creatorId) return;
      if (track.kind === Track.Kind.Video && videoElement) { track.attach(videoElement); setHasVideo(!track.isMuted); }
      if (track.kind === Track.Kind.Audio && audioContainer) {
        const element = track.attach() as HTMLAudioElement; element.muted = mutedRef.current || localMutedRef.current;
        element.setAttribute('data-stream-audio', 'true'); element.setAttribute('data-stream-id', streamId); audioContainer.append(element);
      }
    };
    current.on(RoomEvent.TrackSubscribed, subscribed);
    current.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => { track.detach().forEach(element => { if (element.tagName === 'AUDIO') element.remove(); }); if (!stopped && !expired && participant.identity === creatorId && track.kind === Track.Kind.Video) setHasVideo(false); });
    current.on(RoomEvent.TrackMuted, (publication, participant) => { if (!stopped && !expired && participant.identity === creatorId && publication.kind === Track.Kind.Video) setHasVideo(false); });
    current.on(RoomEvent.TrackUnmuted, (publication, participant) => { if (!stopped && !expired && participant.identity === creatorId && publication.kind === Track.Kind.Video && publication.track) setHasVideo(true); });
    current.on(RoomEvent.Reconnecting, () => { if (!stopped && !expired) setState('reconnecting'); });
    current.on(RoomEvent.Reconnected, () => { if (!stopped && !expired) setState('connected'); });
    current.on(RoomEvent.Disconnected, () => { if (!stopped) { setState('failed'); setHasVideo(false); } });
    current.on(RoomEvent.AudioPlaybackStatusChanged, () => { if (!stopped && !expired) setBlocked(!current.canPlaybackAudio); });
    const deadline = setTimeout(() => { if (!stopped && current.state !== 'connected') { expired = true; controller.abort(); setState('failed'); void current.disconnect(); } }, 35000);
    void (async () => {
      try {
        const token = await request<StreamToken>(`/streams/${streamId}/token`, { method: 'POST', auth: false, signal: controller.signal });
        if (stopped || expired) return;
        await current.connect(token.url, token.token);
        if (stopped || expired) { await current.disconnect(); return; }
        clearTimeout(deadline); setState('connected'); setBlocked(!current.canPlaybackAudio);
      } catch { clearTimeout(deadline); expired = true; controller.abort(); await current.disconnect(); if (!stopped) { setState('failed'); setHasVideo(false); } }
    })();
    return () => { stopped = true; controller.abort(); clearTimeout(deadline); void current.disconnect(); audioContainer?.replaceChildren(); if (room.current === current) room.current = null; };
  }, [request, streamId, creatorId, retry]);
  useEffect(() => { audio.current?.querySelectorAll('audio').forEach(element => { element.muted = muted || locallyMuted; }); }, [muted, locallyMuted]);
  async function audioAction() {
    if (blocked) { try { await startAudio(); } catch { setAudioError(true); } return; }
    const next = !localMutedRef.current; localMutedRef.current = next; setLocallyMuted(next);
  }
  return <div className={`${styles.tile} ${side === 'host' ? styles.host : styles.guest}`} data-testid={testId + '-tile'} data-stream-id={streamId}>
    <video ref={video} muted autoPlay playsInline className={styles.video} data-testid={testId} data-stream-id={streamId} aria-label={pick('فيديو ', 'Video of ') + displayName} />
    <div ref={audio} hidden />
    {!hasVideo && <div className={styles.placeholder} role="status">{state === 'connecting' || state === 'reconnecting' ? <LoaderCircle size={23} className="spin" /> : <VideoOff size={25} />}<span>{pick(state === 'failed' ? 'تعذّر اتصال الخصم' : state === 'connected' ? 'كاميرا الخصم متوقفة' : 'نتصل بالخصم…', state === 'failed' ? 'Opponent connection unavailable' : state === 'connected' ? 'Opponent camera is paused' : 'Connecting to opponent…')}</span>{state === 'failed' && <button type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />{pick('إعادة الاتصال', 'Reconnect')}</button>}</div>}
    <strong className={styles.name}>{displayName}</strong>
    {state === 'connected' && <button type="button" className={styles.audio} onClick={() => { void audioAction(); }} aria-label={pick(blocked ? 'تشغيل صوت الخصم' : locallyMuted ? 'إلغاء كتم الخصم' : 'كتم صوت الخصم', blocked ? 'Enable opponent audio' : locallyMuted ? 'Unmute opponent' : 'Mute opponent')} data-testid={testId + '-audio'}>{muted || locallyMuted ? <VolumeX size={17} /> : <Volume2 size={17} />}{blocked && <small>{pick('الصوت', 'Sound')}</small>}</button>}
    {audioError && <span className={styles.audioError} role="status">{pick('اضغط مجددًا لتشغيل الصوت', 'Tap again to enable audio')}</span>}
  </div>;
}
