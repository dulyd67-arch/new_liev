import 'dotenv/config';
import { PrismaClient, PaymentProvider } from '@prisma/client';

// The seed creates configuration only. It never creates users, balances, receipts,
// settlements, gifts sent, or payouts, and never enables a payment product.
const ownerUrl = process.env.DATABASE_MIGRATION_URL;
if (!ownerUrl) {
  throw new Error('DATABASE_MIGRATION_URL is required for reference configuration seeding.');
}
const prisma = new PrismaClient({ datasources: { db: { url: ownerUrl } } });

async function main(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const roles = [
      { name: 'USER', permissions: ['profile:own', 'stream:watch', 'chat:send'] },
      { name: 'CREATOR', permissions: ['stream:host', 'earnings:own', 'payout:request'] },
      { name: 'MODERATOR', permissions: ['report:review', 'stream:moderate'] },
      { name: 'ADMIN', permissions: ['catalog:manage', 'payout:review', 'analytics:read'] },
      { name: 'SUPER_ADMIN', permissions: ['role:manage', 'revenue:configure', 'settings:manage'] },
    ];
    for (const role of roles) {
      await tx.role.upsert({ where: { name: role.name }, create: role, update: {} });
    }

    // Immutable baseline. Later policies are appended with a future effective_at.
    await tx.revenueSplit.upsert({
      where: { id: '00000000-0000-4000-8000-000000000001' },
      create: {
        id: '00000000-0000-4000-8000-000000000001',
        creatorBps: 5000,
        platformBps: 5000,
        effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
        reason: 'Initial LiveStar policy: 50% creator / 50% platform of eligible net gift revenue.',
      },
      update: {},
    });

    const gifts = [
      { code: 'STAR', nameAr: 'نجمة', nameEn: 'Star', priceCoins: 10n },
      { code: 'ROSE', nameAr: 'وردة', nameEn: 'Rose', priceCoins: 50n },
      { code: 'CROWN', nameAr: 'تاج', nameEn: 'Crown', priceCoins: 500n },
    ];
    for (const gift of gifts) {
      await tx.gift.upsert({ where: { code: gift.code }, create: { ...gift, active: false }, update: {} });
    }
    // Catalog examples remain disabled until regional/provider products and terms
    // are approved. Their display price is not evidence of a settled receipt.
    const packages = [
      { code: 'WEB_USD_100', coins: 100n, priceMinor: 199n, provider: PaymentProvider.STRIPE },
      { code: 'ANDROID_USD_100', coins: 100n, priceMinor: 199n, provider: PaymentProvider.GOOGLE },
      { code: 'IOS_USD_100', coins: 100n, priceMinor: 199n, provider: PaymentProvider.APPLE },
    ];
    for (const coinPackage of packages) {
      await tx.coinPackage.upsert({
        where: { code: coinPackage.code },
        create: { ...coinPackage, currency: 'USD', currencyExponent: 2, active: false },
        update: {},
      });
    }
    const settings = [
      { key: 'platform.reference_currency', value: 'USD' },
      { key: 'platform.supported_locales', value: ['ar', 'en'] },
      { key: 'payments.enabled', value: false },
      { key: 'payouts.enabled', value: false },
      { key: 'streaming.enabled', value: false },
      { key: 'accounting.usd_scale', value: 6 },
      { key: 'accounting.coin_to_cash_redemption_enabled', value: false },
    ];
    for (const setting of settings) {
      await tx.platformSetting.upsert({
        where: { key: setting.key },
        create: setting,
        update: {},
      });
    }
  });
  console.log('LiveStar reference configuration seeded; all payment and payout features remain disabled.');
}

main()
  .catch(() => {
    console.error('LiveStar configuration seed failed. Check database access and applied migrations; no credentials are logged.');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
