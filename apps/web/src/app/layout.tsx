import type { Metadata } from 'next';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'LiveStar — لحظتك تبدأ هنا', template: '%s | LiveStar' },
  description: 'LiveStar: منصة البث المباشر والتواصل مع المبدعين. Your stage. Your community. Your moment.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl" suppressHydrationWarning><body><Providers>{children}</Providers></body></html>;
}
