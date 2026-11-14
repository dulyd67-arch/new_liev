'use client';

import Link from 'next/link';
import {
  ArrowDownToLine, ArrowUpRight, Bell, Camera, Check, ChevronDown, CircleHelp,
  Coins, Crown, Gift, Heart, History, LockKeyhole, MessageCircle, Mic,
  MonitorPlay, Radio, Search, Settings2, ShieldCheck, Sparkles, Star,
  Users, Video, Wallet, Waypoints,
} from 'lucide-react';
import { RequireAuth, useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

type ModuleKind = 'go-live' | 'live' | 'gifts' | 'coins' | 'wallet' | 'earnings' | 'payouts' | 'transactions' | 'notifications' | 'messages' | 'followers' | 'admin' | 'superadmin';

function PageHeading({ eyebrow, title, description, icon: Icon }: { eyebrow: string; title: string; description: string; icon: LucideIcon }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{description}</p></div><div className="icon-orb"><Icon size={25} /></div></div>;
}

function Unavailable({ icon: Icon, title, description, children }: { icon: LucideIcon; title: string; description: string; children?: ReactNode }) {
  const { pick } = useLocale();
  return <div className="empty-state"><div className="icon-orb"><Icon size={29} /></div><h3>{title}</h3><p className="muted" style={{ maxWidth: 480 }}>{description}</p>{children || <Link href="/search" className="button secondary"><Search size={16} />{pick('اكتشف المبدعين', 'Discover creators')}</Link>}</div>;
}

function ServiceNotice({ children }: { children: ReactNode }) {
  return <p className="notice" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}><CircleHelp size={18} style={{ flexShrink: 0, marginTop: 3 }} /><span>{children}</span></p>;
}

export function StudioPage() {
  const { pick } = useLocale();
  return <RequireAuth><div className="page-content">
    <PageHeading eyebrow={pick('مساحتك الإبداعية', 'YOUR CREATOR SPACE')} title={pick('لحظتك، على الهواء', 'Your moment, live')} description={pick('اختر عنواناً يعكس شغفك وجهّز حضورك أمام جمهورك.', 'Give your passion a title and get ready to meet your audience.')} icon={Video} />
    <div className="studio-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(250px,1fr)', gap: 22 }}>
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ aspectRatio: '16/10', background: 'radial-gradient(ellipse at center, #2c1b4244, #09080e 70%)', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
          <div><div className="icon-orb" style={{ width: 78, height: 78, margin: '0 auto 20px', background: '#ffffff05' }}><Camera size={31} /></div><h3>{pick('مكانك أمام الكاميرا', 'Your place in front of the camera')}</h3><p className="muted">{pick('ستظهر معاينة الكاميرا عند توفر خدمة البث.', 'Your camera preview will appear when streaming is available.')}</p></div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, padding: 18, borderTop: '1px solid #ffffff08' }}>
          <button className="button secondary" disabled aria-label={pick('الكاميرا غير متاحة حالياً', 'Camera currently unavailable')}><Camera size={18} />{pick('الكاميرا', 'Camera')}</button>
          <button className="button secondary" disabled aria-label={pick('الميكروفون غير متاح حالياً', 'Microphone currently unavailable')}><Mic size={18} />{pick('الميكروفون', 'Microphone')}</button>
        </div>
      </div>
      <div className="card" style={{ padding: 25 }}>
        <h2 style={{ fontSize: 19, marginTop: 0 }}>{pick('تفاصيل البث', 'Stream details')}</h2>
        <fieldset disabled style={{ border: 0, padding: 0, margin: 0 }}>
          <label className="field">{pick('عنوان البث', 'Stream title')}<input className="input" placeholder={pick('ما الذي ستشاركه اليوم؟', 'What are you sharing today?')} /></label>
          <label className="field">{pick('التصنيف', 'Category')}<select className="input" defaultValue=""><option value="">{pick('اختر تصنيفاً', 'Choose a category')}</option></select></label>
          <label className="field">{pick('لغة البث', 'Stream language')}<select className="input"><option>{pick('العربية', 'English')}</option></select></label>
          <button className="button gold" style={{ width: '100%', marginTop: 12 }}><Radio size={18} />{pick('البث غير متاح حالياً', 'Streaming currently unavailable')}</button>
        </fieldset>
        <ServiceNotice>{pick('خدمة البث لم تتوفر بعد. يمكنك تخصيص ملفك الشخصي لتكون جاهزاً عند توفرها.', 'Streaming is not available yet. Make your profile your own while you get ready.')}</ServiceNotice>
        <Link href="/settings" className="link">{pick('تعديل ملفي الشخصي', 'Edit my profile')}<ArrowUpRight size={15} /></Link>
      </div>
    </div>
  </div></RequireAuth>;
}

