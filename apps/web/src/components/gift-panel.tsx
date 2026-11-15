'use client';

import Link from 'next/link';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronLeft, Gift, LoaderCircle, LockKeyhole, RefreshCw, Send, Sparkles, Wallet, X } from 'lucide-react';
import { ApiError, useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { formatDu, giftTotal, type DuGift, type DuGiftEvent, type DuGiftFeed, type DuMutation, type DuWallet } from '@/lib/gifts';
import { DuCoin } from './du-coin';
import styles from './gifts.module.css';

interface GiftPanelProps {
  streamId: string;
  isLive: boolean;
  isCreator?: boolean;
  triggerClassName?: string;
  compact?: boolean;
}

/** Independent gift button and modal: mount beside the LIVE chat controls. */
export function GiftPanel({ streamId, isLive, isCreator = false, triggerClassName, compact = false }: GiftPanelProps) {
  const { request, user } = useAuth(); const { pick, locale } = useLocale();
  const userId = user?.id;
  const [open, setOpen] = useState(false);
  const [portalTarget, setPortalTarget] = useState<Element | null>(null);
  const [wallet, setWallet] = useState<DuWallet | null>(null);
  const [gifts, setGifts] = useState<DuGift[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  const operation = useRef<{ key: string; giftId: string; quantity: number } | null>(null);
  const submitLock = useRef(false);
  const generation = useRef(0);
  const titleId = useId(); const noteId = useId();
  const close = useCallback(() => setOpen(false), []);
  const gift = gifts.find(item => item.id === selected) ?? null;
  const total = gift ? giftTotal(gift, quantity) : '0';
  const enough = wallet !== null && BigInt(wallet.balance) >= BigInt(total);

  const failure = useCallback((cause: unknown) => {
    if (cause instanceof ApiError) {
      if (cause.status === 401) return pick('سجّل الدخول لإرسال الهدية.', 'Sign in to send your gift.');
      if (cause.status === 403) return pick('إرسال الهدايا غير متاح لهذا الحساب أو البث.', 'Gifting is unavailable for this account or stream.');
      if (cause.status === 404 || cause.status === 409 || cause.status === 422) return pick('تعذّر إرسال الهدية. راجع رصيدك وتأكد أن البث ما زال مباشرًا.', 'Your gift could not be sent. Check your balance and that the stream is still live.');
      if (cause.status === 429) return pick('انتظر قليلًا قبل إرسال هدية أخرى.', 'Wait a moment before sending another gift.');
    }
    return pick('لم نتأكد من نتيجة الإرسال. أعد المحاولة لإكمال الهدية نفسها بأمان.', 'We could not confirm your gift. Retry to safely complete the same gift.');
  }, [pick]);

  useEffect(() => {
    const updateTarget = () => setPortalTarget(document.fullscreenElement || document.body);
    updateTarget();
    document.addEventListener('fullscreenchange', updateTarget);
    return () => document.removeEventListener('fullscreenchange', updateTarget);
  }, []);

  useEffect(() => {
    generation.current++; setWallet(null); setGifts([]); setSelected(null); setQuantity(1);
    setUncertain(false); setBusy(false); setError(''); setSuccess(''); operation.current = null; submitLock.current = false;
    return () => { generation.current++; };
  }, [streamId, user?.id]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    const bodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    element?.querySelector<HTMLElement>('button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab' || !element) return;
      const items = [...element.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')].filter(item => item.offsetParent !== null);
      const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = bodyOverflow; document.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus(); };
  }, [open, close, portalTarget]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); const current = generation.current;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let disposed = false;
    setLoading(true); setError(''); setSuccess('');
    const load = async () => {
      const [catalog, balance] = await Promise.all([
        request<{ items: DuGift[] }>('/gifts', { auth: false, signal: controller.signal }),
        userId ? request<DuWallet>('/wallet', { signal: controller.signal }) : Promise.resolve(null),
      ]);
      if (disposed || current !== generation.current) return;
      setGifts(catalog.items); setWallet(balance);
      setSelected(previous => previous && catalog.items.some(item => item.id === previous) ? previous : catalog.items[0]?.id ?? null);
    };
    void load().catch(cause => { if (!disposed && current === generation.current) setError(failure(cause)); })
      .finally(() => { clearTimeout(timeout); if (!disposed && current === generation.current) setLoading(false); });
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [open, request, userId, failure, reload]);

  async function send() {
    if (!user || !gift || !wallet || !isLive || isCreator || submitLock.current || (!enough && !uncertain)) return;
    submitLock.current = true; setBusy(true); setError(''); setSuccess('');
    operation.current ??= { key: crypto.randomUUID(), giftId: gift.id, quantity };
    const pending = operation.current; const current = generation.current;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await request<DuMutation>('/streams/' + streamId + '/gifts', { method: 'POST', signal: controller.signal, body: JSON.stringify({ giftId: pending.giftId, quantity: pending.quantity, idempotencyKey: pending.key }) });
      if (current !== generation.current) return;
      setWallet(result.wallet); setUncertain(false); operation.current = null;
      setSuccess(pick('وصلت هديتك! شكرًا لدعمك.', 'Your gift arrived! Thanks for the love.'));
      window.dispatchEvent(new CustomEvent('livestar:gift-sent', { detail: { streamId } }));
    } catch (cause) {
      if (current !== generation.current) return;
      setError(failure(cause));
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 429) {
        operation.current = null; setUncertain(false);
        void request<DuWallet>('/wallet').then(value => { if (current === generation.current) setWallet(value); }).catch(() => undefined);
      } else setUncertain(true);
    } finally { clearTimeout(timeout); if (current === generation.current) { submitLock.current = false; setBusy(false); } }
  }

  const modal = open ? <div className={styles.scrim} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}><div ref={dialog} className={styles.panel} data-testid="gift-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={noteId}>
    <div className={styles.handle} /><header className={styles.heading}><div><p><Sparkles size={12} />{pick('دعمك يصنع اللحظة', 'A LITTLE LOVE GOES A LONG WAY')}</p><h2 id={titleId}>{pick('أرسل هدية', 'Send a gift')}<Gift size={22} /></h2></div><button type="button" className={styles.close} onClick={close} aria-label={pick('إغلاق الهدايا', 'Close gifts')}><X size={22} /></button></header>
    <p className={styles.subtitle} id={noteId}>{pick('اختر هدية تضيء بثّهم. كل الهدايا بعملات DU المجانية.', 'Brighten their LIVE. Gifts use free promotional DU coins.')}</p>
    {!isLive && <p className={styles.error} role="status">{pick('انتهى هذا البث. الهدايا متاحة أثناء اللايف فقط.', 'This LIVE has ended. Gifts are available during a live stream only.')}</p>}
    {isCreator && <p className={styles.selfNotice}>{pick('هذه هدايا جمهورك. يمكنك استقبالها أثناء بثك وإرسالها في بثوث الآخرين.', 'These are gifts from your audience. Receive them in your LIVE and send them in other streams.')}</p>}
    {loading ? <div className={styles.loading} role="status"><LoaderCircle className="spin" size={26} /><span>{pick('نجهّز الهدايا…', 'Getting your gifts ready…')}</span></div> : <div className={styles.giftGrid} role="group" aria-label={pick('اختر هدية', 'Choose a gift')}>{gifts.map(item => <button type="button" key={item.id} className={`${styles.gift} ${item.id === selected ? styles.selected : ''}`} data-testid={'gift-item-' + item.slug} aria-pressed={item.id === selected} disabled={busy || uncertain} onClick={() => { setSelected(item.id); setSuccess(''); setError(''); }}><span className={styles.giftEmoji} aria-hidden="true">{item.emoji}</span><strong>{pick(item.nameAr, item.nameEn)}</strong><span className={styles.giftPrice}><DuCoin />{formatDu(item.price, locale)}</span>{item.id === selected && <span className={styles.selectionCheck}><Check size={10} /></span>}</button>)}</div>}
    {error && <div className={styles.error} role="alert">{error}{!loading && (!gifts.length || (user && !wallet)) && <button type="button" className={styles.retry} onClick={() => setReload(value => value + 1)}><RefreshCw size={13} />{pick('إعادة المحاولة', 'Try again')}</button>}</div>}
    {success && <p className={styles.success} role="status" data-testid="gift-success"><Check size={17} />{success}</p>}
    <footer className={styles.footer}>{user ? <><div className={styles.balanceLine}><div><span>{pick('رصيدك', 'Your balance')}</span><strong data-testid="gift-balance"><DuCoin />{wallet ? formatDu(wallet.balance, locale) : '—'} <small>DU</small></strong></div><Link href="/wallet" className={styles.walletLink}><Wallet size={16} />{wallet?.claimAvailable ? pick('احصل على DU مجانية', 'Get free DU') : pick('المحفظة', 'Wallet')}<ChevronLeft size={14} /></Link></div>{!isCreator && <div className={styles.sendLine}><label className={styles.quantity}>{pick('العدد', 'Qty')}<select data-testid="gift-quantity" value={quantity} disabled={busy || uncertain || !isLive} onChange={event => setQuantity(Number(event.target.value))}>{[1, 5, 10, 25, 50, 99].map(value => <option key={value} value={value}>{formatDu(String(value), locale)}</option>)}</select></label><button type="button" className={styles.send} data-testid="gift-send" onClick={() => void send()} disabled={loading || busy || !gift || !wallet || !isLive || (!enough && !uncertain)}>{busy ? <LoaderCircle className="spin" size={17} /> : uncertain ? <RefreshCw size={17} /> : <Send size={17} />}<span>{busy ? pick('جارٍ الإرسال…', 'Sending…') : uncertain ? pick('إعادة إرسال العملية نفسها', 'Retry this gift') : pick('إرسال', 'Send')}<b>{formatDu(total, locale)} DU</b></span></button></div>}{wallet && gift && !enough && !uncertain && !isCreator && <p className={styles.insufficient}>{pick('رصيدك لا يكفي لهذه الهدية. اختر هدية أقل أو احصل على العملات الترحيبية من المحفظة إن لم تستلمها.', 'Not enough DU for this gift. Choose a smaller gift, or claim your welcome coins in the wallet if available.')}</p>}</> : <Link className={styles.login} href={'/login?returnTo=' + encodeURIComponent('/live/' + streamId)}><LockKeyhole size={17} />{pick('سجّل الدخول لإرسال هدية', 'Sign in to send a gift')}</Link>}<p className={styles.disclosure}>{pick('رصيد ترويجي مجاني. غير قابل للسحب أو التحويل إلى نقود.', 'Free promotional coins. No cash value or withdrawals.')}</p></footer>
  </div></div> : null;

  return <><button type="button" data-testid="gift-trigger" data-gift-open="true" className={triggerClassName || `${styles.trigger} ${compact ? styles.compact : ''}`} onClick={() => setOpen(true)} disabled={!isLive} aria-haspopup="dialog" aria-expanded={open} aria-label={pick('فتح الهدايا', 'Open gifts')}><Gift size={24} /><span>{pick('الهدايا', 'Gifts')}</span></button>{modal && typeof document !== 'undefined' && createPortal(modal, portalTarget || document.body)}</>;
}

