/** DU are promotional, in-app gift coins. They have no cash redemption value. */
export interface DuWallet {
  currency: 'DU';
  balance: string;
  claimAvailable: boolean;
  receivedCoins: string;
  receivedGifts: string;
  promotional: true;
  purchasingEnabled: false;
}

export interface DuGift {
  id: string;
  slug: string;
  nameAr: string;
  nameEn: string;
  emoji: string;
  price: string;
  effect: string;
}

export interface DuTransaction {
  id: string;
  sequence: string;
  type: 'CLAIM' | 'GIFT';
  amount: string;
  balanceAfter: string;
  streamId: string | null;
  quantity: number | null;
  gift: DuGift | null;
  createdAt: string;
}

export interface DuGiftEvent {
  id: string;
  sequence: string;
  quantity: number;
  totalPrice: string;
  gift: DuGift;
  sender: { id: string; username: string | null; displayName: string };
  createdAt: string;
}

export interface DuGiftFeed {
  items: DuGiftEvent[];
  nextCursor: string;
  totalCoins: string;
  totalGifts: string;
}

export type DuMutation = { transaction: DuTransaction; wallet: DuWallet };
export type DuHistory = { items: DuTransaction[]; nextCursor: string | null };

/** Formatting never converts a financial integer through a JavaScript float. */
export function formatDu(value: string, locale: 'ar' | 'en'): string {
  try { return BigInt(value).toLocaleString(locale === 'ar' ? 'ar' : 'en-US'); }
  catch { return '—'; }
}

export function giftTotal(gift: DuGift, quantity: number): string {
  return (BigInt(gift.price) * BigInt(quantity)).toString();
}
