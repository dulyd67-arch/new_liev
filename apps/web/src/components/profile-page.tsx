'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowLeft, AudioLines, Check, Clock3, Globe2, ImagePlus, LoaderCircle, Play, Radio, RefreshCw, Settings2, Share2, ShieldCheck, Trash2, UserPlus, Users, Video, Wallet, X } from 'lucide-react';
import { ApiError, useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import type { LiveStream } from '@/lib/streams';
import { firstInitial, prepareAvatar, safeAvatarSource, type PageResult, type PastStream, type ProfileMember, type PublicProfile } from '@/lib/profiles';
import styles from './profile.module.css';

function Avatar({ name, source, className = '' }: { name: string; source?: string | null; className?: string }) {
  const src = safeAvatarSource(source);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return <span className={`${styles.avatar} ${className}`} aria-hidden="true">{src && !failed ? <img src={src} alt="" className={styles.avatarImage} decoding="async" onError={() => setFailed(true)} /> : <span className={styles.avatarInitial}>{firstInitial(name)}</span>}</span>;
}

function Dialog({ title, children, close, dismissible = true, testId }: { title: string; children: ReactNode; close: () => void; dismissible?: boolean; testId: string }) {
  const { pick } = useLocale();
  const element = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = element.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog?.showModal();
    return () => { dialog?.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={element} className={styles.dialog} data-testid={testId} aria-label={title} onCancel={event => { event.preventDefault(); if (dismissible) close(); }}>
    <div className={styles.dialogHeader}><h2 className={styles.dialogTitle}>{title}</h2><button type="button" className={styles.closeButton} onClick={close} disabled={!dismissible} aria-label={pick('إغلاق', 'Close')}><X size={21} /></button></div>
    {children}
  </dialog>;
}

function EditProfile({ profile, close, saved }: { profile: PublicProfile; close: () => void; saved: () => void }) {
  const { request, refreshUser } = useAuth(); const { pick } = useLocale();
  const [name, setName] = useState(profile.displayName); const [bio, setBio] = useState(profile.bio || '');
  const [photo, setPhoto] = useState<string | null | undefined>(undefined);
  const [picking, setPicking] = useState(false); const [saving, setSaving] = useState(false); const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null); const generation = useRef(0); const active = useRef(true); const controller = useRef<AbortController | null>(null);
  const preview = photo === undefined ? profile.avatarUrl : photo;
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; controller.current?.abort(); }; }, []);
  async function choose(file?: File) {
    if (!file) return;
    const current = ++generation.current; setPicking(true); setError('');
    try { const image = await prepareAvatar(file); if (active.current && current === generation.current) setPhoto(image); }
    catch (failure) {
      if (active.current && current === generation.current) setError(failure instanceof Error ? failure.message : 'AVATAR_DECODE');
    } finally { if (active.current && current === generation.current) setPicking(false); if (input.current) input.current.value = ''; }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (saving || picking || !name.trim()) return;
    setSaving(true); setError(''); const abort = new AbortController(); controller.current = abort;
    const deadline = setTimeout(() => abort.abort(), 20_000);
    try {
      await request('/users/me', { method: 'PATCH', signal: abort.signal, body: JSON.stringify({ displayName: name.trim(), bio: bio.trim() || null, ...(photo !== undefined ? { avatarDataUrl: photo } : {}) }) });
      // The profile has committed even if the subsequent session refresh fails.
      await refreshUser().catch(() => undefined);
      if (active.current) saved();
    } catch { if (active.current) setError('SAVE'); }
    finally { clearTimeout(deadline); if (active.current) setSaving(false); }
  }
  const errorText = error === 'AVATAR_TYPE' ? pick('اختر صورة بصيغة JPG أو PNG أو WebP.', 'Choose a JPG, PNG or WebP image.')
    : error === 'AVATAR_SIZE' ? pick('اختر صورة أصغر من 2 ميغابايت، أو جرّب صورة أبسط.', 'Choose an image under 2 MB, or try a simpler photo.')
      : error === 'AVATAR_DECODE' ? pick('تعذّر فتح هذه الصورة. جرّب صورة أخرى.', 'We couldn’t open this image. Try another photo.')
        : pick('تعذّر حفظ التغييرات. تحقق من اتصالك وحاول مجددًا.', 'We couldn’t save your changes. Check your connection and try again.');
  return <Dialog title={pick('تعديل الملف الشخصي', 'Edit profile')} close={close} dismissible={!saving && !picking} testId="profile-edit-dialog">
    <form onSubmit={submit}>
      <div className={styles.dialogBody}>
        <div className={styles.editorAvatarRow}><Avatar name={name || profile.displayName} source={preview} className={styles.editorPhoto} /><div className={styles.photoTools}>
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className={styles.fileInput} tabIndex={-1} data-testid="profile-edit-avatar" aria-label={pick('اختيار الصورة الشخصية', 'Choose profile photo')} disabled={saving || picking} onChange={event => { void choose(event.target.files?.[0]); }} />
          <button type="button" className={styles.secondaryButton} onClick={() => input.current?.click()} disabled={saving || picking}>{picking ? <LoaderCircle size={17} className={styles.spinner} /> : <ImagePlus size={17} />}{pick('تغيير الصورة', 'Change photo')}</button>
          <button type="button" className={styles.iconButton} data-testid="profile-remove-avatar" disabled={!preview || saving || picking} onClick={() => { setPhoto(null); setError(''); }}><Trash2 size={16} />{pick('إزالة', 'Remove')}</button>
        </div></div>
        <p className={styles.fieldHint}>{pick('JPG أو PNG أو WebP، حتى 2 ميغابايت. صورتك تظهر للجميع.', 'JPG, PNG or WebP, up to 2 MB. Your photo is public.')}</p>
        <label className={styles.field}>{pick('الاسم الظاهر', 'Display name')}<input data-testid="profile-edit-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} required disabled={saving} autoComplete="name" /></label>
        <label className={styles.field}>{pick('نبذة عنك', 'Bio')}<textarea data-testid="profile-edit-bio" value={bio} onChange={event => setBio(event.target.value)} maxLength={500} rows={4} disabled={saving} placeholder={pick('ما الذي تحب مشاركته مع جمهورك؟', 'What do you love sharing with your audience?')} /><span className={styles.counter}>{bio.length}/500</span></label>
        <p className={styles.fieldHint}>{pick('اسم المستخدم ثابت: ', 'Your username stays the same: ')}<b dir="ltr">@{profile.username}</b></p>
        {error && <p className={styles.error} role="alert">{errorText}</p>}
      </div>
      <div className={styles.dialogFooter}><button type="button" className={styles.secondaryButton} onClick={close} disabled={saving || picking}>{pick('إلغاء', 'Cancel')}</button><button type="submit" data-testid="profile-save" className={styles.primaryButton} disabled={saving || picking || !name.trim()}>{saving ? <LoaderCircle size={17} className={styles.spinner} /> : <Check size={17} />}{pick('حفظ التغييرات', 'Save changes')}</button></div>
    </form>
  </Dialog>;
}

