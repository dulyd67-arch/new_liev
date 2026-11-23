'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Activity, AlertTriangle, Check, ChevronDown, ClipboardList, Gift, LayoutDashboard, LoaderCircle, Radio, RefreshCw, Search, ShieldCheck, ShieldX, Users, Video, X } from 'lucide-react';
import { ApiError, RequireAuth, useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import type { AdminAudit, AdminListItem, AdminOverview, AdminPage as PageResult, AdminPerson, AdminReport, AdminStream, AdminTab, AdminUser, ReportDecision, UserActionResult } from '@/lib/admin';
import styles from './admin.module.css';

const tabs = [
  { id: 'overview', ar: 'نظرة عامة', en: 'Overview', detailAr: 'نبض المنصة', detailEn: 'Platform activity', icon: LayoutDashboard },
  { id: 'users', ar: 'المستخدمون', en: 'Members', detailAr: 'الحسابات وحالتها', detailEn: 'Accounts and access', icon: Users },
  { id: 'streams', ar: 'البثوث', en: 'Broadcasts', detailAr: 'الجلسات والوسائط', detailEn: 'Sessions and media', icon: Radio },
  { id: 'reports', ar: 'البلاغات', en: 'Reports', detailAr: 'المراجعة والقرارات', detailEn: 'Review and decisions', icon: AlertTriangle },
  { id: 'audit', ar: 'سجل الإدارة', en: 'Audit log', detailAr: 'الإجراءات المحفوظة', detailEn: 'Recorded actions', icon: ClipboardList },
] as const;

function usePagedResource(path: string | null, revision: number) {
  const { request } = useAuth();
  const resourceKey = JSON.stringify([path, revision]); const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [items, setItems] = useState<AdminListItem[]>([]); const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState<unknown>(null);
  const sequence = useRef(0); const active = useRef(true); const pending = useRef(false); const controllers = useRef(new Set<AbortController>());
  useEffect(() => { active.current = true; return () => { active.current = false; sequence.current++; controllers.current.forEach(controller => controller.abort()); pending.current = false; }; }, []);
  const load = useCallback(async (after?: string) => {
    if (!path || pending.current) return;
    pending.current = true; const current = ++sequence.current; setLoading(true); setError(null);
    const controller = new AbortController(); controllers.current.add(controller); const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const result = await request<PageResult<AdminListItem>>(`${path}${after ? `&cursor=${encodeURIComponent(after)}` : ''}`, { signal: controller.signal });
      if (active.current && current === sequence.current) {
        setItems(previous => after ? Array.from(new Map([...previous, ...result.items].map(item => [item.id, item])).values()) : result.items);
        setCursor(result.nextCursor);
      }
    } catch (failure) {
      if (active.current && current === sequence.current) {
        setError(failure);
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) { setItems([]); setCursor(null); }
      }
    } finally { clearTimeout(timeout); controllers.current.delete(controller); if (current === sequence.current) { pending.current = false; if (active.current) setLoading(false); } }
  }, [path, request]);
  useEffect(() => {
    sequence.current++; controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); pending.current = false;
    setLoadedKey(resourceKey); setItems([]); setCursor(null); setError(null); setLoading(!!path); if (path) void load();
    return () => { sequence.current++; controllers.current.forEach(controller => controller.abort()); controllers.current.clear(); pending.current = false; };
  }, [load, path, revision, resourceKey]);
  const currentResource = loadedKey === resourceKey;
  return { items: currentResource ? items : [], cursor: currentResource ? cursor : null, loading: !!path && (!currentResource || loading), error: currentResource ? error : null, load };
}

function Person({ person, email }: { person: AdminPerson; email?: string }) {
  return <div className={styles.person}><span className={styles.personInitial} aria-hidden="true">{Array.from(person.displayName.trim())[0] || 'L'}</span><div className={styles.personInfo}><span className={styles.personName}>{person.username ? <Link href={`/u/${encodeURIComponent(person.username)}`} target="_blank" rel="noopener noreferrer">{person.displayName}</Link> : person.displayName}</span>{person.username && <bdi className={styles.personHandle}>@{person.username}</bdi>}{email && <bdi className={styles.secondaryText}>{email}</bdi>}</div></div>;
}

type Action = { kind: 'suspend' | 'restore' | 'terminate' | 'report'; targetId: string; label: string; decision?: ReportDecision; };