/** Initial response establishes a cursor. Only new, committed server events animate. */
export function GiftFeed({ streamId, active = true }: { streamId: string; active?: boolean }) {
  const { request } = useAuth(); const { pick, locale } = useLocale();
  const [current, setCurrent] = useState<DuGiftEvent | null>(null);
  const [totals, setTotals] = useState<{ coins: string; gifts: string } | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const queue = useRef<DuGiftEvent[]>([]);

  useEffect(() => {
    if (!active) return;
    let live = true; let cursor: string | null = null; let pending = false; let controller: AbortController | null = null;
    const seen = new Set<string>(); let displayTimer: ReturnType<typeof setTimeout> | null = null;
    queue.current = []; setCurrent(null); setTotals(null); setDisconnected(false);
    const show = () => {
      if (!live || displayTimer || !queue.current.length) return;
      const next = queue.current.shift()!; setCurrent(next);
      displayTimer = setTimeout(() => { displayTimer = null; if (live) { setCurrent(null); show(); } }, 3600);
    };
    const load = async () => {
      if (!live || pending) return;
      pending = true; controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 12_000);
      try {
        const initial = cursor === null;
        const response = await request<DuGiftFeed>('/streams/' + streamId + '/gifts' + (cursor === null ? '' : '?after=' + encodeURIComponent(cursor)), { auth: false, signal: controller.signal });
        if (!live) return;
        cursor = response.nextCursor; setTotals({ coins: response.totalCoins, gifts: response.totalGifts }); setDisconnected(false);
        if (!initial) {
          for (const event of response.items) {
            if (!seen.has(event.id)) { seen.add(event.id); queue.current.push(event); }
          }
          // Keep animation work bounded during a busy LIVE; all activity remains in server history.
          queue.current = queue.current.slice(-12); if (seen.size > 500) { seen.clear(); for (const event of queue.current) seen.add(event.id); }
          show();
        }
      } catch { if (live) setDisconnected(true); }
      finally { clearTimeout(timeout); pending = false; }
    };
    const sent = (event: Event) => { if ((event as CustomEvent<{ streamId: string }>).detail?.streamId === streamId) void load(); };
    void load(); const poll = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 3500);
    window.addEventListener('livestar:gift-sent', sent);
    return () => { live = false; controller?.abort(); clearInterval(poll); if (displayTimer) clearTimeout(displayTimer); window.removeEventListener('livestar:gift-sent', sent); queue.current = []; };
  }, [active, request, streamId]);

  if (!active) return null;
  return <div className={styles.feed} data-testid="gift-feed"><div className={styles.giftTotals} data-testid="gift-totals"><Gift size={13} /><span>{totals ? formatDu(totals.coins, locale) : '—'} DU</span>{disconnected && <span className={styles.feedDelayed} title={pick('تحديث الهدايا متأخر مؤقتًا', 'Gift updates are temporarily delayed')}>…</span>}</div><div className={styles.animationArea} role="status" aria-live="polite" aria-atomic="true">{current && <div className={styles.giftAnimation} key={current.id} data-testid="gift-overlay" data-effect={current.gift.effect}><span className={styles.floatingSpark} aria-hidden="true">✦</span><span className={styles.eventEmoji} aria-hidden="true">{current.gift.emoji}</span><div><strong>{current.sender.displayName}</strong><p>{pick('أرسل', 'sent')} {pick(current.gift.nameAr, current.gift.nameEn)}</p></div><b>×{formatDu(String(current.quantity), locale)}</b><span className={styles.floatingSparkTwo} aria-hidden="true">✧</span></div>}</div></div>;
}
