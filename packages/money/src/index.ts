/** All monetary quantities are integers. One USD microdollar = USD 0.000001. */
export const USD_MICRO_EXPONENT = 6;
export const FX_RATE_EXPONENT = 12;
const BASIS_POINTS = 10_000n;

function assertExponent(exponent: number): void {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 12) {
    throw new RangeError('Exponent must be an integer from 0 to 12');
  }
}

function assertNonNegative(value: bigint, label: string): void {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${label} must be a bigint`);
  }
  if (value < 0n) throw new RangeError(`${label} must be non-negative`);
}

/** Parse a non-negative, plain decimal without silently rounding excess precision. */
export function decimalToUnits(value: string, exponent: number): bigint {
  assertExponent(exponent);
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    throw new TypeError('Amount must be a canonical non-negative decimal string');
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > exponent) {
    throw new RangeError('Amount has more decimal places than the unit supports');
  }
  return BigInt(whole) * 10n ** BigInt(exponent)
    + BigInt(fraction.padEnd(exponent, '0') || '0');
}

/** Currency exponents come from the provider/currency registry; do not assume 2. */
export const decimalToMinor = decimalToUnits;

export function usdToMicros(value: string): bigint {
  return decimalToUnits(value, USD_MICRO_EXPONENT);
}

/** Format signed integer quantities for display or serialization; never uses Number. */
export function formatUnits(value: bigint, exponent: number): string {
  assertExponent(exponent);
  if (typeof value !== 'bigint') throw new TypeError('Value must be a bigint');
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const scale = 10n ** BigInt(exponent);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(exponent, '0');
  return `${negative ? '-' : ''}${whole}${exponent === 0 ? '' : `.${fraction}`}`;
}

/** Round a non-negative rational to an integer using round-half-to-even. */
export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  assertNonNegative(numerator, 'Numerator');
  assertNonNegative(denominator, 'Denominator');
  if (denominator === 0n) throw new RangeError('Denominator must be positive');
  const quotient = numerator / denominator;
  const twiceRemainder = (numerator % denominator) * 2n;
  if (twiceRemainder > denominator
    || (twiceRemainder === denominator && quotient % 2n !== 0n)) {
    return quotient + 1n;
  }
  return quotient;
}

/**
 * Convert provider currency minor units to USD microdollars. The caller persists
 * the original amount, currency, exponent, rate, source and timestamp together.
 * usdPerMajorUnit is USD per one major unit of the original currency, <=12 dp.
 */
export function convertToUsdMicros(
  originalMinor: bigint,
  originalCurrencyExponent: number,
  usdPerMajorUnit: string,
): bigint {
  assertNonNegative(originalMinor, 'Original amount');
  assertExponent(originalCurrencyExponent);
  const rate = decimalToUnits(usdPerMajorUnit, FX_RATE_EXPONENT);
  if (rate === 0n) throw new RangeError('Exchange rate must be positive');
  return roundHalfEven(
    originalMinor * rate * 10n ** BigInt(USD_MICRO_EXPONENT),
    10n ** BigInt(originalCurrencyExponent + FX_RATE_EXPONENT),
  );
}

export interface SettledRevenue {
  readonly grossUsdMicros: bigint;
  readonly processingFeesUsdMicros: bigint;
  readonly taxUsdMicros: bigint;
  readonly refundsUsdMicros: bigint;
  readonly disputesUsdMicros: bigint;
}

/**
 * Applies only authoritative, non-overlapping settlement amounts. This function
 * cannot verify a provider settlement. A negative adjustment belongs in a reversal
 * journal, not a negative coin lot or an implicitly clamped eligible balance.
 */
export function calculateEligibleNet(revenue: SettledRevenue): {
  readonly grossUsdMicros: bigint;
  readonly deductionsUsdMicros: bigint;
  readonly eligibleNetUsdMicros: bigint;
} {
  const fields = [
    'grossUsdMicros', 'processingFeesUsdMicros', 'taxUsdMicros',
    'refundsUsdMicros', 'disputesUsdMicros',
  ] as const;
  for (const field of fields) assertNonNegative(revenue[field], field);
  const deductions = revenue.processingFeesUsdMicros + revenue.taxUsdMicros
    + revenue.refundsUsdMicros + revenue.disputesUsdMicros;
  if (deductions > revenue.grossUsdMicros) {
    throw new RangeError('Deductions exceed gross revenue; book a separate loss/reversal');
  }
  return Object.freeze({
    grossUsdMicros: revenue.grossUsdMicros,
    deductionsUsdMicros: deductions,
    eligibleNetUsdMicros: revenue.grossUsdMicros - deductions,
  });
}

export interface RevenueSplitPolicy {
  readonly policyId: string;
  readonly creatorBps: number;
  readonly platformBps: number;
}

export const DEFAULT_REVENUE_SPLIT: RevenueSplitPolicy = Object.freeze({
  policyId: 'default-50-50',
  creatorBps: 5_000,
  platformBps: 5_000,
});

/** Round creator share down; platform receives the residual microdollar. */
export function splitEligibleNet(
  eligibleNetUsdMicros: bigint,
  policy: RevenueSplitPolicy = DEFAULT_REVENUE_SPLIT,
): {
  readonly eligibleNetUsdMicros: bigint;
  readonly creatorUsdMicros: bigint;
  readonly platformUsdMicros: bigint;
  readonly policy: RevenueSplitPolicy;
} {
  assertNonNegative(eligibleNetUsdMicros, 'Eligible net revenue');
  if (typeof policy.policyId !== 'string' || policy.policyId.trim().length === 0) {
    throw new TypeError('Revenue policy must have an immutable version identifier');
  }
  if (!Number.isInteger(policy.creatorBps) || !Number.isInteger(policy.platformBps)
    || policy.creatorBps < 0 || policy.platformBps < 0
    || policy.creatorBps > 10_000 || policy.platformBps > 10_000
    || policy.creatorBps + policy.platformBps !== 10_000) {
    throw new RangeError('Revenue shares must be integer basis points summing to 10000');
  }
  const creatorUsdMicros = eligibleNetUsdMicros * BigInt(policy.creatorBps) / BASIS_POINTS;
  return Object.freeze({
    eligibleNetUsdMicros,
    creatorUsdMicros,
    platformUsdMicros: eligibleNetUsdMicros - creatorUsdMicros,
    policy: Object.freeze({ ...policy }),
  });
}

/** Net revenue already attributed to a purchased-coin lot, never a cash-out value. */
export interface CoinLotAllocationState {
  readonly totalCoins: bigint;
  readonly netRevenueUsdMicros: bigint;
  readonly spentCoins: bigint;
  readonly attributedUsdMicros: bigint;
}

/**
 * Cumulative floor allocation conserves a lot's exact eligible settlement revenue;
 * the final coin receives every remaining microdollar. A later wallet service must
 * choose FIFO lots and lock/update them atomically with the gift and ledger entry.
 */
export function allocateCoinLotRevenue(
  lot: CoinLotAllocationState,
  spendCoins: bigint,
): {
  readonly allocatedUsdMicros: bigint;
  readonly remainingCoins: bigint;
  readonly remainingNetUsdMicros: bigint;
  readonly updatedLot: CoinLotAllocationState;
} {
  const fields = ['totalCoins', 'netRevenueUsdMicros', 'spentCoins', 'attributedUsdMicros'] as const;
  for (const field of fields) assertNonNegative(lot[field], field);
  assertNonNegative(spendCoins, 'Coins to spend');
  if (lot.totalCoins === 0n || spendCoins === 0n) {
    throw new RangeError('Lot size and spend must be positive');
  }
  if (lot.spentCoins > lot.totalCoins || spendCoins > lot.totalCoins - lot.spentCoins) {
    throw new RangeError('Coin allocation exceeds the remaining lot');
  }
  const expectedPrior = lot.netRevenueUsdMicros * lot.spentCoins / lot.totalCoins;
  if (lot.attributedUsdMicros !== expectedPrior) {
    throw new RangeError('Prior attribution does not match the cumulative allocation policy');
  }
  const spentCoins = lot.spentCoins + spendCoins;
  const attributedUsdMicros = lot.netRevenueUsdMicros * spentCoins / lot.totalCoins;
  return Object.freeze({
    allocatedUsdMicros: attributedUsdMicros - lot.attributedUsdMicros,
    remainingCoins: lot.totalCoins - spentCoins,
    remainingNetUsdMicros: lot.netRevenueUsdMicros - attributedUsdMicros,
    updatedLot: Object.freeze({ ...lot, spentCoins, attributedUsdMicros }),
  });
}