function ActionDialog({ action, close, changed }: { action: Action; close: () => void; changed: (message: string, warning?: boolean) => void }) {
  const { request } = useAuth(); const { pick } = useLocale();
  const dialog = useRef<HTMLDialogElement>(null); const heading = useId(); const active = useRef(true); const controller = useRef<AbortController | null>(null);
  const operation = useRef<{ signature: string; key: string } | null>(null);
  const [reason, setReason] = useState(''); const [pending, setPending] = useState(false); const [error, setError] = useState<unknown>(null); const [partial, setPartial] = useState<number | null>(null);
  const title = action.kind === 'suspend' ? pick('تعليق الحساب', 'Suspend account') : action.kind === 'restore' ? pick('إعادة تفعيل الحساب', 'Restore account') : action.kind === 'terminate' ? pick('إيقاف البث', 'Stop broadcast') : pick('حفظ قرار المراجعة', 'Save review decision');
  useEffect(() => {
    active.current = true; const element = dialog.current; const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null; const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; element?.showModal(); element?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    return () => { active.current = false; controller.current?.abort(); element?.close(); document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus({ preventScroll: true }); else document.getElementById('admin-heading')?.focus({ preventScroll: true }); };
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); const trimmed = reason.trim(); if (pending || trimmed.length < 3 || trimmed.length > 1000) return;
    const signature = JSON.stringify({ ...action, reason: trimmed });
    if (operation.current?.signature !== signature) operation.current = { signature, key: crypto.randomUUID() };
    const body = { reason: trimmed, idempotencyKey: operation.current.key, ...(action.kind === 'report' ? { status: action.decision } : {}) };
    const abort = new AbortController(); controller.current = abort; const timeout = setTimeout(() => abort.abort(), 25_000);
    setPending(true); setError(null);
    try {
      if (action.kind === 'suspend' || action.kind === 'restore') {
        const result = await request<UserActionResult>(`/admin/users/${action.targetId}/${action.kind}`, { method: 'POST', body: JSON.stringify(body), signal: abort.signal });
        if (!active.current) return;
        const expectedStatus = action.kind === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
        if (result.user.status !== expectedStatus) {
          changed(pick('حالة الحساب الحالية مختلفة عن الإجراء المطلوب. راجع البيانات المحدثة قبل اتخاذ إجراء جديد.', 'The account’s current state differs from the requested action. Review the updated details before taking a new action.'), true);
          close();
          return;
        }
        if (!result.mediaCleanup.complete) {
          setPartial(result.mediaCleanup.pendingStreamIds.length);
          changed(pick('الحساب معلّق، لكن إيقاف بعض الوسائط لم يكتمل. أعد المحاولة لإكمال الإيقاف.', 'The account is suspended, but some media still needs to stop. Retry to complete the cleanup.'), true);
          return;
        }
        changed(action.kind === 'suspend' ? pick('تم تعليق الحساب وإيقاف بثوثه المفتوحة.', 'The account was suspended and its open broadcasts were stopped.') : pick('أُعيد تفعيل الحساب. يحتاج المستخدم إلى تسجيل الدخول مجددًا.', 'The account was restored. The member needs to sign in again.'));
      } else if (action.kind === 'terminate') {
        const result = await request<{ stream: { id: string; status: string } }>(`/admin/streams/${action.targetId}/terminate`, { method: 'POST', body: JSON.stringify(body), signal: abort.signal });
        if (!active.current) return;
        changed(['TERMINATED', 'ENDED'].includes(result.stream.status) ? pick('البث لم يعد نشطًا، وتم حفظ الإجراء.', 'The broadcast is no longer active and the action was recorded.') : pick('تغيّرت حالة البث. راجع بياناته المحدثة.', 'The broadcast state changed. Review its updated details.'), !['TERMINATED', 'ENDED'].includes(result.stream.status));
      } else {
        await request(`/admin/reports/${action.targetId}`, { method: 'PATCH', body: JSON.stringify(body), signal: abort.signal });
        if (!active.current) return;
        changed(pick('تم حفظ قرار المراجعة.', 'The review decision was saved.'));
      }
      close();
    } catch (failure) { if (active.current) setError(failure); }
    finally { clearTimeout(timeout); if (active.current) setPending(false); }
  }
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={heading} data-testid="admin-action-dialog" onCancel={event => { event.preventDefault(); if (!pending) close(); }}>
    <div className={styles.dialogHeader}><h2 id={heading} className={styles.dialogTitle}>{title}</h2><button type="button" className={styles.iconButton} onClick={close} disabled={pending} aria-label={pick('إغلاق', 'Close')}><X size={20} /></button></div>
    <form onSubmit={submit}>
      <div className={styles.dialogBody}>
        <p className={styles.dialogTarget}>{action.label}</p>
        <p className={styles.fieldHint}>{action.kind === 'suspend' ? pick('يُمنع تسجيل الدخول وتُلغى الجلسات، ثم تُوقف البثوث المفتوحة. يبقى السجل محفوظًا.', 'Sign-in is blocked and sessions are revoked, then open broadcasts are stopped. The history is retained.') : action.kind === 'restore' ? pick('يُسمح للحساب بتسجيل الدخول من جديد؛ لا تُعاد الجلسات القديمة أو البثوث المتوقفة.', 'The account can sign in again. Old sessions and stopped broadcasts are not reopened.') : action.kind === 'terminate' ? pick('سيتوقف الصوت والصورة في هذا البث، ويُسجَّل سبب الإجراء.', 'Audio and video in this broadcast will stop, and the reason will be recorded.') : pick('هذا القرار يحدّث البلاغ فقط. إيقاف البث إجراء منفصل.', 'This decision updates the report only. Stopping the broadcast is a separate action.')}</p>
        <label className={styles.field}>{pick('سبب الإجراء', 'Reason for this action')}<textarea className={styles.reasonInput} data-testid="admin-action-reason" value={reason} onChange={event => setReason(event.target.value)} minLength={3} maxLength={1000} required rows={5} disabled={pending} /><span className={styles.count}>{reason.length}/1000</span></label>
        {partial !== null && <p className={styles.warning} role="status">{pick('الحساب معلّق. بثوث تنتظر إكمال الإيقاف: ', 'Account suspended. Broadcasts awaiting media cleanup: ')}{partial}</p>}
        {!!error && <p className={styles.error} role="alert" data-testid="admin-action-error">{errorText(error, pick)}</p>}
      </div>
      <div className={styles.dialogFooter}><button type="button" className={`${styles.button} ${styles.secondary}`} data-testid="admin-action-cancel" onClick={close} disabled={pending}>{pick('إلغاء', 'Cancel')}</button><button type="submit" className={`${styles.button} ${action.kind === 'restore' || action.kind === 'report' ? '' : styles.danger}`} data-testid="admin-action-confirm" disabled={pending || reason.trim().length < 3}>{pending ? <LoaderCircle size={17} className={styles.spinner} /> : <Check size={17} />}{partial !== null ? pick('إعادة المحاولة', 'Retry cleanup') : pick('تأكيد الإجراء', 'Confirm action')}</button></div>
    </form>
  </dialog>;
}

