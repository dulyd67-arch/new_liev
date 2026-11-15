'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, CheckCircle2, LoaderCircle, LogIn, Mail, Save, ShieldCheck, UserRound } from 'lucide-react';
import { RequireAuth, useAuth, useErrorMessage } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { useEmailAvailability, type EmailAvailability } from '@/lib/email-availability';

function AccountFrame({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const { pick } = useLocale();
  return <div className="account-wrap"><section className="card auth-card"><Link href="/" className="link account-back"><ArrowLeft size={16} />{pick('العودة إلى البثوث', 'Back to streams')}</Link><div className="icon-orb"><UserRound size={25} /></div><h1>{title}</h1><p className="muted">{description}</p>{children}</section></div>;
}

function Feedback({ error, message }: { error?: string; message?: string }) {
  return <>{error && <p className="form-error" role="alert">{error}</p>}{message && <p className="notice" role="status"><CheckCircle2 size={17} />{message}</p>}</>;
}

function Submit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return <button className="button gold" type="submit" disabled={busy}>{busy && <LoaderCircle size={17} className="spin" />}{children}</button>;
}

function EmailAvailabilityNotice({ state, retry, verification = false }: {
  state: EmailAvailability; retry: () => void; verification?: boolean;
}) {
  const { pick } = useLocale();
  return <div className="notice" role="status" data-testid="email-availability" data-email-state={state}>
    {state === 'loading' ? <><LoaderCircle size={17} className="spin" />{pick('جارٍ التحقق من توفر خدمة البريد…', 'Checking email availability…')}</>
      : state === 'unavailable' ? <div><p>{pick('تعذر التحقق من توفر خدمة البريد. حاول مرة أخرى.', 'Unable to check email availability. Please try again.')}</p><button type="button" className="button secondary small" onClick={retry}>{pick('إعادة المحاولة', 'Try again')}</button></div>
        : <><Mail size={17} /><p>{verification
          ? pick('إرسال رسائل تأكيد البريد غير متاح في هذه النسخة.', 'New verification emails are not available in this version.')
          : pick('استعادة كلمة المرور عبر البريد غير متاحة في هذه النسخة.', 'Email password recovery is not available in this version.')}</p></>}
  </div>;
}

export function LoginPage() {
  const { pick } = useLocale();
  const { login } = useAuth();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const email = useEmailAvailability();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await login(String(form.get('email')).trim(), String(form.get('password')));
      const returnTo = new URLSearchParams(window.location.search).get('returnTo');
      const target = new URL(returnTo || '/', window.location.origin);
      router.replace(target.origin === window.location.origin ? `${target.pathname}${target.search}${target.hash}` : '/');
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  return <AccountFrame title={pick('أهلاً بعودتك', 'Welcome back')} description={pick('سجّل الدخول لتبدأ بثك أو تشارك في المحادثة.', 'Sign in to start streaming or join the chat.')}><form className="form-stack" onSubmit={submit}><label className="field">{pick('البريد الإلكتروني', 'Email')}<input name="email" type="email" autoComplete="email" required maxLength={320} dir="ltr" /></label><label className="field">{pick('كلمة المرور', 'Password')}<input name="password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} dir="ltr" /></label><Feedback error={error} /><Submit busy={busy}><LogIn size={17} />{pick('تسجيل الدخول', 'Sign in')}</Submit></form><div className="inline-links" data-email-state={email.state}>{email.state === 'enabled' && <Link href="/forgot-password">{pick('نسيت كلمة المرور؟', 'Forgot password?')}</Link>}<Link href="/register">{pick('إنشاء حساب', 'Create account')}</Link></div></AccountFrame>;
}