export function WatchPage() {
  const { pick } = useLocale();
  return <div className="page-content">
    <div className="section-heading"><Link className="link" href="/">{pick('العودة إلى الاستكشاف', 'Back to discover')}</Link><span className="status-pill"><ShieldCheck size={14} />{pick('مجتمع نحترم فيه الجميع', 'A community of respect')}</span></div>
    <div className="watch-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 310px', gap: 20 }}>
      <div className="card" style={{ overflow: 'hidden' }}><div style={{ aspectRatio: '16/10', display: 'grid', placeItems: 'center', background: 'radial-gradient(ellipse at top, #311b4c55, #09080e)', padding: 25 }}><Unavailable icon={MonitorPlay} title={pick('هذا البث غير متاح حالياً', 'This stream is currently unavailable')} description={pick('قد يكون البث انتهى، أو لم تتوفر خدمة المشاهدة بعد. استكشف حسابات المبدعين للعثور على ما يلهمك.', 'The stream may have ended, or viewing may not be available yet. Explore creator profiles for something that inspires you.')} /></div></div>
      <aside className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 380 }}><div className="section-heading" style={{ padding: 20, margin: 0, borderBottom: '1px solid #ffffff08' }}><h3 style={{ margin: 0 }}>{pick('المحادثة المباشرة', 'Live chat')}</h3><MessageCircle size={18} /></div><div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 22, textAlign: 'center' }}><div><MessageCircle size={27} color="#6d637d" /><p className="muted">{pick('تبدأ المحادثة مع اللحظة الأولى للبث.', 'The conversation starts when the stream begins.')}</p></div></div><div style={{ padding: 15, borderTop: '1px solid #ffffff08' }}><input className="input" disabled aria-label={pick('المحادثة غير متاحة', 'Chat unavailable')} placeholder={pick('المحادثة غير متاحة حالياً', 'Chat is currently unavailable')} /></div></aside>
    </div>
  </div>;
}

export function GiftsPage() {
  const { pick } = useLocale();
  return <div className="page-content">
    <PageHeading eyebrow={pick('تفاصيل صغيرة. أثر كبير.', 'SMALL GESTURES. BIG MEANING.')} title={pick('هدايا تعبّر عنك', 'Gifts that say it for you')} description={pick('قدّر الموهبة وشارك المبدعين فرحة لحظاتهم المميزة.', 'Celebrate talent and share in your favorite creators’ special moments.')} icon={Gift} />
    <div className="card" style={{ position: 'relative', overflow: 'hidden', padding: '32px 20px', background: 'radial-gradient(ellipse at top, #6e329526, transparent 70%)' }}>
      <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'center', gap: 25, padding: '15px 0' }}>{[Star, Gift, Crown].map((Icon, index) => <div key={index} style={{ width: index === 1 ? 96 : 72, height: index === 1 ? 96 : 72, alignSelf: 'center', display: 'grid', placeItems: 'center', borderRadius: 24, color: index === 1 ? '#e7c47e' : '#bf98e1', background: index === 1 ? '#6b4b3d2b' : '#38244455', border: '1px solid #bd8ae629', transform: `rotate(${index === 0 ? -9 : index === 2 ? 9 : 0}deg)` }}><Icon size={index === 1 ? 43 : 30} strokeWidth={1.4} /></div>)}</div>
      <Unavailable icon={Sparkles} title={pick('عالم الهدايا يستعد للتألق', 'The gift collection is getting ready to shine')} description={pick('ستظهر هنا الهدايا المتاحة وأسعارها المعتمدة بـLiveCoins عند تفعيل الخدمة. إرسال الهدايا غير متاح حالياً.', 'Available gifts and their approved LiveCoins prices will appear here when the service is enabled. Sending gifts is currently unavailable.')}><Link href="/earnings" className="button secondary">{pick('تعرف على دعم المبدعين', 'Learn about creator support')}<ArrowUpRight size={15} /></Link></Unavailable>
    </div>
  </div>;
}