function errorText(error: unknown, pick: (ar: string, en: string) => string): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return pick('انتهت صلاحية الجلسة. سجّل الدخول مجددًا.', 'Your session expired. Sign in again.');
    if (error.status === 403) return pick('لا تملك صلاحية هذا الإجراء، أو أن الحساب المستهدف محمي.', 'You do not have permission for this action, or the target account is protected.');
    if (error.status === 409) return pick('تغيّرت حالة السجل أو لم يكتمل إيقاف البثوث. حدّث البيانات وراجع الإجراء.', 'The record state changed or media cleanup is incomplete. Refresh the data and review the action.');
    if (error.status === 404) return pick('السجل المطلوب غير متاح. حدّث القائمة.', 'The requested record is unavailable. Refresh the list.');
    if (error.status === 429) return pick('وصلت إلى الحد المؤقت للمحاولات. انتظر قليلًا ثم حاول مجددًا.', 'Too many attempts. Wait a moment and try again.');
    if (error.status === 503) return pick('تعذّر الاتصال بخدمة الوسائط. لم يُؤكَّد إيقاف البث؛ حاول مجددًا.', 'The media service could not be reached. The broadcast stop was not confirmed; try again.');
    if (error.status === 400) return pick('راجع السبب والبيانات المدخلة ثم حاول مجددًا.', 'Check the reason and submitted details, then try again.');
  }
  return pick('تعذّر إكمال الطلب. يمكنك إعادة المحاولة؛ يُستخدم مرجع العملية نفسه لتجنّب التكرار.', 'The request could not be completed. You can retry; the same operation reference prevents duplicates.');
}