export function RegisterPage() {
  const { pick, locale } = useLocale();
  const { register } = useAuth();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setBusy(true);
    const form = new FormData(event.currentTarget);
    try {
      await register({
        email: String(form.get('email')).trim(), password: String(form.get('password')),
        username: String(form.get('username')).trim().toLowerCase(), displayName: String(form.get('displayName')).trim(),
        birthDate: String(form.get('birthDate')), locale, termsVersion: '2026-11-07', privacyVersion: '2026-11-07',
        acceptTerms: form.get('accept') === 'on', acceptPrivacy: form.get('accept') === 'on',
      });
      router.replace('/');
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  const adult = new Date(); adult.setUTCFullYear(adult.getUTCFullYear() - 18);
  const oldest = new Date(); oldest.setUTCFullYear(oldest.getUTCFullYear() - 120);
  return <AccountFrame title={pick('لحظتك تبدأ بحساب', 'Your moment starts here')} description={pick('انضم إلى LiveStar وشارك لحظاتك مباشرة.', 'Join LiveStar and share your moments live.')}><form className="form-stack" onSubmit={submit}><div className="form-row"><label className="field">{pick('الاسم الظاهر', 'Display name')}<input name="displayName" autoComplete="name" required maxLength={80} /></label><label className="field">{pick('اسم المستخدم', 'Username')}<input name="username" autoComplete="username" required minLength={3} maxLength={32} pattern="[a-zA-Z][a-zA-Z0-9_]{2,31}" dir="ltr" placeholder="your_name" /></label></div><label className="field">{pick('البريد الإلكتروني', 'Email')}<input name="email" type="email" autoComplete="email" required maxLength={320} dir="ltr" /></label><label className="field">{pick('كلمة المرور', 'Password')}<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} dir="ltr" /><small className="muted">{pick('12 حرفاً على الأقل.', 'At least 12 characters.')}</small></label><label className="field">{pick('تاريخ الميلاد', 'Date of birth')}<input name="birthDate" type="date" required max={adult.toISOString().slice(0, 10)} min={oldest.toISOString().slice(0, 10)} dir="ltr" /><small className="muted">{pick('المنصة مخصصة لمن بلغوا 18 عاماً.', 'You must be 18 or older to join.')}</small></label><label className="checkbox-row"><input name="accept" type="checkbox" required /><span>{pick('أوافق على ', 'I agree to the ')}<Link href="/terms" target="_blank">{pick('الشروط', 'terms')}</Link>{pick(' و', ' and ')}<Link href="/privacy" target="_blank">{pick('الخصوصية', 'privacy policy')}</Link>.</span></label><Feedback error={error} /><Submit busy={busy}>{pick('إنشاء حساب', 'Create account')}</Submit></form><div className="inline-links"><span className="muted">{pick('لديك حساب بالفعل؟', 'Already have an account?')}</span><Link href="/login">{pick('تسجيل الدخول', 'Sign in')}</Link></div></AccountFrame>;
}

export function ForgotPasswordPage() {
  const { pick } = useLocale(); const { request } = useAuth(); const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const email = useEmailAvailability();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (email.state !== 'enabled') return; setBusy(true); setError(''); setMessage(''); const form = new FormData(event.currentTarget);
    try { await request('/auth/password/forgot', { method: 'POST', auth: false, body: JSON.stringify({ email: String(form.get('email')).trim() }) }); setMessage(pick('إذا كان الحساب موجوداً، فستصلك رسالة تتضمن رابط الاستعادة.', 'If an eligible account exists, a recovery link will be sent to your email.')); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  return <AccountFrame title={pick('استعادة كلمة المرور', 'Reset your password')} description={email.state === 'enabled' ? pick('أدخل بريد حسابك وسنرسل لك رابط الاستعادة.', 'Enter your account email to request a reset link.') : pick('تتطلب استعادة كلمة المرور توفر خدمة البريد.', 'Password recovery requires email delivery.')}>
    {email.state === 'enabled' ? <form className="form-stack" onSubmit={submit}><label className="field">{pick('البريد الإلكتروني', 'Email')}<input name="email" type="email" autoComplete="email" required maxLength={320} dir="ltr" /></label><Feedback error={error} message={message} /><Submit busy={busy}><Mail size={17} />{pick('إرسال رابط الاستعادة', 'Send reset link')}</Submit></form> : <EmailAvailabilityNotice state={email.state} retry={email.retry} />}
    <div className="inline-links"><Link href="/login">{pick('العودة للدخول', 'Back to sign in')}</Link></div></AccountFrame>;
}

function useEmailToken() {
  const [token, setToken] = useState('');
  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get('token') || '';
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) setToken(value);
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, []);
  return token;
}