export function CoinsPage() {
  const { pick } = useLocale();
  return <RequireAuth><div className="page-content">
    <PageHeading eyebrow="LIVECOINS" title={pick('لحظات تستحق الدعم', 'Support the moments that matter')} description={pick('اشترِ عملات LiveCoins لإرسال الهدايا للمبدعين أثناء البث.', 'Use LiveCoins to send gifts to creators during their streams.')} icon={Coins} />
    <div className="card" style={{ padding: 30, background: 'radial-gradient(ellipse at top, #a47a2820, #15111d 65%)' }}>
      <div aria-hidden="true" style={{ width: 104, height: 104, margin: '5px auto 0', borderRadius: '50%', color: '#e6bf74', background: 'linear-gradient(145deg,#a37a3c36,#41301b33)', border: '2px solid #b58b4d5c', boxShadow: '0 0 65px #b98b2911', display: 'grid', placeItems: 'center' }}><Star size={48} fill="#d6a954" strokeWidth={1} /></div>
      <Unavailable icon={LockKeyhole} title={pick('شراء العملات غير متاح حالياً', 'Coin purchases are currently unavailable')} description={pick('ستُعرض الباقات والأسعار بعملتك المحلية ووسائل الدفع المتاحة في بلدك عند تفعيل الشراء. لن يتم خصم أي مبلغ من هذه الصفحة.', 'Packages, local-currency prices, and payment methods supported in your region will appear when purchases are enabled. This page will not charge you.')}><button className="button gold" disabled><LockKeyhole size={16} />{pick('الدفع غير متاح', 'Checkout unavailable')}</button></Unavailable>
    </div>
    <ServiceNotice>{pick('تُستخدم LiveCoins داخل المنصة لإرسال الهدايا، ولا يمكن تحويل العملات المشتراة مباشرة إلى نقود.', 'Purchased LiveCoins are used for gifts within LiveStar and cannot be redeemed directly for cash.')} <Link className="link" href="/refund-policy">{pick('سياسة الاسترداد', 'Refund policy')}</Link></ServiceNotice>
  </div></RequireAuth>;
}

