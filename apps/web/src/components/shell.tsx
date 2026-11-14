'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Globe2, LogOut, Radio, Settings2, Star, Video } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';

export function Brand() {
  return <Link href="/" className="brand" aria-label="LiveStar"><span className="brand-icon"><Star size={25} fill="currentColor" strokeWidth={1.5} /></span><span>Live<span className="gold-text">Star</span><small>TOGETHER, LIVE.</small></span></Link>;
}
export function Shell({ children }: { children: ReactNode }) {
  const { pick, locale, setLocale } = useLocale();
  const { user, logout } = useAuth();
  const pathname = usePathname(); const router = useRouter();
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">{pick('انتقل إلى المحتوى', 'Skip to content')}</a>
    <header className="topbar"><Brand />
      <nav className="main-navigation" aria-label={pick('القائمة الرئيسية', 'Main navigation')}>
        <Link href="/" className={`nav-link ${pathname === '/' ? 'active' : ''}`} aria-current={pathname === '/' ? 'page' : undefined}><Radio size={18} />{pick('مباشر الآن', 'Live now')}</Link>
        <Link href="/go-live" className={`nav-link ${pathname === '/go-live' ? 'active' : ''}`} aria-current={pathname === '/go-live' ? 'page' : undefined}><Video size={18} />{pick('استوديو البث', 'Your studio')}</Link>
      </nav>
      <div className="top-actions"><button className="locale-button" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} aria-label={pick('Switch to English', 'التبديل إلى العربية')}><Globe2 size={17} /><span>{locale === 'ar' ? 'EN' : 'عربي'}</span></button>
        {user ? <><Link href="/settings" className="account-button" aria-label={pick('إعدادات حسابي', 'Account settings')}><span className="avatar mini">{(user.profile?.displayName || user.email).slice(0, 1)}</span><span className="account-name">{user.profile?.displayName || user.profile?.username}</span><Settings2 size={16} /></Link><button className="icon-button" aria-label={pick('تسجيل الخروج', 'Sign out')} onClick={() => { void logout().then(() => router.push('/')).catch(() => router.push('/')); }}><LogOut size={18} /></button></> : <Link className="button secondary small" href="/login">{pick('تسجيل الدخول', 'Sign in')}</Link>}
      </div>
    </header>
    <main id="main-content" className="page-content">{children}</main>
    <footer className="site-footer"><Brand /><span>{pick('مساحة بسيطة للحظات المباشرة.', 'A simple space for live moments.')}</span><nav><Link href="/privacy">{pick('الخصوصية', 'Privacy')}</Link><Link href="/terms">{pick('الشروط', 'Terms')}</Link></nav></footer>
  </div>;
}
