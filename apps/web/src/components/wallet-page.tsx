'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, Gift, History, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck, Sparkles, Wallet } from 'lucide-react';
import { ApiError, RequireAuth, useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { formatDu, type DuGift, type DuHistory, type DuMutation, type DuWallet } from '@/lib/gifts';
import { DuCoin } from './du-coin';
import styles from './wallet.module.css';

export function WalletPage() {
  return <RequireAuth><WalletContent /></RequireAuth>;
}

function WalletContent() {
  const { request, user } = useAuth();
  const { pick, locale } = useLocale();
  const [wallet, setWallet] = useState<DuWallet | null>(null);
  const [history, setHistory] = useState<DuHistory>({ items: [], nextCursor: null });
  const [catalog, setCatalog] = useState<DuGift[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState('');
  const [claimed, setClaimed] = useState(false);
  const claimKey = useRef<string | null>(null);
  const claimLock = useRef(false);
  const pageLock = useRef(false);
  const refreshLock = useRef(false);
  const lifecycle = useRef(0);

  const problem = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 429) return pick('محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.', 'Too many attempts. Wait a moment, then try again.');
    if (cause instanceof ApiError && cause.status === 401) return pick('انتهت الجلسة. سجّل الدخول مجددًا.', 'Your session has expired. Sign in again.');
    return pick('تعذّر تحديث المحفظة. تحقق من اتصالك وأعد المحاولة.', 'We could not update your wallet. Check your connection and try again.');
  }, [pick]);

  const load = useCallback(async (signal?: AbortSignal) => {
    const [balance, transactions, gifts] = await Promise.all([
      request<DuWallet>('/wallet', { signal }),
      request<DuHistory>('/wallet/history', { signal }),
      request<{ items: DuGift[] }>('/gifts', { auth: false, signal }),
    ]);
    return { balance, transactions, gifts };
  }, [request]);

  useEffect(() => {
    const generation = ++lifecycle.current;
    const controller = new AbortController();
    setLoading(true); setError(''); setClaimed(false);
    claimKey.current = null;
    void load(controller.signal).then(result => {
      if (generation !== lifecycle.current) return;
      setWallet(result.balance); setHistory(result.transactions); setCatalog(result.gifts.items);
    }).catch(cause => { if (!controller.signal.aborted && generation === lifecycle.current) setError(problem(cause)); })
      .finally(() => { if (generation === lifecycle.current) setLoading(false); });
    return () => { controller.abort(); lifecycle.current++; };
  }, [load, problem, user?.id]);

  async function refresh() {
    if (refreshLock.current || claiming) return;
    refreshLock.current = true; setRefreshing(true); setError('');
    const generation = lifecycle.current;
    try {
      const result = await load();
      if (generation !== lifecycle.current) return;
      setWallet(result.balance); setHistory(result.transactions); setCatalog(result.gifts.items);
    } catch (cause) { if (generation === lifecycle.current) setError(problem(cause)); }
    finally { refreshLock.current = false; if (generation === lifecycle.current) setRefreshing(false); }
  }

  async function claim() {
    if (!wallet?.claimAvailable || claimLock.current) return;
    claimLock.current = true; setClaiming(true); setError('');
    claimKey.current ??= crypto.randomUUID();
    const generation = lifecycle.current;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const result = await request<DuMutation>('/wallet/claim', { method: 'POST', signal: controller.signal, body: JSON.stringify({ idempotencyKey: claimKey.current }) });
      if (generation !== lifecycle.current) return;
      setWallet(result.wallet); setHistory(previous => ({ ...previous, items: [result.transaction, ...previous.items.filter(item => item.id !== result.transaction.id)] }));
      setClaimed(true); claimKey.current = null;
    } catch (cause) {
      if (generation !== lifecycle.current) return;
      setError(problem(cause));
      // Keep the same key after an ambiguous network failure. A retry can never claim twice.
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 429) {
        claimKey.current = null;
        void request<DuWallet>('/wallet').then(value => { if (generation === lifecycle.current) setWallet(value); }).catch(() => undefined);
      }
    } finally { clearTimeout(timeout); claimLock.current = false; if (generation === lifecycle.current) setClaiming(false); }
  }

  async function more() {
    if (!history.nextCursor || pageLock.current) return;
    pageLock.current = true; setPaging(true); setError('');
    const generation = lifecycle.current;
    try {
      const result = await request<DuHistory>('/wallet/history?cursor=' + encodeURIComponent(history.nextCursor));
      if (generation !== lifecycle.current) return;
      setHistory(previous => ({ items: [...previous.items, ...result.items.filter(item => !previous.items.some(existing => existing.id === item.id))], nextCursor: result.nextCursor }));
    } catch (cause) { if (generation === lifecycle.current) setError(problem(cause)); }
    finally { pageLock.current = false; if (generation === lifecycle.current) setPaging(false); }
  }

  return <div className={styles.page}>
    <header className={styles.heading}><div><p className={styles.eyebrow}><Wallet size={15} /> LIVESTAR WALLET</p><h1>{pick('محفظة DU', 'Your DU wallet')}</h1><p>{pick('هدية صغيرة، لحظة لا تُنسى.', 'A little gift. A memorable moment.')}</p></div><button type="button" className={styles.refresh} data-testid="wallet-refresh" disabled={loading || refreshing || claiming} onClick={() => void refresh()} aria-label={pick('تحديث المحفظة', 'Refresh wallet')}><RefreshCw size={19} className={refreshing ? 'spin' : ''} /></button></header>
    {error && <div className={styles.error} role="alert">{error}<button type="button" disabled={loading || refreshing || claiming} onClick={() => void refresh()}>{pick('إعادة المحاولة', 'Try again')}</button></div>}
    <section className={styles.hero} aria-labelledby="wallet-balance-heading">
      <div className={styles.heroGlow} aria-hidden="true" /><div className={styles.balanceContent}><span className={styles.promoTag}><Sparkles size={13} />{pick('عملات هدايا مجانية', 'FREE GIFT COINS')}</span><h2 id="wallet-balance-heading">{pick('رصيدك المتاح', 'Your available balance')}</h2><div className={styles.balance} data-testid="wallet-balance" aria-live="polite">{wallet ? formatDu(wallet.balance, locale) : loading ? <LoaderCircle className="spin" size={30} /> : '—'}<span>DU</span></div><p>{pick('رصيد ترويجي للاستخدام داخل LiveStar فقط.', 'Promotional coins to enjoy inside LiveStar.')}</p><Link href="/" className={styles.primary}><Gift size={18} />{pick('اكتشف بثًا وأرسل هدية', 'Find a LIVE. Send a gift.')}<ArrowUpRight size={16} /></Link></div><div className={styles.heroCoin}><DuCoin large /><span className={styles.coinCaption}>SEND A LITTLE LOVE</span></div>
    </section>
    <div className={styles.grid}>
      <section className={styles.claimCard}><div className={styles.cardIcon}><Gift size={23} /></div><div><h2>{claimed ? pick('وصلت هديتك الترحيبية', 'Your welcome gift is here') : pick('ابدأ بهديّة منّا', 'Your first gift is on us')}</h2><p>{pick('احصل على 100 DU مجانية مرة واحدة لتجربة الهدايا في البث المباشر.', 'Claim 100 free DU once and try sending gifts during a LIVE.')}</p>{claimed && <p className={styles.success} data-testid="wallet-claim-success" role="status"><Check size={16} />{pick('أُضيفت 100 DU إلى محفظتك.', '100 DU added to your wallet.')}</p>}<button type="button" data-testid="wallet-claim" className={styles.claimButton} onClick={() => void claim()} disabled={!wallet || !wallet.claimAvailable || claiming || refreshing}>{claiming ? <LoaderCircle size={16} className="spin" /> : wallet && !wallet.claimAvailable ? <Check size={16} /> : <Sparkles size={16} />}{claiming ? pick('جارٍ الإضافة…', 'Adding coins…') : wallet && !wallet.claimAvailable ? pick('تم استلام العملات المجانية', 'Free coins already claimed') : pick('استلم 100 DU مجانًا', 'Claim 100 free DU')}</button></div></section>
      <section className={styles.received}><div className={styles.cardHeading}><span className={styles.cardIcon}><Sparkles size={22} /></span><h2>{pick('دعم جمهورك', 'Love from your audience')}</h2></div><div className={styles.receivedStats}><div><strong data-testid="wallet-received-coins">{wallet ? formatDu(wallet.receivedCoins, locale) : '—'} <small>DU</small></strong><span>{pick('قيمة الهدايا المستلمة', 'Value of received gifts')}</span></div><div><strong data-testid="wallet-received-gifts">{wallet ? formatDu(wallet.receivedGifts, locale) : '—'}</strong><span>{pick('هدايا مستلمة', 'Gifts received')}</span></div></div><p>{pick('عداد تقدير من الجمهور، وليس رصيدًا نقديًا أو قابلًا للإنفاق.', 'Audience appreciation, separate from your spendable coins. No cash value.')}</p></section>
    </div>
    <section className={styles.history} aria-labelledby="wallet-history-heading"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>{pick('كل هدية لها حكاية', 'EVERY GIFT HAS A STORY')}</p><h2 id="wallet-history-heading"><History size={20} />{pick('حركة المحفظة', 'Wallet activity')}</h2></div><span className={styles.historyCount}>{pick('عمليات فعلية', 'Actual activity')}</span></div><div data-testid="wallet-history" className={styles.transactions}>{loading ? <div className={styles.empty} role="status"><LoaderCircle size={26} className="spin" /><p>{pick('جارٍ تحميل محفظتك…', 'Loading your wallet…')}</p></div> : !history.items.length ? <div className={styles.empty}><span className={styles.emptyIcon}><Gift size={27} /></span><h3>{pick('هديتك الأولى تبدأ من هنا', 'Your first gift starts here')}</h3><p>{pick('ستظهر العملات المجانية والهدايا المرسلة هنا بعد إتمامها.', 'Your free coin claim and sent gifts will appear here once completed.')}</p></div> : history.items.map(item => <article className={styles.transaction} key={item.id}><span className={`${styles.transactionIcon} ${item.type === 'CLAIM' ? styles.creditIcon : ''}`}>{item.type === 'CLAIM' ? <ArrowDownLeft size={21} /> : <span aria-hidden="true">{item.gift?.emoji || '🎁'}</span>}</span><div className={styles.transactionText}><h3>{item.type === 'CLAIM' ? pick('هدية DU الترحيبية', 'DU welcome gift') : `${pick(item.gift?.nameAr || 'هدية', item.gift?.nameEn || 'Gift')}${item.quantity && item.quantity > 1 ? ` × ${formatDu(String(item.quantity), locale)}` : ''}`}</h3><span>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))}</span></div><div className={styles.transactionValue}><strong className={item.type === 'CLAIM' ? styles.credit : ''} dir="ltr">{item.type === 'CLAIM' ? '+' : ''}{formatDu(item.amount, locale)} DU</strong><small>{pick('الرصيد', 'Balance')}: {formatDu(item.balanceAfter, locale)} DU</small></div></article>)}</div>{history.nextCursor && <button type="button" className={styles.more} onClick={() => void more()} disabled={paging}>{paging ? <LoaderCircle size={16} className="spin" /> : <ChevronDown size={17} />}{pick('عرض المزيد', 'Show more')}</button>}</section>
    {catalog.length > 0 && <section className={styles.catalog}><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>{pick('اختر طريقتك في التعبير', 'A LITTLE SOMETHING FOR EVERY MOMENT')}</p><h2>{pick('هدايا تضيء البث', 'Gifts that light up a LIVE')}</h2></div><Gift size={23} /></div><div className={styles.catalogGrid}>{catalog.map(gift => <div className={styles.catalogGift} key={gift.id}><span className={styles.catalogEmoji} aria-hidden="true">{gift.emoji}</span><h3>{pick(gift.nameAr, gift.nameEn)}</h3><span><DuCoin />{formatDu(gift.price, locale)} DU</span></div>)}</div><p className={styles.catalogNote}>{pick('تُرسل الهدايا من داخل صفحة البث المباشر.', 'Send these gifts from a live stream.')}</p></section>}
    <section className={styles.disclosure}><ShieldCheck size={22} /><div><h2>{pick('بوضوح، وبدون مفاجآت', 'Clear from the start')}</h2><p>{pick('DU عملات افتراضية للهدايا داخل المنصة وليست عملة مشفّرة. الرصيد الحالي مجاني وترويجي، ولا يمكن تحويله إلى أموال أو سحبه أو نقله إلى مستخدم آخر.', 'DU are virtual in-app gift coins, not cryptocurrency. Current coins are free and promotional. They cannot be exchanged for money, withdrawn, or transferred to another user.')}</p><span><LockKeyhole size={14} />{pick('شراء العملات بأموال حقيقية غير متاح حاليًا.', 'Purchases with real money are currently unavailable.')}</span></div></section>
  </div>;
}