function Members({ username, kind, close }: { username: string; kind: 'followers' | 'following'; close: () => void }) {
  const { request } = useAuth(); const { pick } = useLocale();
  const [items, setItems] = useState<ProfileMember[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(false); const [revision, setRevision] = useState(0);
  const active = useRef(true); const pending = useRef(false); const sequence = useRef(0); const controllers = useRef(new Set<AbortController>());
  useEffect(() => { active.current = true; return () => { active.current = false; sequence.current++; pending.current = false; controllers.current.forEach(controller => controller.abort()); }; }, []);
  const load = useCallback(async (after?: string) => {
    if (pending.current) return;
    pending.current = true; const current = ++sequence.current; setLoading(true); setError(false);
    const controller = new AbortController(); controllers.current.add(controller); const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await request<PageResult<ProfileMember>>(`/users/${encodeURIComponent(username)}/${kind}?limit=20${after ? `&cursor=${encodeURIComponent(after)}` : ''}`, { auth: false, signal: controller.signal });
      if (active.current && sequence.current === current) { setItems(previous => after ? Array.from(new Map([...previous, ...result.items].map(item => [item.id, item])).values()) : result.items); setCursor(result.nextCursor); }
    } catch { if (active.current && sequence.current === current) setError(true); }
    finally { clearTimeout(deadline); controllers.current.delete(controller); if (sequence.current === current) { pending.current = false; if (active.current) setLoading(false); } }
  }, [request, username, kind]);
  useEffect(() => { void load(); }, [load, revision]);
  return <Dialog title={kind === 'followers' ? pick('المتابعون', 'Followers') : pick('يتابع', 'Following')} close={close} testId="profile-members-dialog">
    <div className={styles.dialogBody}>
      <div className={styles.memberList}>{items.map(member => <Link key={member.id} href={`/u/${encodeURIComponent(member.username)}`} className={styles.member} onClick={close}><Avatar name={member.displayName} source={member.avatarUrl} className={styles.memberAvatar} /><span className={styles.memberInfo}><strong>{member.displayName}</strong><span className={styles.memberUsername} dir="ltr">@{member.username}</span></span></Link>)}</div>
      {!loading && !error && !items.length && <div className={styles.emptyState}><Users size={28} /><h3>{kind === 'followers' ? pick('لا يوجد متابعون بعد', 'No followers yet') : pick('لا يتابع أحدًا بعد', 'Not following anyone yet')}</h3><p>{pick('ستظهر الحسابات هنا عند بدء المتابعة.', 'Accounts will appear here when a follow is made.')}</p></div>}
      {loading && <p className={styles.loading} role="status"><LoaderCircle size={19} className={styles.spinner} />{pick('جارٍ تحميل الحسابات…', 'Loading accounts…')}</p>}
      {error && <div className={styles.error} role="alert"><span>{pick('تعذر تحميل الحسابات.', 'We couldn’t load these accounts.')}</span><button type="button" className={styles.secondaryButton} onClick={() => cursor && items.length ? void load(cursor) : setRevision(value => value + 1)}>{pick('إعادة المحاولة', 'Try again')}</button></div>}
      {cursor && !loading && !error && <button type="button" className={styles.loadMore} data-testid="profile-members-more" onClick={() => { void load(cursor); }}>{pick('عرض المزيد', 'Show more')}</button>}
    </div>
  </Dialog>;
}