export function WalletPage() {
  const { pick } = useLocale();
  return <RequireAuth><div className="page-content">
    <PageHeading eyebrow={pick('كل شيء، بوضوح', 'EVERYTHING, IN VIEW')} title={pick('محفظتك', 'Your wallet')} description={pick('رصيد العملات وأرباحك في مكان واحد، مع فصل واضح بينهما.', 'Your coins and creator earnings, with a clear distinction between them.')} icon={Wallet} />
    <div className="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(250px,1fr))', gap: 20 }}>
      <div className="card" style={{ padding: 28, background: 'radial-gradient(ellipse at top right,#9757d325,#17111e)' }}><div className="section-heading"><span className="muted">{pick('رصيد LiveCoins', 'LiveCoins balance')}</span><Coins size={23} color="#d5b37e" /></div><p style={{ fontSize: 28, fontWeight: 700, margin: '22px 0 10px' }}>{pick('غير متاح حالياً', 'Currently unavailable')}</p><p className="muted">{pick('ستظهر القيمة بعد توفر خدمة المحفظة.', 'Your balance will be shown when the wallet service is available.')}</p><Link href="/coins" className="button gold" style={{ marginTop: 15 }}><Coins size={16} />{pick('باقات العملات', 'Coin packages')}</Link></div>
      <div className="card" style={{ padding: 28 }}><div className="section-heading"><span className="muted">{pick('أرباح المبدع', 'Creator earnings')}</span><Star size={23} color="#be98df" /></div><p style={{ fontSize: 28, fontWeight: 700, margin: '22px 0 10px' }}>{pick('غير متاحة حالياً', 'Currently unavailable')}</p><p className="muted">{pick('أرباح الهدايا المؤهلة منفصلة عن رصيد العملات المشتراة.', 'Eligible gift earnings are separate from purchased coins.')}</p><Link href="/earnings" className="button secondary" style={{ marginTop: 15 }}>{pick('تفاصيل الأرباح', 'Earnings details')}<ArrowUpRight size={16} /></Link></div>
    </div>
    <div className="section card" style={{ padding: 24 }}><div className="section-heading"><h2>{pick('حركة محفظتك', 'Wallet activity')}</h2><Link href="/transactions" className="link">{pick('سجل المعاملات', 'Transaction history')}<History size={16} /></Link></div><Unavailable icon={Waypoints} title={pick('الصورة الكاملة، في مكان واحد', 'The full picture, in one place')} description={pick('ستظهر هنا العمليات الفعلية عند تفعيل خدمات العملات والهدايا. لم تُنشأ أرصدة أو معاملات افتراضية للعرض.', 'Your actual activity will appear when coins and gifting are enabled. No sample balances or transactions are shown.')}><Link href="/transactions" className="button secondary">{pick('عرض السجل', 'View history')}</Link></Unavailable></div>
  </div></RequireAuth>;
}

export function EarningsPage() {
  const { pick } = useLocale();
  return <RequireAuth><div className="page-content">
    <PageHeading eyebrow={pick('اصنع أثرًا يستحق', 'CREATE SOMETHING THAT MATTERS')} title={pick('أرباح المبدع', 'Creator earnings')} description={pick('اعرف كيف يتحول دعم جمهورك إلى أرباح مؤهلة، بوضوح وشفافية.', 'Understand how audience support becomes eligible creator earnings.')} icon={Star} />
    <div className="card" style={{ padding: 'clamp(24px,4vw,40px)', background: 'radial-gradient(ellipse at top right,#9a6c2524,#17111f)' }}><span className="status-pill" style={{ color: '#e2bd75' }}>{pick('سياسة المشاركة الأولية', 'INITIAL REVENUE SHARE POLICY')}</span><div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 20, margin: '28px 0 20px' }}><div><strong style={{ fontSize: 50, lineHeight: 1, color: '#e6c17a' }}>50<span style={{ fontSize: 23 }}>%</span></strong><p>{pick('لصاحب البث', 'For the creator')}</p></div><div style={{ textAlign: 'end' }}><strong style={{ fontSize: 50, lineHeight: 1, color: '#b59bcf' }}>50<span style={{ fontSize: 23 }}>%</span></strong><p>{pick('للمنصة', 'For the platform')}</p></div></div><div aria-hidden="true" style={{ height: 8, display: 'flex', gap: 5, borderRadius: 20, overflow: 'hidden' }}><span style={{ width: '50%', background: '#d6b06b' }} /><span style={{ width: '50%', background: '#7f5aa4' }} /></div><p className="muted" style={{ marginBottom: 0, marginTop: 22, maxWidth: 750 }}>{pick('تُحسب المشاركة من صافي إيرادات الهدايا المؤهلة بعد الرسوم والضرائب والاستردادات المطبقة، وليست من قيمة شحن العملات المعروضة.', 'The share applies to eligible net gift revenue after applicable fees, taxes, and refunds, rather than the displayed price of a coin purchase.')}</p></div>
    <div className="section card"><Unavailable icon={Star} title={pick('خدمة الأرباح غير متاحة بعد', 'Earnings are not available yet')} description={pick('عند تفعيلها، ستظهر أرباحك المعلقة والمتاحة والتسويات الفعلية. لا توجد أرباح تقديرية أو أرصدة تجريبية معروضة هنا.', 'Once enabled, your pending earnings, available funds, and actual adjustments will appear here. No estimated earnings or sample balances are displayed.')}><Link href="/payouts" className="button secondary">{pick('متطلبات السحب', 'Withdrawal requirements')}<ArrowUpRight size={16} /></Link></Unavailable></div>
  </div></RequireAuth>;
}