export function ResetPasswordPage() {
  const { pick } = useLocale(); const { request, clearSession } = useAuth(); const errorMessage = useErrorMessage();
  const token = useEmailToken(); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [done, setDone] = useState(false);
  const email = useEmailAvailability();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget);
    try { await request('/auth/password/reset', { method: 'POST', auth: false, body: JSON.stringify({ token, password: String(form.get('password')) }) }); clearSession(); setDone(true); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  return <AccountFrame title={pick('كلمة مرور جديدة', 'Choose a new password')} description={pick('استخدم كلمة مرور مميزة لحماية حسابك.', 'Use a unique password to keep your account secure.')}>
    {done ? <><Feedback message={pick('تم تغيير كلمة المرور. يمكنك تسجيل الدخول من جديد.', 'Your password was changed. Sign in again to continue.')} /><Link className="button gold" href="/login">{pick('تسجيل الدخول', 'Sign in')}</Link></> : token ? <form className="form-stack" onSubmit={submit}><label className="field">{pick('كلمة المرور الجديدة', 'New password')}<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} dir="ltr" /></label><Feedback error={error} /><Submit busy={busy}>{pick('حفظ كلمة المرور', 'Save password')}</Submit></form> : email.state === 'enabled' ? <><p className="notice">{pick('افتح رابط الاستعادة الذي وصلك بالبريد. إذا انتهت صلاحيته، اطلب رابطاً جديداً.', 'Open the reset link delivered by email. Request a new link if it has expired.')}</p><Link className="button secondary" href="/forgot-password">{pick('طلب رابط جديد', 'Request a new link')}</Link></> : <EmailAvailabilityNotice state={email.state} retry={email.retry} />}
  </AccountFrame>;
}

