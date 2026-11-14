'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowUpLeft, ArrowUpRight, AudioLines, Gamepad2, Mic2, Music2, Play, Radio, RefreshCw, Search, Sparkles, Users, Video } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import type { LiveStream } from '@/lib/streams';

const categories = [
  { id: '', ar: 'الكل', en: 'All streams', icon: Radio },
  { id: 'chat', ar: 'دردشة', en: 'Just chatting', icon: Mic2 },
  { id: 'music', ar: 'موسيقى', en: 'Music', icon: Music2 },
  { id: 'gaming', ar: 'ألعاب', en: 'Gaming', icon: Gamepad2 },
  { id: 'talent', ar: 'مواهب', en: 'Talent', icon: Sparkles },
];
export function HomePage() {
  const { pick, locale } = useLocale(); const { request } = useAuth();
  const [category, setCategory] = useState(''); const [query, setQuery] = useState(''); const [search, setSearch] = useState('');
  const [streams, setStreams] = useState<LiveStream[]>([]); const [loading, setLoading] = useState(true); const [error, setError] = useState(false); const [retry, setRetry] = useState(0);
  const Arrow = locale === 'ar' ? ArrowUpLeft : ArrowUpRight;
  useEffect(() => {
    let active = true; const parameters = new URLSearchParams();
    if (category) parameters.set('category', category); if (search) parameters.set('query', search);
    async function load() {
      try { const result = await request<{ items: LiveStream[] }>(`/streams?${parameters}`, { auth: false }); if (active) { setStreams(result.items); setError(false); } }
      catch { if (active) setError(true); } finally { if (active) setLoading(false); }
    }
    setLoading(true); void load(); const interval = window.setInterval(() => { void load(); }, 15000);
    return () => { active = false; clearInterval(interval); };
  }, [category, search, retry, request]);
  function submit(event: FormEvent) { event.preventDefault(); setSearch(query.trim()); }
  return <div className="home-page">
    <section className="home-hero" aria-labelledby="home-title"><div className="hero-copy">
      <span className="eyebrow"><span className="live-dot" />{pick('لقاءات حقيقية. على الهواء.', 'REAL CONNECTIONS. IN REAL TIME.')}</span>
      <h1 id="home-title">{pick('لحظة منك،', 'Your moment.')}<br /><span className="gold-text">{pick('عالم يجتمع معك.', 'A world together.')}</span></h1>
      <p className="hero-description">{pick('افتح الكاميرا، شارك ما تحب، ودع الحديث يبدأ. مكانك للبث المباشر والمشاهدة والتواصل، بكل بساطة.', 'Turn on your camera, share what you love, and let the conversation begin. Your place to broadcast, watch, and connect. Simply live.')}</p>
      <div className="hero-actions"><Link href="/go-live" className="button gold"><Video size={19} />{pick('ابدأ بثك المباشر', 'Start your live stream')}<Arrow size={18} /></Link><a href="#live-streams" className="button secondary"><Play size={16} />{pick('استكشف البثوث', 'Explore streams')}</a></div>
      <div className="hero-note"><AudioLines size={17} />{pick('كاميرا وصوت ومحادثة. كل ما تحتاجه للّحظة.', 'Video, audio, and chat. Everything your moment needs.')}</div>
    </div><div className="hero-visual" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="broadcast-art"><div className="art-live"><span className="live-dot" />LIVE</div><Radio size={92} strokeWidth={1.1} /><div className="sound-bars">{[14,29,45,25,52,34,18,40,25].map((height, index) => <i key={index} style={{ height }} />)}</div></div><span className="floating-art art-camera"><Video size={26} /></span><span className="floating-art art-chat"><Mic2 size={23} /></span><span className="art-caption">YOUR STAGE. YOUR PEOPLE.</span></div></section>
    <section id="live-streams" className="discovery-section" aria-labelledby="streams-title"><div className="section-heading"><div><p className="eyebrow">{pick('اكتشف شيئاً يستحق المشاهدة', 'FIND SOMETHING WORTH WATCHING')}</p><h2 id="streams-title">{pick('على الهواء الآن', 'Live right now')}<span className="live-dot" /></h2></div><button className="icon-button refresh-button" onClick={() => setRetry(value => value + 1)} aria-label={pick('تحديث البثوث', 'Refresh streams')}><RefreshCw size={18} /></button></div>
      <div className="discovery-toolbar"><div className="tabs" aria-label={pick('تصنيفات البث', 'Stream categories')}>{categories.map(item => <button key={item.id} className={`tab ${category === item.id ? 'active' : ''}`} onClick={() => setCategory(item.id)} aria-pressed={category === item.id}><item.icon size={16} />{pick(item.ar, item.en)}</button>)}</div><form onSubmit={submit} className="stream-search" role="search"><Search size={18} /><input aria-label={pick('البحث في البثوث', 'Search live streams')} placeholder={pick('ابحث عن بث أو مبدع…', 'Search a stream or creator…')} value={query} onChange={event => setQuery(event.target.value)} /><button type="submit" aria-label={pick('بحث', 'Search')}><Arrow size={17} /></button></form></div>
      {loading ? <div className="streams-grid" aria-label={pick('جارٍ تحميل البثوث', 'Loading streams')}>{[0,1,2].map(index => <div className="card stream-skeleton skeleton" key={index} />)}</div> : error ? <div className="card empty-state"><div className="icon-orb"><Radio /></div><h3>{pick('تعذر تحميل البثوث الآن', 'Unable to load live streams')}</h3><p className="muted">{pick('تحقق من اتصالك وحاول مرة أخرى.', 'Check your connection and try again.')}</p><button className="button secondary" onClick={() => setRetry(value => value + 1)}>{pick('إعادة المحاولة', 'Try again')}</button></div> : streams.length ? <div className="streams-grid">{streams.map(stream => <Link href={`/live/${stream.id}`} className="stream-card card" key={stream.id}><div className={`stream-cover cover-${stream.category || 'chat'}`}><span className="live-badge"><span className="live-dot" />{pick('مباشر', 'LIVE')}</span><span className="viewer-pill"><Users size={14} />{stream.viewerCount ?? '—'}</span><span className="stream-initial">{stream.creator.displayName.slice(0,1)}</span><span className="cover-play"><Play size={26} fill="currentColor" /></span><div className="cover-wave"><AudioLines size={56} strokeWidth={1} /></div></div><div className="stream-card-details"><span className="avatar">{stream.creator.displayName.slice(0,1)}</span><div><h3>{stream.title}</h3><p>{stream.creator.displayName}</p><span className="category-label">{pick(categories.find(item => item.id === stream.category)?.ar || 'مباشر', categories.find(item => item.id === stream.category)?.en || 'Live')}</span></div></div></Link>)}</div> : <div className="card empty-state"><div className="empty-broadcast"><Radio size={36} /><span /></div><h3>{pick(search || category ? 'لا توجد بثوث مطابقة الآن' : 'كن أول من يبدأ اللحظة', search || category ? 'No matching streams right now' : 'Be the first to go live')}</h3><p className="muted">{pick(search || category ? 'جرّب بحثاً أو تصنيفاً آخر، أو ابدأ بثك الخاص.' : 'لا يوجد بث مباشر حالياً. ابدأ حديثاً، شارك موهبتك، أو عد لاحقاً لمشاهدة ما يحدث.', search || category ? 'Try another search or category, or start a stream of your own.' : 'There are no live streams right now. Start a conversation, share your talent, or come back to see what’s happening.')}</p><Link href="/go-live" className="button gold"><Video size={17} />{pick('ابدأ البث', 'Go live')}</Link></div>}
    </section><section className="community-note"><div className="icon-orb"><Users size={22} /></div><div><h3>{pick('أشخاص يجتمعون حول ما يحبون', 'People gathering around what they love')}</h3><p className="muted">{pick('شارك بلطف، استمع باهتمام، واجعل لكل شخص مكاناً في الحديث.', 'Share kindly, listen openly, and make room for everyone in the conversation.')}</p></div></section>
  </div>;
}