export function PayoutsPage() {
  const { pick } = useLocale();
  const requirements = [
    [pick('أرباح متاحة للسحب', 'Available earnings'), pick('لا يمكن سحب الأرصدة المعلقة أو رصيد LiveCoins.', 'Pending earnings and LiveCoins cannot be withdrawn.')],
    [pick('هوية وحساب دفع موثّقان', 'Verified identity and payout account'), pick('يخضع الحساب لمتطلبات التحقق والامتثال المعمول بها.', 'Your account must meet applicable verification and compliance requirements.')],
    [pick('بلد ووسيلة سحب مدعومان', 'Supported country and payout method'), pick('يعتمد التوفر على مزود السحب وبلد إقامتك.', 'Availability depends on the payout provider and your country of residence.')],
  ];
  return <RequireAuth><div className="page-content">
    <PageHeading eyebrow={pick('خطوتك التالية، بوضوح', 'YOUR NEXT STEP, CLEARLY')} title={pick('سحب الأرباح', 'Withdraw earnings')} description={pick('طلبات سحب من الأرباح المتاحة والمؤهلة فقط.', 'Withdrawals use eligible, available creator earnings only.')} icon={ArrowDownToLine} />
    <div className="payout-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(270px,.8fr)', gap: 22 }}>
      <div className="card" style={{ padding: 27 }}><h2 style={{ marginTop: 0, fontSize: 20 }}>{pick('قبل طلب السحب', 'Before you request a withdrawal')}</h2>{requirements.map(([title, description], index) => <div className="list-row" key={title} style={{ display: 'flex', gap: 15, padding: '20px 0', borderBottom: index !== requirements.length - 1 ? '1px solid #ffffff08' : 0 }}><span style={{ flexShrink: 0, width: 27, height: 27, display: 'grid', placeItems: 'center', borderRadius: '50%', background: '#a47ad313', color: '#b694d4', fontSize: 12 }}>{index + 1}</span><div><h3 style={{ margin: '0 0 6px', fontSize: 15 }}>{title}</h3><p className="muted" style={{ margin: 0 }}>{description}</p></div></div>)}</div>
      <div className="card" style={{ padding: 27 }}><h2 style={{ marginTop: 0, fontSize: 20 }}>{pick('طلب سحب', 'Withdrawal request')}</h2><fieldset disabled style={{ margin: 0, padding: 0, border: 0 }}><label className="field">{pick('مبلغ السحب', 'Withdrawal amount')}<input className="input" inputMode="decimal" placeholder={pick('حدد المبلغ عند توفر الخدمة', 'Choose an amount when available')} /></label><label className="field">{pick('حساب السحب', 'Payout account')}<select className="input"><option>{pick('الحسابات المدعومة غير متاحة بعد', 'Payout accounts are not available yet')}</option></select></label><button className="button gold" style={{ width: '100%', marginTop: 12 }}><LockKeyhole size={16} />{pick('السحب غير متاح حالياً', 'Withdrawals currently unavailable')}</button></fieldset><ServiceNotice>{pick('لم يتم ربط مزود سحب معتمد. لن يُنشأ طلب تحويل أو يُخصم أي مبلغ من هذه الصفحة.', 'An approved payout provider has not been connected. This page will not create a transfer or debit funds.')}</ServiceNotice></div>
    </div>
  </div></RequireAuth>;
}