export function VerifyEmailPage() {
  const { pick } = useLocale(); const { request, user, refreshUser } = useAuth(); const errorMessage = useErrorMessage();
  const token = useEmailToken(); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [done, setDone] = useState(false);
  const email = useEmailAvailability();
  async function verify() {
    setBusy(true); setError('');
    try { await request('/auth/email/verify', { method: 'POST', auth: false, body: JSON.stringify({ token }) }); setDone(true); setMessage(pick('تم تأكيد بريدك الإلكتروني.', 'Your email has been verified.')); if (user) await refreshUser(); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function resend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (email.state !== 'enabled') return; setBusy(true); setError(''); const form = new FormData(event.currentTarget);
    try { await request('/auth/email/resend', { method: 'POST', auth: false, body: JSON.stringify({ email: String(form.get('email')).trim() }) }); setMessage(pick('إذا كان الحساب بحاجة للتحقق، فستصلك رسالة جديدة.', 'If the account needs verification, a new email will be sent.')); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  return <AccountFrame title={pick('تأكيد البريد الإلكتروني', 'Verify your email')} description={pick('خطوة بسيطة لحساب أكثر أماناً.', 'A small step for a safer account.')}><Feedback error={error} message={message} />{token && !done ? <button className="button gold" onClick={() => void verify()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />}{pick('تأكيد بريدي الآن', 'Verify my email')}</button> : done ? <Link href="/" className="button gold">{pick('اكتشف البثوث', 'Explore streams')}</Link> : email.state === 'enabled' ? <form className="form-stack" onSubmit={resend}><label className="field">{pick('البريد الإلكتروني', 'Email')}<input name="email" type="email" autoComplete="email" defaultValue={user?.email} required maxLength={320} dir="ltr" /></label><Submit busy={busy}>{pick('إعادة إرسال رسالة التحقق', 'Resend verification email')}</Submit></form> : <EmailAvailabilityNotice state={email.state} retry={email.retry} verification />}</AccountFrame>;
}

function SettingsForm() {
  const { user, request, refreshUser } = useAuth(); const { pick, setLocale } = useLocale(); const errorMessage = useErrorMessage();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const email = useEmailAvailability();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage(''); const form = new FormData(event.currentTarget); const locale = String(form.get('locale'));
    try { await request('/users/me', { method: 'PATCH', body: JSON.stringify({ displayName: String(form.get('displayName')).trim(), bio: String(form.get('bio')), locale, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }) }); await refreshUser(); setLocale(locale === 'ar' ? 'ar' : 'en'); setMessage(pick('تم حفظ ملفك الشخصي.', 'Your profile was saved.')); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  return <div className="account-wrap"><section className="card auth-card"><div className="avatar profile-avatar">{(user?.profile?.displayName || user?.email || 'L').slice(0, 1)}</div><h1>{pick('ملفي الشخصي', 'My profile')}</h1><p className="muted" dir="ltr">@{user?.profile?.username}</p><form className="form-stack" onSubmit={submit}><label className="field">{pick('الاسم الظاهر', 'Display name')}<input name="displayName" required maxLength={80} defaultValue={user?.profile?.displayName || ''} /></label><label className="field">{pick('نبذة عني', 'About me')}<textarea name="bio" maxLength={500} rows={4} defaultValue={user?.profile?.bio || ''} /></label><label className="field">{pick('اللغة', 'Language')}<select name="locale" defaultValue={user?.profile?.locale || 'ar'}><option value="ar">العربية</option><option value="en">English</option></select></label><label className="field">{pick('البريد الإلكتروني', 'Email')}<input type="email" value={user?.email || ''} readOnly dir="ltr" /></label>{!user?.emailVerifiedAt && email.state === 'enabled' && <Link href="/verify-email" className="link">{pick('تأكيد البريد الإلكتروني', 'Verify email')}</Link>}<Feedback error={error} message={message} /><Submit busy={busy}><Save size={17} />{pick('حفظ التغييرات', 'Save changes')}</Submit></form></section></div>;
}

export function SettingsPage() { return <RequireAuth><SettingsForm /></RequireAuth>; }

interface PublicProfile { id: string; username: string; displayName: string; bio: string | null; locale: string; }
export function PublicProfilePage({ username }: { username: string }) {
  const { request } = useAuth(); const { pick } = useLocale(); const errorMessage = useErrorMessage();
  const [profile, setProfile] = useState<PublicProfile | null>(null); const [error, setError] = useState('');
  useEffect(() => { let current = true; setProfile(null); setError(''); request<PublicProfile>(`/users/${encodeURIComponent(username)}`, { auth: false }).then(value => { if (current) setProfile(value); }).catch(reason => { if (current) setError(errorMessage(reason)); }); return () => { current = false; }; }, [request, username, errorMessage]);
  return <div className="account-wrap"><section className="card auth-card profile-card">{profile ? <><div className="avatar profile-avatar">{profile.displayName.slice(0, 1)}</div><h1>{profile.displayName}</h1><p className="muted" dir="ltr">@{profile.username}</p><p>{profile.bio || pick('مرحباً بكم في مساحتي على LiveStar.', 'Welcome to my space on LiveStar.')}</p><Link href={`/?query=${encodeURIComponent(profile.displayName)}`} className="button gold">{pick('ابحث عن بثوثه', 'Find their streams')}</Link></> : error ? <Feedback error={error} /> : <p role="status" className="muted">{pick('جارٍ تحميل الملف…', 'Loading profile…')}</p>}</section></div>;
}

export function PolicyPage({ privacy = false }: { privacy?: boolean }) {
  const { pick } = useLocale();
  return <article className="card prose-card"><p className="eyebrow">LIVESTAR · 2026-11-07</p><h1>{privacy ? pick('خصوصيتك في LiveStar', 'Your privacy on LiveStar') : pick('شروط الاستخدام والمجتمع', 'Terms and community guidelines')}</h1>{privacy ? <><p>{pick('نستخدم معلومات الحساب لتسجيل دخولك وإظهار ملفك، وتشغيل البث والمحادثات التي تختار المشاركة فيها.', 'We use account information to sign you in, display your profile, and operate the streams and chats you choose to join.')}</p><h2>{pick('ما الذي يراه الآخرون؟', 'What can others see?')}</h2><p>{pick('اسمك الظاهر واسم المستخدم والنبذة معلومات عامة. يمكن للجمهور مشاهدة الصوت والصورة التي تنشرها، وقراءة رسائلك داخل البث. لا تشارك معلومات خاصة أثناء البث.', 'Your display name, username, and bio are public. People can watch the audio and video you broadcast and read your chat messages. Keep private information out of your streams.')}</p><h2>{pick('أمان حسابك', 'Account security')}</h2><p>{pick('تُحفظ كلمات المرور بصيغة مشتقة آمنة، وتُستخدم جلسات قابلة للإبطال. روابط تأكيد البريد والاستعادة مؤقتة وللاستخدام مرة واحدة.', 'Passwords are stored as secure derived hashes. Sessions can be revoked, and verification and recovery links expire and are single use.')}</p><h2>{pick('البث والتسجيل', 'Streaming and recording')}</h2><p>{pick('تطلب الكاميرا والميكروفون بإذنك عند بدء البث. هذه النسخة لا توفر ميزة تسجيل البث؛ وقد يستطيع المشاهدون تسجيل المحتوى بأدواتهم الخاصة.', 'Camera and microphone access is requested with your permission when you start streaming. This version does not offer stream recording; viewers may still record content using their own tools.')}</p></> : <><p>{pick('LiveStar مساحة للبث المباشر والمحادثة. يتطلب إنشاء حساب أن تبلغ 18 عاماً، وأن تكون معلومات التسجيل صحيحة.', 'LiveStar is a space for live streaming and chat. You must be at least 18 years old to create an account and provide accurate registration information.')}</p><h2>{pick('احترام المجتمع', 'Respect the community')}</h2><p>{pick('تجنّب التحرش والتهديد والمحتوى غير القانوني، واحترم خصوصية الأشخاص وحقوق أصحاب المحتوى. انشر فقط ما تملك حق مشاركته.', 'Avoid harassment, threats, and illegal content. Respect people’s privacy and content owners’ rights. Only publish content you have the right to share.')}</p><h2>{pick('مسؤولية البث', 'Your broadcast')}</h2><p>{pick('أنت مسؤول عما يظهر في بثك ورسائلك. احصل على موافقة من يظهر معك، ويمكنك إيقاف الكاميرا والميكروفون أو إنهاء البث في أي وقت.', 'You are responsible for your broadcast and messages. Obtain consent from people who appear with you. You can stop your camera, microphone, or broadcast at any time.')}</p><h2>{pick('توفر الخدمة', 'Service availability')}</h2><p>{pick('تتأثر جودة البث بسرعة الإنترنت والأجهزة. قد تتوقف الخدمة للصيانة، وقد يُقيَّد المحتوى أو الحساب عند مخالفة القواعد.', 'Stream quality depends on your connection and device. Service may be interrupted for maintenance, and content or accounts may be restricted for rule violations.')}</p></>}<h2>{pick('هدايا DU — تحديث 2026-11-15', 'DU gifts — update 2026-11-15')}</h2><p>{privacy ? pick('تُحفظ عمليات DU لحماية الرصيد ومنع التكرار. يظهر اسم المرسل والهدية في البث؛ رصيد محفظتك وسجل إنفاقك خاصان بك. يحتفظ سجل العمليات بمعرفات مرجعية بعد إخفاء بيانات الحساب عند طلب حذفه.', 'DU activity is recorded to protect balances and prevent duplicate spending. Sender names and gifts appear in the stream; your wallet balance and spending history are private. Activity records retain reference IDs after account details are pseudonymized on deletion.') : pick('DU عملات افتراضية ترويجية مجانية للهدايا داخل المنصة، وليست عملة مشفرة أو رصيدًا نقديًا. يمكنك استلام 100 DU لمرة واحدة. لا تتوفر مشتريات أو سحوبات، والهدايا المستلمة لا تنشئ أموالًا أو رصيدًا قابلًا للتحويل.', 'DU are free promotional virtual coins for in-app gifts, not cryptocurrency or money. You may claim 100 DU once. Purchases and withdrawals are unavailable. Receiving gifts does not create money or a transferable balance.')}</p><Link href="/" className="button secondary">{pick('العودة للبثوث', 'Back to streams')}</Link></article>;
}
