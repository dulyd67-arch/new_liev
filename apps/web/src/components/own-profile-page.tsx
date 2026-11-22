'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LoaderCircle } from 'lucide-react';
import { RequireAuth, useAuth } from '@/lib/auth';
import { useLocale } from '@/lib/locale';

function OpenOwnProfile() {
  const { user } = useAuth();
  const { pick } = useLocale();
  const router = useRouter();
  const username = user?.profile?.username;
  useEffect(() => {
    if (username) router.replace(`/u/${encodeURIComponent(username)}`);
  }, [router, username]);
  return <div className="empty-state card" role="status">
    {username ? <><LoaderCircle className="spin" size={26} /><p>{pick('جارٍ فتح ملفك الشخصي…', 'Opening your profile…')}</p></>
      : <><h1>{pick('الملف الشخصي غير متاح', 'Profile unavailable')}</h1><Link href="/settings" className="button secondary">{pick('إعدادات الحساب', 'Account settings')}</Link></>}
  </div>;
}

export function OwnProfilePage() {
  return <RequireAuth><OpenOwnProfile /></RequireAuth>;
}