export function TransactionsPage() {
  const { pick } = useLocale();
  return <RequireAuth><div className="page-content"><PageHeading eyebrow={pick('كل عملية، في مكانها', 'EVERY TRANSACTION, ACCOUNTED FOR')} title={pick('سجل المعاملات', 'Transaction history')} description={pick('تتبّع عمليات العملات والهدايا والأرباح والسحب.', 'Track coins, gifts, earnings, and withdrawals.')} icon={History} /><div className="card"><div className="section-heading" style={{ padding: 22, borderBottom: '1px solid #ffffff08', margin: 0 }}><span className="status-pill"><History size={14} />{pick('المعاملات الفعلية فقط', 'Actual transactions only')}</span><button className="button secondary" disabled><ArrowDownToLine size={16} />{pick('تصدير السجل', 'Export history')}</button></div><Unavailable icon={History} title={pick('سجل المعاملات غير متاح بعد', 'Transaction history is not available yet')} description={pick('ستظهر العمليات المسجلة ومبالغها وحالاتها هنا عند تفعيل الخدمات المالية. لا يتم عرض معاملات نموذجية على أنها حقيقية.', 'Recorded transactions, their amounts, and statuses will appear when financial services are enabled. Sample transactions are never presented as real activity.')}><Link href="/wallet" className="button secondary"><Wallet size={16} />{pick('العودة إلى المحفظة', 'Back to wallet')}</Link></Unavailable></div></div></RequireAuth>;
}

export function NotificationsPage() {
  const { pick } = useLocale();
  const { user } = useAuth();
  return <RequireAuth><div className="page-content"><PageHeading eyebrow={pick('ابقَ قريباً من اللحظة', 'STAY CLOSE TO THE MOMENT')} title={pick('الإشعارات', 'Notifications')} description={pick('تحديثات الحساب والمبدعين الذين تتابعهم.', 'Updates from your account and the creators you follow.')} icon={Bell} />{user && !user.emailVerifiedAt && <div className="notice" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 15, alignItems: 'center' }}><div><strong>{pick('خطوة صغيرة لحساب أكثر أماناً', 'A small step for a safer account')}</strong><p style={{ margin: '5px 0 0' }}>{pick('تحقق من بريدك الإلكتروني من خلال الرسالة التي أرسلناها لك.', 'Verify your email using the message sent to your inbox.')}</p></div><Link href="/verify-email" className="button secondary">{pick('التحقق من البريد', 'Verify email')}</Link></div>}<div className="card section"><Unavailable icon={Bell} title={pick('مركز الإشعارات يستعد لاستقبال تحديثاتك', 'Your notification center is getting ready')} description={pick('الإشعارات داخل المنصة غير متاحة حالياً. تصل رسائل التحقق واستعادة كلمة المرور إلى بريدك الإلكتروني.', 'In-app notifications are currently unavailable. Verification and password recovery messages are delivered to your email.')}><Link href="/settings" className="button secondary"><Settings2 size={16} />{pick('إدارة حسابي', 'Manage my account')}</Link></Unavailable></div></div></RequireAuth>;
}

export function MessagesPage() {
  const { pick } = useLocale();
  return <RequireAuth><div className="page-content"><PageHeading eyebrow={pick('التواصل يبدأ بكلمة', 'CONNECTION STARTS WITH A WORD')} title={pick('الرسائل', 'Messages')} description={pick('مساحة للمحادثات مع مجتمعك.', 'A space for conversations with your community.')} icon={MessageCircle} /><div className="card" style={{ minHeight: 390, display: 'grid', placeItems: 'center', background: 'radial-gradient(ellipse at center,#8f4ebd0a,transparent 65%)' }}><Unavailable icon={MessageCircle} title={pick('محادثات جديدة تنتظرك', 'New conversations await')} description={pick('خدمة الرسائل الخاصة غير متاحة بعد. يمكنك الآن البحث عن المبدعين والتعرف على ملفاتهم الشخصية.', 'Private messaging is not available yet. You can already discover creators and explore their profiles.')} /></div><ServiceNotice>{pick('حافظ على معلوماتك الشخصية، ولا تشارك كلمات المرور أو بيانات الدفع في المحادثات.', 'Keep your personal information private. Never share passwords or payment details in conversations.')}</ServiceNotice></div></RequireAuth>;
}

