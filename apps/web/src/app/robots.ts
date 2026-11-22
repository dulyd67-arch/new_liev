import type { MetadataRoute } from 'next';
import { PUBLIC_SITE_URL } from '@/lib/site';

export default function robots(): MetadataRoute.Robots {
  return {
    // App pages remain crawlable so search engines can read their noindex
    // metadata. API endpoints are not public search documents.
    rules: { userAgent: '*', allow: '/', disallow: '/api/' },
    sitemap: new URL('sitemap.xml', PUBLIC_SITE_URL).toString(),
  };
}
