import type { Metadata } from 'next';
import { HomePage } from '@/components/home-page';
import { PUBLIC_SITE_URL, SITE_DESCRIPTION, SITE_TITLE } from '@/lib/site';

// The public homepage opts into search. Account and app routes retain the
// root layout's noindex default.
export const metadata: Metadata = {
  title: { absolute: SITE_TITLE },
  description: SITE_DESCRIPTION,
  alternates: { canonical: PUBLIC_SITE_URL },
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    siteName: 'LiveStar',
    url: PUBLIC_SITE_URL,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: { card: 'summary', title: SITE_TITLE, description: SITE_DESCRIPTION },
};

const website = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'LiveStar',
  alternateName: 'لايف ستار',
  url: PUBLIC_SITE_URL,
  inLanguage: ['ar', 'en'],
};

export default function Page() {
  return <>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(website).replace(/</g, '\\u003c') }} />
    <HomePage />
  </>;
}