export function FollowersPage() {
  const { pick } = useLocale();
  return <div className="page-content"><PageHeading eyebrow={pick('مجتمع ينمو معك', 'A COMMUNITY THAT GROWS WITH YOU')} title={pick('المتابعون', 'Followers')} description={pick('من يشاركك الاهتمام ويتابع لحظاتك.', 'The people who share your interests and follow your moments.')} icon={Users} /><div className="card"><Unavailable icon={Users} title={pick('قائمة المتابعين غير متاحة حالياً', 'Follower lists are currently unavailable')} description={pick('ستظهر الحسابات المتابعة هنا عند توفر خدمة المتابعة. يمكنك الآن استكشاف الملفات العامة للمبدعين.', 'Followers will appear here when following becomes available. You can explore public creator profiles now.')} /></div></div>;
}

export function AdminPage({ superAdmin = false }: { superAdmin?: boolean }) {
  const { pick } = useLocale();
  const cards = [
    { icon: Users, ar: 'المستخدمون النشطون', en: 'Active users' },
    { icon: Radio, ar: 'البثوث المباشرة', en: 'Live streams' },
    { icon: Gift, ar: 'الهدايا المرسلة', en: 'Gifts sent' },
    { icon: Wallet, ar: 'صافي الإيرادات', en: 'Net revenue' },
  ];
  return <RequireAuth roles={superAdmin ? ['SUPER_ADMIN'] : ['MODERATOR', 'ADMIN', 'SUPER_ADMIN']}><div className="page-content">
    <PageHeading eyebrow={pick('مساحة الإدارة', 'ADMINISTRATION')} title={pick(superAdmin ? 'لوحة المدير العام' : 'لوحة الإشراف', superAdmin ? 'Super admin dashboard' : 'Moderation dashboard')} description={pick('رؤية واضحة لحالة المنصة وإدارة مجتمعها.', 'A clear view of platform activity and community management.')} icon={superAdmin ? Crown : ShieldCheck} />
    <div className="stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 16 }}>{cards.map(({ icon: Icon, ar, en }) => <div className="card stat-card" key={en} style={{ padding: 22 }}><Icon size={21} color="#aa85ce" /><p className="muted">{pick(ar, en)}</p><strong style={{ fontSize: 28, color: '#7e728e' }} aria-label={pick('البيانات غير متاحة', 'Data unavailable')}>—</strong></div>)}</div>
    <div className="card section"><Unavailable icon={ShieldCheck} title={pick('خدمات الإدارة غير متاحة بعد', 'Administration services are not available yet')} description={pick('ستعرض هذه المساحة المقاييس والبلاغات والطلبات الفعلية عند ربط خدمات الإدارة. لا تُعرض أرقام تشغيلية أو مالية افتراضية.', 'Actual metrics, reports, and requests will appear once administration services are connected. No sample operational or financial figures are displayed.')}><Link href="/" className="button secondary">{pick('العودة إلى المنصة', 'Back to LiveStar')}</Link></Unavailable></div>
    {superAdmin && <div className="card section" style={{ padding: 25 }}><h2 style={{ marginTop: 0 }}>{pick('سياسة مشاركة الإيرادات', 'Revenue sharing policy')}</h2><p className="muted">{pick('أي تغيير معتمد يُطبَّق على المعاملات المستقبلية فقط، مع حفظ تاريخ السياسات والمعاملات السابقة.', 'Approved changes apply to future transactions only. Historical policies and transaction snapshots are retained.')}</p><button className="button secondary" disabled><LockKeyhole size={16} />{pick('تعديل السياسة غير متاح حالياً', 'Policy editing currently unavailable')}</button></div>}
  </div></RequireAuth>;
}

export function ModulePage({ kind }: { kind: ModuleKind | string }) {
  switch (kind) {
    case 'go-live': return <StudioPage />;
    case 'live': return <WatchPage />;
    case 'gifts': return <GiftsPage />;
    case 'coins': return <CoinsPage />;
    case 'wallet': return <WalletPage />;
    case 'earnings': return <EarningsPage />;
    case 'payouts': return <PayoutsPage />;
    case 'transactions': return <TransactionsPage />;
    case 'notifications': return <NotificationsPage />;
    case 'messages': return <MessagesPage />;
    case 'followers': return <FollowersPage />;
    case 'admin': return <AdminPage />;
    case 'superadmin': return <AdminPage superAdmin />;
    default: return null;
  }
}
