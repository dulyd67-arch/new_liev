'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'ar' | 'en';
interface LocaleValue { locale: Locale; setLocale: (locale: Locale) => void; pick: (ar: string, en: string) => string; }
const LocaleContext = createContext<LocaleValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>('ar');
  useEffect(() => { if (localStorage.getItem('livestar-locale') === 'en') updateLocale('en'); }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'ar' ? 'rtl' : 'ltr';
  }, [locale]);
  const setLocale = useCallback((value: Locale) => {
    updateLocale(value); localStorage.setItem('livestar-locale', value);
  }, []);
  const pick = useCallback((ar: string, en: string) => locale === 'ar' ? ar : en, [locale]);
  const value = useMemo(() => ({ locale, setLocale, pick }), [locale, setLocale, pick]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error('LocaleProvider is required.');
  return value;
}
