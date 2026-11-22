import type { MetadataRoute } from 'next';
import { PUBLIC_SITE_URL } from '@/lib/site';

export default function sitemap(): MetadataRoute.Sitemap {
  // Only the public, indexable landing page belongs in this sitemap.
  // Auth screens, wallets and temporary broadcasts keep their noindex default.
  return [{ url: PUBLIC_SITE_URL }];
}
