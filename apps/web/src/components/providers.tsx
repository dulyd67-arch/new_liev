'use client';
import type { ReactNode } from 'react';
import { LocaleProvider } from '@/lib/locale';
import { AuthProvider } from '@/lib/auth';
import { Shell } from './shell';

export function Providers({ children }: { children: ReactNode }) {
  return <LocaleProvider><AuthProvider><Shell>{children}</Shell></AuthProvider></LocaleProvider>;
}
