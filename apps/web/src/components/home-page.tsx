'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { AudioLines, Camera, Check, Gamepad2, Mic2, Music2, Play, Radio, RefreshCw, Search, Sparkles, Swords, Users, Video, Wallet, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import type { LiveStream } from '@/lib/streams';
import styles from './home.module.css';

const categories = [
  { id: '', ar: 'الكل', en: 'For everyone', icon: Radio },
  { id: 'chat', ar: 'دردشة', en: 'Chatting', icon: Mic2 },
  { id: 'music', ar: 'موسيقى', en: 'Music', icon: Music2 },
  { id: 'gaming', ar: 'ألعاب', en: 'Gaming', icon: Gamepad2 },
  { id: 'talent', ar: 'مواهب', en: 'Talent', icon: Sparkles },
];

export function HomePage() {
  const { pick, locale } = useLocale();
  const { request } = useAuth();
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [streams, setStreams] = useState<LiveStream[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const filtered = Boolean(category || search);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const parameters = new URLSearchParams();
    if (category) parameters.set('category', category);
    if (search) parameters.set('query', search);
    async function load() {
      if (disposed || inFlight) return;
      if (timer) clearTimeout(timer);
      inFlight = true;
      controller = new AbortController();
      deadline = setTimeout(() => controller?.abort(), 15_000);
      try {
        const result = await request<{ items: LiveStream[] }>(`/streams?${parameters}`, { auth: false, signal: controller.signal });
        if (!disposed) { setStreams(result.items); setError(false); }
      } catch {
        if (!disposed) setError(true);
      } finally {
        if (deadline) clearTimeout(deadline);
        inFlight = false;
        if (!disposed) {
          setLoading(false);
          if (!document.hidden) timer = setTimeout(() => void load(), 15_000);
        }
      }
    }
    function visibility() {
      if (timer) clearTimeout(timer);
      if (!document.hidden) void load();
    }
    setLoading(true);
    setError(false);
    void load();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      disposed = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
      if (deadline) clearTimeout(deadline);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [category, search, retry, request]);

  function submit(event: FormEvent) { event.preventDefault(); setSearch(query.trim()); }
  function reset() { setCategory(''); setQuery(''); setSearch(''); }

  return <div className={styles.page} data-testid="home-discovery">
    <section className={styles.intro} aria-labelledby="home-title">
      <div>
        <p className={styles.kicker}>{pick('اكتشف. شاهد. شارك.', 'DISCOVER. WATCH. CONNECT.')}</p>
        <h1 id="home-title">{pick('هنا تبدأ اللحظة.', 'This is where it happens.')}</h1>
        <p className={styles.introText}>{pick('بثوث مباشرة، وأشخاص يشبهون اهتماماتك.', 'Live moments. People who get you.')}</p>
      </div>
      <form className={styles.search} role="search" onSubmit={submit}>
        <Search size={20} aria-hidden="true" />
        <input value={query} maxLength={80} onChange={event => setQuery(event.target.value)} aria-label={pick('البحث في البثوث', 'Search live streams')} placeholder={pick('ابحث عن بث أو مبدع', 'Find a stream or creator')} data-testid="home-search" />
        {query && <button type="button" className={styles.clearSearch} onClick={() => { setQuery(''); setSearch(''); }} aria-label={pick('مسح البحث', 'Clear search')}><X size={16} /></button>}
        <button type="submit" className={styles.searchSubmit} aria-label={pick('بحث', 'Search')}><Search size={17} /></button>
      </form>
    </section>

    <section id="live-streams" className={styles.discovery} aria-labelledby="streams-title">
      <div className={styles.discoveryHeading}>
        <div className={styles.headingText}><h2 id="streams-title">{pick('البثوث المباشرة', 'Explore live')}</h2>{!loading && !error && streams.length > 0 && <span className={styles.resultCount}>{new Intl.NumberFormat(locale).format(streams.length)} {pick('بث متاح', 'available')}</span>}</div>
        <button type="button" className={styles.refresh} onClick={() => setRetry(value => value + 1)} disabled={loading} aria-label={pick('تحديث البثوث', 'Refresh streams')}><RefreshCw size={17} className={loading ? styles.spinning : undefined} /><span>{pick('تحديث', 'Refresh')}</span></button>
      </div>
      <div className={styles.categories} role="group" aria-label={pick('تصنيفات البث', 'Stream categories')}>
        {categories.map(item => <button type="button" className={`${styles.category} ${category === item.id ? styles.selectedCategory : ''}`} aria-pressed={category === item.id} key={item.id} onClick={() => setCategory(item.id)} data-category={item.id}><item.icon size={17} />{pick(item.ar, item.en)}{category === item.id && <Check size={14} className={styles.categoryCheck} />}</button>)}
      </div>
      {search && <div className={styles.appliedSearch}><span>{pick('نتائج البحث عن', 'Results for')} <b>“{search}”</b></span><button type="button" onClick={() => { setQuery(''); setSearch(''); }} aria-label={pick('إزالة بحث البثوث', 'Remove stream search')}><X size={16} /></button></div>}

      <div className={styles.results} aria-busy={loading}>
        {loading ? <div className={styles.grid} role="status" aria-label={pick('جارٍ تحميل البثوث', 'Loading streams')}>
          {[0, 1, 2].map(index => <div className={styles.skeletonCard} key={index}><span /><i /><i /></div>)}
          <span className={styles.screenReader}>{pick('جارٍ تحميل البثوث', 'Loading streams')}</span>
        </div> : error ? <div className={styles.empty} role="alert" data-testid="home-error">
          <div className={styles.emptyIcon}><RefreshCw size={29} /></div>
          <h3>{pick('انقطع الاتصال للحظة.', 'We lost the connection.')}</h3>
          <p>{pick('تعذّر تحديث البثوث. حاول مرة أخرى.', 'We couldn’t update the streams. Give it another try.')}</p>
          <button type="button" className={styles.secondaryButton} onClick={() => setRetry(value => value + 1)}><RefreshCw size={17} />{pick('إعادة المحاولة', 'Try again')}</button>
        </div> : streams.length ? <div className={styles.grid} data-testid="home-stream-grid">
          {streams.map(stream => {
            const itemCategory = categories.find(item => item.id === stream.category);
            const CategoryIcon = itemCategory?.icon ?? Radio;
            return <Link className={styles.streamCard} href={`/live/${stream.id}`} key={stream.id} data-testid="home-stream-card">
              <div className={styles.cover} data-category={stream.category || 'chat'}>
                <div className={styles.coverTop}><span className={styles.liveBadge}>{pick('مباشر', 'LIVE')}</span>{stream.viewerCount !== null && <span className={styles.viewerCount}><Users size={13} /><span>{new Intl.NumberFormat(locale).format(stream.viewerCount)}</span></span>}</div>
                <span className={styles.coverInitial} aria-hidden="true">{Array.from(stream.creator.displayName.trim())[0] || 'L'}</span>
                <AudioLines className={styles.coverAudio} size={74} strokeWidth={.8} aria-hidden="true" />
                <span className={styles.play} aria-hidden="true"><Play size={22} fill="currentColor" /></span>
                <span className={styles.coverCategory}><CategoryIcon size={14} />{itemCategory ? pick(itemCategory.ar, itemCategory.en) : pick('مباشر', 'Live')}</span>
              </div>
              <div className={styles.streamDetails}><span className={styles.creatorAvatar} aria-hidden="true">{Array.from(stream.creator.displayName.trim())[0] || 'L'}</span><div><h3>{stream.title}</h3><p>{stream.creator.displayName}</p></div></div>
            </Link>;
          })}
        </div> : <div className={styles.empty} data-testid="home-empty">
          <div className={styles.emptyIcon}>{filtered ? <Search size={30} /> : <Radio size={31} />}</div>
          <h3>{filtered ? pick('لم نجد بثًا يطابق اختيارك.', 'No streams match just yet.') : pick('المسرح بانتظار أول نجم.', 'The stage is yours.')}</h3>
          <p>{filtered ? pick('جرّب تصنيفًا آخر أو امسح البحث لتكتشف المزيد.', 'Try a different category or clear your search.') : pick('لا توجد بثوث مباشرة الآن. كن أول من يبدأ الحديث.', 'No streams are live right now. Be the one who gets things started.')}</p>
          {filtered ? <button type="button" className={styles.secondaryButton} onClick={reset}><X size={17} />{pick('عرض كل البثوث', 'Show all streams')}</button> : <Link href="/go-live" className={styles.secondaryButton}><Video size={18} />{pick('ابدأ أول بث', 'Start a live stream')}</Link>}
        </div>}
      </div>
    </section>
    <section className={styles.featureRow} aria-label={pick('مساحتك على LiveStar', 'Your space on LiveStar')}>
      <div className={styles.creatorCard}>
        <div className={styles.creatorCopy}>
          <span className={styles.creatorEyebrow}><Video size={17} />{pick('مساحتك على الهواء', 'A stage of your own')}</span>
          <h2>{pick('افتح الكاميرا.', 'Camera on.')}<br /><span>{pick('خلّ العالم يسمعك.', 'Make it your moment.')}</span></h2>
          <Link href="/go-live" className={styles.startButton}><Video size={18} />{pick('ابدأ بثك', 'Go live')}</Link>
        </div>
        <div className={styles.stageArt} aria-hidden="true">
          <div className={styles.stageRing} />
          <div className={styles.cameraTile}><Camera size={45} strokeWidth={1.35} /><div className={styles.waveform}>{[12, 23, 34, 19, 40, 28, 16].map((height, index) => <i key={index} style={{ height }} />)}</div></div>
          <span className={styles.stageSpark}><Sparkles size={20} /></span>
        </div>
      </div>
      <div className={styles.quickLinks}>
        <Link className={`${styles.quickLink} ${styles.pkLink}`} href="/go-live">
          <span className={styles.quickIcon}><Swords size={24} /></span>
          <div><span className={styles.quickLabel}>{pick('تحدّيات PK', 'PK battles')}</span><p>{pick('مذيعان. جولة واحدة.', 'Two creators. One round.')}</p></div>
        </Link>
        <Link className={`${styles.quickLink} ${styles.walletLink}`} href="/wallet">
          <span className={styles.quickIcon}><Wallet size={24} /></span>
          <div><span className={styles.quickLabel}>{pick('محفظة DU', 'DU wallet')}</span><p>{pick('هديتك تصنع فرقًا.', 'A little gift. A big moment.')}</p></div>
        </Link>
      </div>
    </section>

  </div>;
}
