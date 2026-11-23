'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Compass, Globe2, LogOut, Radio, ShieldCheck, Star, UserRound, Video, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';
import { safeAvatarSource } from '@/lib/profiles';
import styles from './shell.module.css';

export function Brand() {
  return <Link href="/" className="brand" aria-label="LiveStar"><span className="brand-icon"><Star size={25} fill="currentColor" strokeWidth={1.5} /></span><span>Live<span className="gold-text">Star</span><small>TOGETHER, LIVE.</small></span></Link>;
}
export function Shell({ children }: { children: ReactNode }) {
  const { pick, locale, setLocale } = useLocale();
  const { user, actor, logout } = useAuth();
  const pathname = usePathname(); const router = useRouter();
  const isHome = pathname === '/';
  const isProfile = pathname === '/profile' || pathname.startsWith('/u/');
  const isAdmin = pathname === '/admin';
  const useAppShell = isHome || isProfile || isAdmin;
  const canManage = actor?.roles.some(role => role === 'ADMIN' || role === 'SUPER_ADMIN');
  const ownProfileHref = user?.profile?.username ? `/u/${encodeURIComponent(user.profile.username)}` : '/profile';
  const isOwnProfile = pathname === '/profile' || (!!user?.profile?.username && pathname === ownProfileHref);
  const avatar = safeAvatarSource(user?.profile?.avatarKey);
  if (pathname === '/go-live' || /^\/live\/[^/]+$/.test(pathname)) return <main id="main-content">{children}</main>;
  return <div className={`app-shell ${useAppShell ? styles.shell : ''}`}>
    <a className="skip-link" href="#main-content">{pick('انتقل إلى المحتوى', 'Skip to content')}</a>
    <header className={`topbar ${useAppShell ? styles.header : ''}`}><Brand />
      <nav className="main-navigation" aria-label={pick('القائمة الرئيسية', 'Main navigation')}>
        <Link href="/" className={`nav-link ${pathname === '/' ? 'active' : ''}`} aria-current={pathname === '/' ? 'page' : undefined}><Radio size={18} />{useAppShell ? pick('اكتشف', 'Discover') : pick('مباشر الآن', 'Live now')}</Link>
        <Link href="/go-live" className={`nav-link ${pathname === '/go-live' ? 'active' : ''}`} aria-current={pathname === '/go-live' ? 'page' : undefined}><Video size={18} />{pick('استوديو البث', 'Your studio')}</Link>
        <Link href="/wallet" className={`nav-link ${pathname === '/wallet' ? 'active' : ''}`} aria-current={pathname === '/wallet' ? 'page' : undefined}><Wallet size={18} />{pick('محفظة DU', 'DU wallet')}</Link>
      </nav>
      <div className="top-actions">{canManage && <Link href="/admin" className={`icon-button ${styles.adminLink}`} aria-current={isAdmin ? 'page' : undefined} aria-label={pick('لوحة الإدارة', 'Admin dashboard')} title={pick('لوحة الإدارة', 'Admin dashboard')} data-testid="admin-navigation-link"><ShieldCheck size={19} /></Link>}<button className="locale-button" onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} aria-label={pick('Switch to English', 'التبديل إلى العربية')}><Globe2 size={17} /><span>{locale === 'ar' ? 'EN' : 'عربي'}</span></button>
        {user ? <><Link href={ownProfileHref} className="account-button" aria-label={pick('ملفي الشخصي', 'My profile')}><span className="avatar mini">{avatar ? <img className={styles.accountAvatar} src={avatar} alt="" /> : Array.from(user.profile?.displayName || user.profile?.username || 'L')[0]}</span><span className="account-name">{user.profile?.displayName || user.profile?.username}</span></Link><button className="icon-button" aria-label={pick('تسجيل الخروج', 'Sign out')} onClick={() => { void logout().then(() => router.push('/')).catch(() => router.push('/')); }}><LogOut size={18} /></button></> : <Link className={`button secondary small ${useAppShell ? styles.login : ''}`} href="/login">{pick('تسجيل الدخول', 'Sign in')}</Link>}
      </div>
    </header>
    <main id="main-content" className={`page-content ${useAppShell ? styles.content : ''}`}>{children}</main>
    <footer className={`site-footer ${useAppShell ? styles.footer : ''}`}><Brand /><span>{pick('مساحة بسيطة للحظات المباشرة.', 'A simple space for live moments.')}</span><nav><Link href="/privacy">{pick('الخصوصية', 'Privacy')}</Link><Link href="/terms">{pick('الشروط', 'Terms')}</Link></nav></footer>
    {(isHome || isProfile) && <nav className={styles.mobileNavigation} aria-label={pick('التنقل السريع', 'Quick navigation')} data-testid="home-mobile-navigation">
      <Link href="/" aria-current={isHome ? 'page' : undefined} className={isHome ? styles.current : undefined}><Compass size={23} /><span>{pick('اكتشف', 'Discover')}</span></Link>
      <Link href="/go-live" className={styles.broadcast}><span className={styles.broadcastIcon}><Video size={22} /></span><span>{pick('ابدأ بثًا', 'Go live')}</span></Link>
      <Link href="/wallet"><Wallet size={22} /><span>{pick('المحفظة', 'Wallet')}</span></Link>
      <Link href={ownProfileHref} aria-current={isOwnProfile ? 'page' : undefined} className={isOwnProfile ? styles.current : undefined}><UserRound size={22} /><span>{pick('حسابي', 'Account')}</span></Link>
    </nav>}
  </div>;
}