function AdminDashboard() {
  const { request, user } = useAuth(); const { pick, locale } = useLocale();
  const [tab, setTab] = useState<AdminTab>('overview'); const [revision, setRevision] = useState(0);
  const [overview, setOverview] = useState<AdminOverview | null>(null); const [overviewLoading, setOverviewLoading] = useState(true); const [overviewError, setOverviewError] = useState<unknown>(null);
  const [queryInput, setQueryInput] = useState(''); const [query, setQuery] = useState('');
  const [userStatus, setUserStatus] = useState(''); const [streamStatus, setStreamStatus] = useState('LIVE'); const [reportStatus, setReportStatus] = useState('OPEN');
  const [action, setAction] = useState<Action | null>(null); const [notice, setNotice] = useState<{ text: string; warning: boolean } | null>(null);
  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined; let pending = false; let controller: AbortController | null = null;
    async function load() {
      if (disposed || pending) return; if (timer) clearTimeout(timer); pending = true; controller = new AbortController(); const timeout = setTimeout(() => controller?.abort(), 20_000);
      try { const data = await request<AdminOverview>('/admin/overview', { signal: controller.signal }); if (!disposed) { setOverview(data); setOverviewError(null); } }
      catch (failure) { if (!disposed) { setOverviewError(failure); if (failure instanceof ApiError && [401, 403].includes(failure.status)) setOverview(null); } }
      finally { clearTimeout(timeout); pending = false; if (!disposed) { setOverviewLoading(false); if (!document.hidden) timer = setTimeout(() => void load(), 30_000); } }
    }
    function visibility() { if (timer) clearTimeout(timer); if (!document.hidden) void load(); }
    setOverviewLoading(true); void load(); document.addEventListener('visibilitychange', visibility);
    return () => { disposed = true; controller?.abort(); if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [request, revision]);
  let path: string | null = null;
  if (tab !== 'overview') {
    const parameters = new URLSearchParams({ limit: '20' });
    if (tab === 'users') { if (query) parameters.set('query', query); if (userStatus) parameters.set('status', userStatus); }
    if (tab === 'streams' && streamStatus) parameters.set('status', streamStatus);
    if (tab === 'reports' && reportStatus) parameters.set('status', reportStatus);
    path = `/admin/${tab}?${parameters}`;
  }
  const page = usePagedResource(path, revision);
  const integer = (value: number) => Number.isFinite(value) ? new Intl.NumberFormat(locale).format(value) : '—';
  const coins = (value: string) => { try { return new Intl.NumberFormat(locale).format(BigInt(value)); } catch { return '—'; } };
  const timestamp = (value: string | null, short = false) => { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(locale, { dateStyle: 'medium', ...(short ? {} : { timeStyle: 'short' }) }).format(date); };
  function statusLabel(status: string) {
    const labels: Record<string, [string, string]> = { ACTIVE: ['نشط', 'Active'], SUSPENDED: ['معلّق', 'Suspended'], DELETED: ['محذوف', 'Deleted'], DELETION_PENDING: ['قيد الحذف', 'Deletion pending'], LIVE: ['جلسة مفتوحة', 'Open session'], SCHEDULED: ['قيد التجهيز', 'Preparing'], ENDED: ['انتهى', 'Ended'], TERMINATED: ['أوقفته الإدارة', 'Stopped by admin'], OPEN: ['جديد', 'Open'], REVIEWING: ['قيد المراجعة', 'In review'], RESOLVED: ['تمت المعالجة', 'Resolved'], DISMISSED: ['مستبعد', 'Dismissed'] };
    return labels[status] ? pick(...labels[status]) : pick('غير متاح', 'Unavailable');
  }
  function badge(status: string) { const tone = ['ACTIVE', 'RESOLVED'].includes(status) ? styles.statusActive : ['SUSPENDED', 'OPEN', 'REVIEWING', 'LIVE', 'SCHEDULED'].includes(status) ? styles.statusWarn : styles.statusMuted; return <span className={`${styles.status} ${tone}`}>{statusLabel(status)}</span>; }
  function selected(next: AdminTab) { setTab(next); setNotice(null); }
  function switchTabs(event: KeyboardEvent<HTMLElement>) {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); const index = tabs.findIndex(item => item.id === tab);
    const delta = event.key === 'ArrowUp' || (event.key === 'ArrowLeft' && locale !== 'ar') || (event.key === 'ArrowRight' && locale === 'ar') ? -1 : 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + delta + tabs.length) % tabs.length;
    selected(tabs[next].id); document.getElementById(`admin-tab-${tabs[next].id}`)?.focus();
  }
  function changed(text: string, warning = false) { setNotice({ text, warning }); setRevision(value => value + 1); }
  function submitSearch(event: FormEvent) { event.preventDefault(); setQuery(queryInput.trim()); }
  function media(stream: AdminStream) { return stream.mediaStatus === 'publishing' ? pick('الوسائط متصلة', 'Media connected') : stream.mediaStatus === 'offline' ? pick('المذيع غير متصل', 'Broadcaster offline') : pick('تعذّر التحقق من الوسائط', 'Media status unavailable'); }
  function auditLabel(value: string) {
    if (/USER_SUSPEND/.test(value)) return pick('تعليق حساب', 'Account suspended');
    if (/USER_RESTOR/.test(value)) return pick('إعادة تفعيل حساب', 'Account restored');
    if (/STREAM_TERMINAT/.test(value)) return pick('إيقاف بث', 'Broadcast stopped');
    if (/STREAM_STOP_REQUESTED/.test(value)) return pick('طلب إيقاف بث', 'Broadcast stop requested');
    if (/REPORT/.test(value)) return pick('مراجعة بلاغ', 'Report reviewed');
    if (value === 'ADMIN_OWNER_PROVISIONED') return pick('تعيين مدير المنصة', 'Platform owner assigned');
    if (/OWNER|ROLE/.test(value)) return pick('تحديث صلاحية إدارية', 'Administrative access updated');
    return pick('إجراء إداري', 'Administrative action');
  }
  function auditReason(item: AdminAudit) { const after = item.after; return after && typeof after === 'object' && 'reason' in after && typeof after.reason === 'string' ? after.reason : null; }
  const activeTab = tabs.find(item => item.id === tab)!;
  return <div className={styles.page} data-testid="admin-dashboard">
    <header className={styles.hero}><div className={styles.heroCopy}><p className={styles.kicker}><ShieldCheck size={15} /> LiveStar</p><h1 className={styles.title} id="admin-heading" tabIndex={-1}>{pick('إدارة المنصة', 'Platform management')}</h1><p className={styles.subtitle}>{pick('الحسابات والبثوث وقرارات المراجعة في مكان واحد.', 'Members, broadcasts and review decisions in one place.')}</p></div><div className={styles.heroActions}><button type="button" className={`${styles.button} ${styles.secondary}`} data-testid="admin-refresh" onClick={() => setRevision(value => value + 1)} disabled={overviewLoading || page.loading}><RefreshCw size={17} className={overviewLoading || page.loading ? styles.spinner : undefined} />{pick('تحديث', 'Refresh')}</button><Link href="/" className={styles.helpLink}>{pick('العودة للمنصة', 'View platform')}</Link></div></header>
    {notice && <p className={notice.warning ? styles.warning : styles.success} role="status" data-testid="admin-status">{notice.text}</p>}
    <div className={styles.shell}>
      <nav className={styles.sidebar} role="tablist" aria-label={pick('أقسام الإدارة', 'Management sections')} onKeyDown={switchTabs}>{tabs.map(item => <button type="button" role="tab" id={`admin-tab-${item.id}`} data-testid={`admin-tab-${item.id}`} aria-controls="admin-panel" aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} className={`${styles.navItem} ${tab === item.id ? styles.navActive : ''}`} key={item.id} onClick={() => selected(item.id)}><item.icon size={19} className={styles.navIcon} /><span className={styles.navText}>{pick(item.ar, item.en)}<small className={styles.navDescription}>{pick(item.detailAr, item.detailEn)}</small></span></button>)}</nav>
      <section id="admin-panel" className={styles.content} role="tabpanel" aria-labelledby={`admin-tab-${tab}`}>
        <div className={styles.sectionHeading}><h2>{pick(activeTab.ar, activeTab.en)}</h2>{overview?.serverNow && <span className={styles.secondaryText}>{pick('آخر تحديث: ', 'Updated: ')}{timestamp(overview.serverNow)}</span>}</div>
        {tab === 'overview' ? <div data-testid="admin-overview">
          {!!overviewError && <ErrorNotice error={overviewError} retry={() => setRevision(value => value + 1)} />}
          {overviewLoading && !overview && <Loading />}
          {overview && <>
            <div className={styles.cards}>
              <Metric icon={<Users size={22} />} value={integer(overview.users.total)} label={pick('الحسابات', 'Members')} note={`${integer(overview.users.active)} ${pick('نشط', 'active')}`} />
              <Metric icon={<Radio size={22} />} value={integer(overview.streams.liveSessions + overview.streams.scheduledSessions)} label={pick('جلسات البث المفتوحة', 'Open broadcast sessions')} note={`${integer(overview.streams.scheduledSessions)} ${pick('قيد التجهيز', 'preparing')}`} />
              <Metric icon={<AlertTriangle size={22} />} value={integer(overview.reports.open + overview.reports.reviewing)} label={pick('بلاغات تنتظر المراجعة', 'Reports awaiting review')} note={`${integer(overview.reports.reviewing)} ${pick('قيد المراجعة', 'in review')}`} />
              <Metric icon={<Gift size={22} />} value={integer(overview.gifts.sentCount)} label={pick('هدايا مرسلة', 'Gifts sent')} note={`${coins(overview.gifts.spentDu)} DU`} />
            </div>
            <div className={styles.overviewGrid}>
              <section className={styles.panel}><div className={styles.panelBody}><div className={styles.sectionHeading}><h3>{pick('الحسابات الجديدة', 'New members')}</h3><span className={styles.count}>{integer(overview.users.newLast7Days)}</span></div><p className={styles.secondaryText}>{pick('آخر 7 أيام بتوقيت UTC', 'Last 7 days in UTC')}</p>{overview.dailyRegistrations.length ? <div className={styles.chart}><div className={styles.chartColumns} role="list">{overview.dailyRegistrations.map(point => { const maximum = Math.max(1, ...overview.dailyRegistrations.map(day => day.count)); const date = new Date(`${point.date}T00:00:00Z`); const label = Number.isNaN(date.getTime()) ? point.date : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date); return <div className={styles.chartColumn} role="listitem" aria-label={`${label}: ${integer(point.count)}`} key={point.date}><span className={styles.chartValue}>{integer(point.count)}</span><span className={styles.chartBar} style={{ height: `${Math.max(0, point.count) / maximum * 100}%` }} /><span className={styles.chartDate}>{label}</span></div>; })}</div></div> : <p className={styles.notice}>{pick('لا توجد بيانات يومية لعرضها.', 'No daily data to show.')}</p>}</div></section>
              <section className={styles.panel}><div className={styles.panelBody}><h3>{pick('حالة المنصة', 'Platform status')}</h3><div className={styles.summaryList}><div className={styles.summaryRow}><span>{pick('حسابات نشطة', 'Active members')}</span><strong>{integer(overview.users.active)}</strong></div><div className={styles.summaryRow}><span>{pick('حسابات معلّقة', 'Suspended members')}</span><strong>{integer(overview.users.suspended)}</strong></div><div className={styles.summaryRow}><span>{pick('DU ممنوحة', 'DU claimed')}</span><strong>{coins(overview.gifts.claimedDu)}</strong></div><div className={styles.summaryRow}><span>{pick('DU أُرسلت كهدايا', 'DU sent as gifts')}</span><strong>{coins(overview.gifts.spentDu)}</strong></div></div><p className={styles.notice}>{pick('DU رصيد ترويجي مجاني للهدايا داخل المنصة، ولا تمثل هذه الأعداد إيرادات نقدية.', 'DU are free promotional gift credits. These totals do not represent cash revenue.')}</p></div></section>
            </div>
          </>}
        </div> : <>
          {tab === 'users' && <form onSubmit={submitSearch} className={styles.filters}><div className={styles.search}><Search size={18} /><input className={styles.searchInput} data-testid="admin-user-search" value={queryInput} onChange={event => setQueryInput(event.target.value)} maxLength={80} aria-label={pick('البحث عن مستخدم', 'Search members')} placeholder={pick('اسم أو بريد إلكتروني', 'Name or email')} /><button className={styles.iconButton} type="submit" aria-label={pick('بحث', 'Search')}><Search size={17} /></button></div><select className={styles.select} aria-label={pick('حالة الحساب', 'Account status')} data-testid="admin-filter-status" value={userStatus} onChange={event => setUserStatus(event.target.value)}><option value="">{pick('كل الحالات', 'All states')}</option><option value="ACTIVE">{pick('نشط', 'Active')}</option><option value="SUSPENDED">{pick('معلّق', 'Suspended')}</option></select>{query && <button type="button" className={styles.smallButton} onClick={() => { setQuery(''); setQueryInput(''); }}>{pick('مسح البحث', 'Clear search')}</button>}</form>}
          {tab === 'streams' && <div className={styles.filters}><select className={styles.select} data-testid="admin-filter-status" value={streamStatus} onChange={event => setStreamStatus(event.target.value)} aria-label={pick('حالة البث', 'Broadcast status')}><option value="LIVE">{pick('جلسات مفتوحة', 'Open sessions')}</option><option value="SCHEDULED">{pick('قيد التجهيز', 'Preparing')}</option><option value="TERMINATED">{pick('أوقفتها الإدارة', 'Stopped by admin')}</option><option value="ENDED">{pick('منتهية', 'Ended')}</option></select></div>}
          {tab === 'reports' && <div className={styles.filters}><select className={styles.select} data-testid="admin-filter-status" value={reportStatus} onChange={event => setReportStatus(event.target.value)} aria-label={pick('حالة البلاغ', 'Report status')}><option value="OPEN">{pick('جديدة', 'Open')}</option><option value="REVIEWING">{pick('قيد المراجعة', 'In review')}</option><option value="RESOLVED">{pick('تمت المعالجة', 'Resolved')}</option><option value="DISMISSED">{pick('مستبعدة', 'Dismissed')}</option></select></div>}
          {!!page.error && <ErrorNotice error={page.error} retry={() => page.cursor && page.items.length ? void page.load(page.cursor) : setRevision(value => value + 1)} />}
          {page.loading && !page.items.length && <Loading />}
          {!page.loading && !page.error && !page.items.length && <Empty />}
          {tab === 'users' && page.items.length > 0 && <div className={styles.tableScroll}><table className={styles.table} data-testid="admin-users-table"><thead><tr><th>{pick('المستخدم', 'Member')}</th><th>{pick('الحالة', 'Status')}</th><th>{pick('انضم في', 'Joined')}</th><th>{pick('البثوث المفتوحة', 'Open broadcasts')}</th><th>{pick('الإجراءات', 'Actions')}</th></tr></thead><tbody>{(page.items as AdminUser[]).map(member => { const own = member.id === user?.id; const protectedAccount = own || member.roles.some(role => ['ADMIN', 'SUPER_ADMIN', 'MODERATOR'].includes(role)); return <tr key={member.id} data-testid={`admin-user-${member.id}`}><td><Person person={member} email={member.email} /></td><td>{badge(member.status)}</td><td>{timestamp(member.createdAt, true)}</td><td>{integer(member.openStreamCount)}</td><td><div className={styles.rowActions}>{protectedAccount ? <span className={styles.protectedLabel}><ShieldCheck size={14} />{own ? pick('حسابك', 'Your account') : pick('حساب إداري', 'Staff account')}</span> : member.status === 'ACTIVE' ? <button type="button" className={styles.smallButton} data-testid={`admin-suspend-${member.id}`} onClick={() => setAction({ kind: 'suspend', targetId: member.id, label: `${member.displayName} · ${member.username || member.email}` })}><ShieldX size={15} />{pick('تعليق', 'Suspend')}</button> : member.status === 'SUSPENDED' ? <>{member.openStreamCount > 0 && <button type="button" className={styles.smallButton} data-testid={`admin-suspend-${member.id}`} onClick={() => setAction({ kind: 'suspend', targetId: member.id, label: member.displayName })}>{pick('إكمال الإيقاف', 'Finish media cleanup')}</button>}<button type="button" className={styles.smallButton} data-testid={`admin-restore-${member.id}`} disabled={member.openStreamCount > 0} title={member.openStreamCount > 0 ? pick('أوقِف البثوث المتبقية أولًا', 'Stop the remaining broadcasts first') : undefined} onClick={() => setAction({ kind: 'restore', targetId: member.id, label: member.displayName })}>{pick('إعادة التفعيل', 'Restore')}</button></> : <span className={styles.secondaryText}>—</span>}</div></td></tr>; })}</tbody></table></div>}
          {tab === 'streams' && <div className={styles.cardsList}>{(page.items as AdminStream[]).map(stream => <article className={styles.itemCard} key={stream.id} data-testid={`admin-stream-${stream.id}`}><div className={styles.itemHeader}><div><h3 className={styles.itemTitle}>{stream.title}</h3><Person person={stream.creator} /></div>{badge(stream.status)}</div><div className={styles.itemMeta}><span>{timestamp(stream.startedAt || stream.createdAt)}</span><span className={styles.mediaInfo}>{media(stream)}{stream.viewerCount !== null && <> · {integer(stream.viewerCount)} {pick('مشاهد', 'watching')}</>}</span></div><div className={styles.rowActions}>{['LIVE', 'SCHEDULED'].includes(stream.status) && <button type="button" className={styles.smallButton} data-testid={`admin-terminate-${stream.id}`} onClick={() => setAction({ kind: 'terminate', targetId: stream.id, label: stream.title })}><ShieldX size={15} />{pick('إيقاف البث', 'Stop broadcast')}</button>}{stream.status === 'LIVE' && stream.mediaStatus === 'publishing' && <Link className={styles.smallButton} href={`/live/${stream.id}`} target="_blank" rel="noopener noreferrer"><Video size={15} />{pick('مشاهدة', 'Watch')}</Link>}</div></article>)}</div>}
          {tab === 'reports' && <div className={styles.cardsList}>{(page.items as AdminReport[]).map(report => <article className={styles.itemCard} key={report.id} data-testid={`admin-report-${report.id}`}><div className={styles.itemHeader}><h3 className={styles.itemTitle}>{pick('بلاغ على المحتوى', 'Content report')}</h3>{badge(report.status)}</div><p className={styles.itemMeta}>{timestamp(report.createdAt)}</p><p className={styles.detailText}>{report.details || pick('لم تُضف تفاصيل للبلاغ.', 'No additional report details were supplied.')}</p><div className={styles.reportTarget}><span>{pick('المرسل', 'Reported by')}</span><Person person={report.reporter} />{report.target && <><span>{pick('الحساب المستهدف', 'Reported account')}</span><Person person={report.target} /></>}{report.stream && <p>{pick('البث: ', 'Broadcast: ')}{report.stream.title} · {statusLabel(report.stream.status)}</p>}</div><div className={styles.reportActions}>{!['RESOLVED', 'DISMISSED'].includes(report.status) && <>{report.status !== 'REVIEWING' && <button type="button" className={styles.smallButton} data-testid={`admin-review-${report.id}-REVIEWING`} onClick={() => setAction({ kind: 'report', targetId: report.id, decision: 'REVIEWING', label: pick('بدء مراجعة البلاغ', 'Start reviewing the report') })}>{pick('بدء المراجعة', 'Start review')}</button>}<button type="button" className={styles.smallButton} data-testid={`admin-review-${report.id}-RESOLVED`} onClick={() => setAction({ kind: 'report', targetId: report.id, decision: 'RESOLVED', label: pick('تمت معالجة البلاغ', 'Resolve this report') })}><Check size={15} />{pick('تمت المعالجة', 'Resolve')}</button><button type="button" className={styles.smallButton} data-testid={`admin-review-${report.id}-DISMISSED`} onClick={() => setAction({ kind: 'report', targetId: report.id, decision: 'DISMISSED', label: pick('استبعاد البلاغ', 'Dismiss this report') })}>{pick('استبعاد', 'Dismiss')}</button></>}{report.stream && ['LIVE', 'SCHEDULED'].includes(report.stream.status) && <button type="button" className={styles.smallButton} data-testid={`admin-terminate-${report.stream.id}`} onClick={() => setAction({ kind: 'terminate', targetId: report.stream!.id, label: report.stream!.title })}><ShieldX size={15} />{pick('إيقاف البث', 'Stop broadcast')}</button>}</div></article>)}</div>}
          {tab === 'audit' && <div className={styles.auditList} data-testid="admin-audit">{(page.items as AdminAudit[]).map(item => <article className={styles.auditItem} key={item.id}><span className={styles.auditIcon}><Activity size={18} /></span><div className={styles.auditContent}><h3 className={styles.auditTitle}>{auditLabel(item.action)}</h3><p className={styles.auditMeta}>{timestamp(item.createdAt)} · {item.actor?.displayName || pick('إدارة المنصة', 'Platform management')}</p>{auditReason(item) && <p className={styles.auditDetails}>{auditReason(item)}</p>}<p className={styles.secondaryText}>{pick('مرجع الإجراء: ', 'Reference: ')}<bdi className={styles.mono}>{item.requestId}</bdi></p></div></article>)}</div>}
          {page.cursor && <div className={styles.pagination}><button type="button" className={`${styles.button} ${styles.secondary}`} data-testid="admin-load-more" disabled={page.loading} onClick={() => { void page.load(page.cursor!); }}>{page.loading ? <LoaderCircle size={16} className={styles.spinner} /> : <ChevronDown size={16} />}{pick('عرض المزيد', 'Load more')}</button></div>}
        </>}
      </section>
    </div>
    {action && <ActionDialog action={action} close={() => setAction(null)} changed={changed} />}
  </div>;
}