function Profile({ username }: { username: string }) {
  const { user, loading: authLoading, request } = useAuth(); const { pick, locale } = useLocale();
  const [profile, setProfile] = useState<PublicProfile | null>(null); const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState<'missing' | 'connection' | null>(null); const [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<'streams' | 'about'>('streams'); const [editing, setEditing] = useState(false); const [members, setMembers] = useState<'followers' | 'following' | null>(null);
  const [following, setFollowing] = useState<boolean | null>(null); const [followBusy, setFollowBusy] = useState(false); const [followError, setFollowError] = useState(false); const [followRevision, setFollowRevision] = useState(0);
  const [status, setStatus] = useState<'saved' | 'copied' | 'followed' | 'unfollowed' | 'share-error' | null>(null);
  const [live, setLive] = useState<LiveStream[]>([]); const [liveLoading, setLiveLoading] = useState(true); const [liveError, setLiveError] = useState(false); const [liveRevision, setLiveRevision] = useState(0);
  const [history, setHistory] = useState<PastStream[]>([]); const [historyCursor, setHistoryCursor] = useState<string | null>(null); const [historyLoading, setHistoryLoading] = useState(true); const [historyError, setHistoryError] = useState(false); const [historyRevision, setHistoryRevision] = useState(0);
  const active = useRef(true); const pendingHistory = useRef(false); const controllers = useRef(new Set<AbortController>());
  const owner = Boolean(user && profile && user.id === profile.id);
  const profileId = profile?.id;
  const login = `/login?returnTo=${encodeURIComponent(`/u/${username}`)}`;
  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  useEffect(() => { active.current = true; return () => { active.current = false; controllers.current.forEach(controller => controller.abort()); }; }, []);

  useEffect(() => {
    const controller = new AbortController(); let current = true; const deadline = setTimeout(() => controller.abort(), 15_000);
    setLoading(true); setLoadError(null);
    request<PublicProfile>(`/users/${encodeURIComponent(username)}`, { auth: false, signal: controller.signal }).then(result => { if (current) setProfile(result); }).catch(failure => { if (current) { setLoadError(failure instanceof ApiError && failure.status === 404 ? 'missing' : 'connection'); if (failure instanceof ApiError && failure.status === 404) setProfile(null); } }).finally(() => { clearTimeout(deadline); if (current) setLoading(false); });
    return () => { current = false; controller.abort(); clearTimeout(deadline); };
  }, [request, username, revision]);

  useEffect(() => {
    setFollowing(null); setFollowError(false);
    if (!user || !profileId || user.id === profileId) return;
    let current = true; const controller = new AbortController(); const deadline = setTimeout(() => controller.abort(), 15_000);
    request<{ following: boolean }>(`/social/${profileId}`, { signal: controller.signal }).then(result => { if (current) setFollowing(result.following); }).catch(() => { if (current) setFollowError(true); }).finally(() => clearTimeout(deadline));
    return () => { current = false; controller.abort(); clearTimeout(deadline); };
  }, [request, user?.id, profileId, followRevision]);

  useEffect(() => {
    if (!profileId) return;
    let disposed = false; let inFlight = false; let timer: ReturnType<typeof setTimeout> | undefined; let controller: AbortController | null = null;
    async function load() {
      if (disposed || inFlight) return;
      inFlight = true; controller = new AbortController(); const deadline = setTimeout(() => controller?.abort(), 15_000);
      try {
        const result = await request<{ items: LiveStream[] }>(`/streams?creatorId=${encodeURIComponent(profileId!)}`, { auth: false, signal: controller.signal });
        if (!disposed) { setLive(result.items.filter(stream => stream.creator.id === profileId && stream.status === 'LIVE')); setLiveError(false); }
      } catch { if (!disposed) { setLive([]); setLiveError(true); } }
      finally { clearTimeout(deadline); inFlight = false; if (!disposed) { setLiveLoading(false); if (!document.hidden) timer = setTimeout(() => void load(), 15_000); } }
    }
    function visibility() { if (timer) clearTimeout(timer); if (!document.hidden) void load(); }
    setLiveLoading(true); void load(); document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; controller?.abort(); if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [request, profileId, liveRevision]);

  const loadHistory = useCallback(async (cursor?: string) => {
    if (!profileId || pendingHistory.current) return;
    pendingHistory.current = true; setHistoryLoading(true); setHistoryError(false);
    const controller = new AbortController(); controllers.current.add(controller); const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await request<PageResult<PastStream>>(`/users/${encodeURIComponent(username)}/streams?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { auth: false, signal: controller.signal });
      if (active.current) { setHistory(previous => cursor ? Array.from(new Map([...previous, ...result.items].map(item => [item.id, item])).values()) : result.items); setHistoryCursor(result.nextCursor); }
    } catch { if (active.current) setHistoryError(true); }
    finally { clearTimeout(deadline); controllers.current.delete(controller); pendingHistory.current = false; if (active.current) setHistoryLoading(false); }
  }, [request, username, profileId]);
  useEffect(() => { if (profileId) void loadHistory(); }, [profileId, loadHistory, historyRevision]);

  async function toggleFollow() {
    if (!profile || !user || owner || following === null || followBusy) return;
    setFollowBusy(true); setFollowError(false); setStatus(null); const controller = new AbortController(); controllers.current.add(controller); const deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await request<{ following: boolean }>(`/social/${profile.id}/follow`, { method: following ? 'DELETE' : 'POST', ...(following ? {} : { body: '{}' }), signal: controller.signal });
      if (active.current) { setFollowing(result.following); setStatus(result.following ? 'followed' : 'unfollowed'); setRevision(value => value + 1); }
    } catch { if (active.current) setFollowError(true); }
    finally { clearTimeout(deadline); controllers.current.delete(controller); if (active.current) setFollowBusy(false); }
  }
  async function share() {
    if (!profile) return;
    const url = `${location.origin}/u/${encodeURIComponent(profile.username)}`;
    setStatus(null);
    if (navigator.share) {
      try { await navigator.share({ title: profile.displayName, text: `@${profile.username} · LiveStar`, url }); return; }
      catch (failure) { if (failure instanceof DOMException && failure.name === 'AbortError') return; }
    }
    try { if (!navigator.clipboard) throw new Error('clipboard'); await navigator.clipboard.writeText(url); if (active.current) setStatus('copied'); }
    catch { if (active.current) setStatus('share-error'); }
  }
  function date(value: string) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? pick('تاريخ غير متاح', 'Date unavailable') : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(parsed); }
  function duration(item: PastStream) {
    if (!item.endedAt) return null;
    const milliseconds = new Date(item.endedAt).getTime() - new Date(item.startedAt).getTime();
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
    const minutes = Math.floor(milliseconds / 60_000);
    return minutes ? `${count(minutes)} ${pick('دقيقة', 'min')}` : pick('أقل من دقيقة', 'Under a minute');
  }
  function switchTab(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'streams' : event.key === 'End' ? 'about' : tab === 'streams' ? 'about' : 'streams';
    setTab(next); document.getElementById(`profile-${next}-tab`)?.focus();
  }
  const category = (value: string | null) => value === 'music' ? pick('موسيقى', 'Music') : value === 'gaming' ? pick('ألعاب', 'Gaming') : value === 'talent' ? pick('مواهب', 'Talent') : pick('دردشة', 'Chatting');

  if (!profile) return <div className={styles.page} data-testid="profile-page"><Link href="/" className={styles.breadcrumb}><ArrowLeft size={17} />{pick('اكتشف البثوث', 'Discover live')}</Link>{loading ? <div className={`${styles.loadingHero} ${styles.emptyState}`} role="status"><LoaderCircle className={styles.spinner} size={26} /><span>{pick('جارٍ تحميل الملف الشخصي…', 'Loading profile…')}</span></div> : <section className={styles.emptyState} role="status" data-testid="profile-not-found"><Users size={35} /><h1>{loadError === 'missing' ? pick('هذا الملف غير متاح', 'This profile is unavailable') : pick('تعذّر تحميل الملف', 'We couldn’t load this profile')}</h1><p>{loadError === 'missing' ? pick('تحقق من اسم المستخدم، أو عُد لاكتشاف البثوث.', 'Check the username, or head back to discover live streams.') : pick('تحقق من اتصالك وحاول مرة أخرى.', 'Check your connection and try again.')}</p>{loadError !== 'missing' && <button type="button" className={styles.secondaryButton} onClick={() => setRevision(value => value + 1)}><RefreshCw size={17} />{pick('إعادة المحاولة', 'Try again')}</button>}</section>}</div>;

  return <div className={styles.page} data-testid="profile-page">
    <Link href="/" className={styles.breadcrumb}><ArrowLeft size={17} />{pick('اكتشف البثوث', 'Discover live')}</Link>
    <section className={styles.hero} aria-labelledby="profile-title">
      <div className={styles.cover} aria-hidden="true"><span className={styles.coverOrb} /><span className={styles.coverWord}>LiveStar</span></div>
      <div className={styles.identity}>
        <div className={styles.avatarWrap} data-testid="profile-avatar"><Avatar name={profile.displayName} source={profile.avatarUrl} />{live.length > 0 && <span className={styles.liveLabel}><Radio size={12} />LIVE</span>}</div>
        <div className={styles.identityText}><div className={styles.nameLine}><h1 id="profile-title" data-testid="profile-name">{profile.displayName}</h1></div><p className={styles.handle} data-testid="profile-username" dir="ltr">@{profile.username}</p><p className={styles.bio} data-testid="profile-bio">{profile.bio || pick('لم تُضف نبذة شخصية بعد.', 'No bio added yet.')}</p></div>
        <div className={styles.actions}>
          {owner ? <button type="button" className={styles.primaryButton} data-testid="profile-edit" onClick={() => setEditing(true)}><Settings2 size={17} />{pick('تعديل الملف', 'Edit profile')}</button> : !user && !authLoading ? <Link href={login} className={styles.primaryButton} data-testid="profile-follow"><UserPlus size={17} />{pick('متابعة', 'Follow')}</Link> : <button type="button" className={following ? styles.secondaryButton : styles.primaryButton} data-testid="profile-follow" onClick={() => { void toggleFollow(); }} disabled={authLoading || following === null || followBusy}>{followBusy || (following === null && !followError) ? <LoaderCircle size={17} className={styles.spinner} /> : following ? <Check size={17} /> : <UserPlus size={17} />}{following ? pick('تتابعه', 'Following') : pick('متابعة', 'Follow')}</button>}
          <button type="button" className={styles.iconButton} data-testid="profile-share" onClick={() => { void share(); }} aria-label={pick('مشاركة الملف الشخصي', 'Share profile')}><Share2 size={19} /><span className={styles.srOnly}>{pick('مشاركة', 'Share')}</span></button>
        </div>
      </div>
      <div className={styles.stats}>
        <button type="button" className={styles.stat} data-testid="profile-followers" aria-label={pick('عرض المتابعين', 'View followers')} onClick={() => setMembers('followers')}><strong className={styles.statNumber}>{count(profile.followerCount)}</strong><span className={styles.statLabel}>{pick('متابعون', 'Followers')}</span></button>
        <button type="button" className={styles.stat} data-testid="profile-following" aria-label={pick('عرض الحسابات التي يتابعها', 'View following')} onClick={() => setMembers('following')}><strong className={styles.statNumber}>{count(profile.followingCount)}</strong><span className={styles.statLabel}>{pick('يتابع', 'Following')}</span></button>
        <div className={styles.stat} data-testid="profile-broadcast-count"><strong className={styles.statNumber}>{count(profile.broadcastCount)}</strong><span className={styles.statLabel}>{pick('بثوث', 'Broadcasts')}</span></div>
      </div>
    </section>
    {status && <p className={status === 'share-error' ? styles.error : `${styles.status} ${styles.success}`} role="status" data-testid="profile-status">{status === 'saved' ? pick('تم تحديث ملفك الشخصي.', 'Your profile was updated.') : status === 'copied' ? pick('تم نسخ رابط الملف الشخصي.', 'Profile link copied.') : status === 'followed' ? pick('أنت تتابع هذا الحساب الآن.', 'You’re now following this account.') : status === 'unfollowed' ? pick('تم إلغاء المتابعة.', 'You unfollowed this account.') : pick('تعذّر نسخ الرابط. يمكنك نسخه من شريط العنوان.', 'We couldn’t copy the link. You can copy it from the address bar.')}</p>}
    {followError && <div className={styles.error} role="alert"><span>{pick('تعذّر تحديث المتابعة. قد لا تكون هذه العملية متاحة بين الحسابين.', 'We couldn’t update the follow. This interaction may be unavailable between these accounts.')}</span><button type="button" className={styles.secondaryButton} onClick={() => setFollowRevision(value => value + 1)}>{pick('إعادة المحاولة', 'Try again')}</button></div>}
    {loadError && <p className={styles.error} role="status">{pick('تعذّر تحديث بيانات الملف. حاول مجددًا.', 'We couldn’t refresh the profile. Try again.')} <button type="button" onClick={() => setRevision(value => value + 1)}>{pick('تحديث', 'Refresh')}</button></p>}
    <div className={styles.layout}>
      <section className={styles.mainPanel}>
        <div className={styles.tabs} role="tablist" aria-label={pick('محتوى الملف الشخصي', 'Profile content')} onKeyDown={switchTab}>
          <button type="button" role="tab" className={`${styles.tab} ${tab === 'streams' ? styles.activeTab : ''}`} tabIndex={tab === 'streams' ? 0 : -1} aria-selected={tab === 'streams'} aria-controls="profile-streams-panel" id="profile-streams-tab" data-testid="profile-tab-streams" onClick={() => setTab('streams')}><Video size={18} />{pick('البثوث', 'Broadcasts')}</button>
          <button type="button" role="tab" className={`${styles.tab} ${tab === 'about' ? styles.activeTab : ''}`} tabIndex={tab === 'about' ? 0 : -1} aria-selected={tab === 'about'} aria-controls="profile-about-panel" id="profile-about-tab" data-testid="profile-tab-about" onClick={() => setTab('about')}><Users size={18} />{pick('نبذة', 'About')}</button>
        </div>
        {tab === 'streams' ? <div className={styles.panel} id="profile-streams-panel" role="tabpanel" aria-labelledby="profile-streams-tab">
          <div className={styles.sectionHeading}><h2>{pick('على الهواء', 'On air')}</h2>{liveLoading && <LoaderCircle size={18} className={styles.spinner} />}</div>
          {liveError ? <div className={styles.error} role="status"><span>{pick('تعذّر التحقق من حالة البث.', 'We couldn’t check the live status.')}</span><button type="button" className={styles.secondaryButton} onClick={() => setLiveRevision(value => value + 1)}>{pick('إعادة المحاولة', 'Try again')}</button></div> : live.length ? live.map(stream => <Link href={`/live/${stream.id}`} key={stream.id} className={styles.liveCard} data-testid="profile-live-card"><div className={styles.liveCover}><span className={styles.liveBadge}>{pick('مباشر', 'LIVE')}</span><AudioLines size={58} className={styles.liveVisual} /><span className={styles.liveAction}><Play size={22} fill="currentColor" /></span></div><div className={styles.liveInfo}><h3 className={styles.liveTitle}>{stream.title}</h3><p className={styles.liveMeta}><span>{category(stream.category)}</span>{stream.viewerCount !== null && <span><Users size={14} />{count(stream.viewerCount)} {pick('مشاهد', 'watching')}</span>}</p><span>{pick('انضم إلى البث', 'Join the live stream')}</span></div></Link>) : !liveLoading && <div className={styles.emptyState}><Radio size={29} /><h3>{owner ? pick('لحظتك القادمة تبدأ من هنا', 'Your next moment starts here') : pick('لا يوجد بث مباشر الآن', 'Not live right now')}</h3><p>{owner ? pick('شارك حديثًا أو موهبة مع جمهورك.', 'Share a conversation or your talent with your audience.') : pick('يمكنك متابعة الحساب أو استكشاف البثوث المتاحة.', 'You can follow this account or explore other live streams.')}</p>{owner && <Link href="/go-live" className={styles.primaryButton}><Video size={17} />{pick('ابدأ بثًا', 'Go live')}</Link>}</div>}
          <div className={styles.sectionHeading}><h2>{pick('جلسات البث السابقة', 'Past broadcasts')}</h2></div>
          <div className={styles.historyList} data-testid="profile-history">{history.map(item => <article className={styles.historyItem} key={item.id}><span className={styles.historyIcon}><Video size={21} /></span><div className={styles.historyDetails}><h3>{item.title}</h3><p className={styles.historyDate}><time dateTime={item.startedAt}>{date(item.startedAt)}</time><span>·</span><span>{category(item.category)}</span></p></div><span className={styles.historyDuration}><Clock3 size={14} />{duration(item) || pick('انتهى', 'Ended')}</span></article>)}</div>
          {historyLoading && <p className={styles.loading} role="status"><LoaderCircle size={18} className={styles.spinner} />{pick('جارٍ تحميل الجلسات…', 'Loading broadcasts…')}</p>}
          {historyError && <div className={styles.error} role="status"><span>{pick('تعذّر تحميل جلسات البث.', 'We couldn’t load the broadcasts.')}</span><button type="button" className={styles.secondaryButton} onClick={() => historyCursor && history.length ? void loadHistory(historyCursor) : setHistoryRevision(value => value + 1)}>{pick('إعادة المحاولة', 'Try again')}</button></div>}
          {!historyLoading && !historyError && !history.length && <p className={styles.status}>{pick('لا توجد جلسات بث سابقة لعرضها.', 'No past broadcasts to show yet.')}</p>}
          {historyCursor && !historyLoading && !historyError && <button type="button" className={styles.loadMore} data-testid="profile-history-more" onClick={() => { void loadHistory(historyCursor); }}>{pick('عرض المزيد', 'Show more')}</button>}
        </div> : <div className={styles.panel} id="profile-about-panel" role="tabpanel" aria-labelledby="profile-about-tab"><div className={styles.aboutCard}><h2>{pick('عن', 'About')} {profile.displayName}</h2><p className={styles.bio}>{profile.bio || pick('لم تُضف نبذة شخصية بعد.', 'No bio added yet.')}</p><div className={styles.aboutRow}><Globe2 size={18} /><span className={styles.aboutLabel}>{pick('لغة الملف', 'Profile language')}</span><span>{profile.locale === 'ar' ? 'العربية' : 'English'}</span></div><div className={styles.aboutRow}><Users size={18} /><span className={styles.aboutLabel}>{pick('اسم المستخدم', 'Username')}</span><b dir="ltr">@{profile.username}</b></div></div></div>}
      </section>
      <aside className={styles.sidebar}>
        <section className={styles.sideCard}><span className={styles.sideIcon}>{owner ? <Settings2 size={23} /> : <Users size={23} />}</span><h2 className={styles.sideTitle}>{owner ? pick('مساحتك على LiveStar', 'Your space on LiveStar') : pick('اكتشف مزيدًا من اللحظات', 'Discover more live moments')}</h2><p className={styles.sideDescription}>{owner ? pick('جهّز بثك القادم أو أدر حسابك من هنا.', 'Get your next live stream ready or manage your account here.') : pick('شاهد المبدعين وشارك في المحادثة على الهواء.', 'Watch creators and join the live conversation.')}</p>{owner ? <><Link href="/go-live" className={styles.sideLink}><Video size={18} />{pick('استوديو البث', 'Broadcast studio')}</Link><Link href="/wallet" className={styles.sideLink}><Wallet size={18} />{pick('محفظة DU', 'DU wallet')}</Link><Link href="/settings" className={styles.sideLink}><Settings2 size={18} />{pick('إعدادات الحساب', 'Account settings')}</Link></> : <Link href="/" className={styles.sideLink}><Radio size={18} />{pick('اكتشف البثوث', 'Discover live')}</Link>}</section>
        <section className={styles.sideCard}><ShieldCheck size={22} className={styles.sideIcon} /><h2 className={styles.sideTitle}>{pick('مساحة نحترم فيها الجميع', 'A space for everyone')}</h2><p className={styles.sideDescription}>{pick('كن لطيفًا في المحادثة، واحترم خصوصية الآخرين.', 'Be kind in the conversation and respect everyone’s privacy.')}</p><Link href="/terms" className={styles.sideLink}>{pick('إرشادات المجتمع', 'Community guidelines')}</Link></section>
      </aside>
    </div>
    {editing && owner && <EditProfile profile={profile} close={() => setEditing(false)} saved={() => { setEditing(false); setStatus('saved'); setRevision(value => value + 1); }} />}
    {members && <Members username={profile.username} kind={members} close={() => setMembers(null)} />}
  </div>;
}

export function PublicProfilePage({ username }: { username: string }) { return <Profile key={username.toLowerCase()} username={username} />; }