function Metric({ icon, value, label, note }: { icon: ReactNode; value: string; label: string; note?: string }) {
  return <div className={styles.metric}><span className={styles.metricIcon}>{icon}</span><strong className={styles.metricValue}>{value}</strong><span className={styles.metricLabel}>{label}</span>{note && <span className={styles.metricNote}>{note}</span>}</div>;
}
function Loading() { const { pick } = useLocale(); return <div className={styles.loading} role="status"><LoaderCircle size={23} className={styles.spinner} />{pick('جارٍ تحميل البيانات…', 'Loading data…')}</div>; }
function Empty() { const { pick } = useLocale(); return <div className={styles.empty}><span className={styles.emptyIcon}><ClipboardList size={29} /></span><h3 className={styles.emptyTitle}>{pick('لا توجد سجلات مطابقة', 'No matching records')}</h3><p className={styles.emptyText}>{pick('جرّب تغيير البحث أو الحالة، ثم حدّث القائمة.', 'Try a different search or status, then refresh the list.')}</p></div>; }
function ErrorNotice({ error, retry }: { error: unknown; retry: () => void }) { const { pick } = useLocale(); return <div className={styles.error} role="alert" data-testid="admin-error"><span>{errorText(error, pick)}</span><div className={styles.errorActions}><button type="button" className={styles.smallButton} onClick={retry}><RefreshCw size={15} />{pick('إعادة المحاولة', 'Try again')}</button>{error instanceof ApiError && error.status === 401 && <Link className={styles.smallButton} href="/login?returnTo=%2Fadmin">{pick('تسجيل الدخول', 'Sign in')}</Link>}</div></div>; }

export function AdminPage() { return <RequireAuth roles={['ADMIN', 'SUPER_ADMIN']}><AdminDashboard /></RequireAuth>; }
