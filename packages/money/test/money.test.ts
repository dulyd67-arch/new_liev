import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  allocateCoinLotRevenue, calculateEligibleNet, convertToUsdMicros,
  decimalToMinor, DEFAULT_REVENUE_SPLIT, formatUnits, roundHalfEven,
  splitEligibleNet, usdToMicros,
} from '../src/index';

describe('exact amount parsing and formatting', () => {
  it('supports different currency exponents and exact USD microdollars', () => {
    assert.equal(decimalToMinor('129', 0), 129n); // JPY
    assert.equal(decimalToMinor('12.34', 2), 1_234n); // USD
    assert.equal(decimalToMinor('12.345', 3), 12_345n); // KWD
    assert.equal(usdToMicros('0.000001'), 1n);
    assert.equal(usdToMicros('12'), 12_000_000n);
    assert.equal(formatUnits(-12_345n, 3), '-12.345');
    assert.equal(formatUnits(0n, 6), '0.000000');
    assert.equal(formatUnits(123n, 0), '123');
  });

  it('retains amounts above JavaScript safe integer range', () => {
    const amount = '900719925474099312345678.123456';
    assert.equal(formatUnits(usdToMicros(amount), 6), amount);
  });

  it('rejects ambiguous, negative, exponential and excess-precision input', () => {
    for (const value of ['-1', '+1', '1e3', ' 1', '1 ', '.5', '1.', '01', '', 'NaN', 'Infinity']) {
      assert.throws(() => decimalToMinor(value, 2));
    }
    assert.throws(() => decimalToMinor('1.001', 2), RangeError);
    assert.throws(() => decimalToMinor('1.0', 0), RangeError);
    for (const exponent of [-1, 1.5, 13, Number.NaN]) {
      assert.throws(() => decimalToMinor('1', exponent), RangeError);
    }
    assert.throws(() => usdToMicros(1 as unknown as string), TypeError);
  });
});

describe('FX conversion', () => {
  it('uses exact USD-per-major-unit rates with currency-specific exponents', () => {
    assert.equal(convertToUsdMicros(1_234n, 2, '1'), 12_340_000n);
    assert.equal(convertToUsdMicros(1_000n, 0, '0.0067'), 6_700_000n);
    assert.equal(convertToUsdMicros(1_234n, 3, '3.25'), 4_010_500n);
  });

  it('rounds ties to even at the microdollar, without binary floating point', () => {
    assert.equal(roundHalfEven(5n, 2n), 2n);
    assert.equal(roundHalfEven(7n, 2n), 4n);
    assert.equal(roundHalfEven(8n, 3n), 3n);
    assert.equal(roundHalfEven(7n, 3n), 2n);
    assert.equal(convertToUsdMicros(1n, 0, '0.0000005'), 0n);
    assert.equal(convertToUsdMicros(3n, 0, '0.0000005'), 2n);
  });

  it('supports huge integer amounts and zero amounts', () => {
    const amount = 9_007_199_254_740_993_123n;
    assert.equal(convertToUsdMicros(amount, 2, '1'), amount * 10_000n);
    assert.equal(convertToUsdMicros(0n, 2, '1.234567890123'), 0n);
  });

  it('rejects zero/negative rates, wrong types and unsupported precision', () => {
    for (const rate of ['0', '-1', '1.0000000000001']) {
      assert.throws(() => convertToUsdMicros(1n, 2, rate));
    }
    assert.throws(() => convertToUsdMicros(-1n, 2, '1'), RangeError);
    assert.throws(() => convertToUsdMicros(1 as unknown as bigint, 2, '1'), TypeError);
    assert.throws(() => roundHalfEven(1n, 0n), RangeError);
  });
});

describe('eligible net settlement revenue', () => {
  const settlement = {
    grossUsdMicros: usdToMicros('10'),
    processingFeesUsdMicros: usdToMicros('0.5'),
    taxUsdMicros: usdToMicros('1'),
    refundsUsdMicros: usdToMicros('0.25'),
    disputesUsdMicros: usdToMicros('0.25'),
  };

  it('subtracts applicable authoritative amounts exactly', () => {
    assert.deepEqual(calculateEligibleNet(settlement), {
      grossUsdMicros: 10_000_000n,
      deductionsUsdMicros: 2_000_000n,
      eligibleNetUsdMicros: 8_000_000n,
    });
  });

  it('permits zero eligible revenue and rejects losses rather than hiding them', () => {
    assert.equal(calculateEligibleNet({ ...settlement, grossUsdMicros: 2_000_000n }).eligibleNetUsdMicros, 0n);
    assert.throws(() => calculateEligibleNet({ ...settlement, grossUsdMicros: 1n }), RangeError);
    assert.throws(() => calculateEligibleNet({ ...settlement, refundsUsdMicros: -1n }), RangeError);
  });
});

describe('revenue sharing', () => {
  it('splits 50/50 with all units conserved and residual assigned to platform', () => {
    const split = splitEligibleNet(5n);
    assert.equal(split.creatorUsdMicros, 2n);
    assert.equal(split.platformUsdMicros, 3n);
    assert.equal(split.creatorUsdMicros + split.platformUsdMicros, split.eligibleNetUsdMicros);
    assert.deepEqual(split.policy, DEFAULT_REVENUE_SPLIT);
    assert.ok(Object.isFrozen(split.policy));
  });

  it('snapshots a supplied future policy without aliasing mutable input', () => {
    const policy = { policyId: 'v2', creatorBps: 6_000, platformBps: 4_000 };
    const split = splitEligibleNet(10n ** 25n, policy);
    policy.creatorBps = 7_000;
    assert.equal(split.policy.creatorBps, 6_000);
    assert.equal(split.creatorUsdMicros, 6n * 10n ** 24n);
    assert.equal(split.platformUsdMicros, 4n * 10n ** 24n);
  });

  it('permits zero and boundary share policies', () => {
    assert.equal(splitEligibleNet(0n).creatorUsdMicros, 0n);
    assert.equal(splitEligibleNet(9n, { policyId: 'all', creatorBps: 10_000, platformBps: 0 }).creatorUsdMicros, 9n);
    assert.equal(splitEligibleNet(9n, { policyId: 'none', creatorBps: 0, platformBps: 10_000 }).platformUsdMicros, 9n);
  });

  it('rejects negative amounts, non-integer basis points and invalid policy totals', () => {
    assert.throws(() => splitEligibleNet(-1n), RangeError);
    for (const policy of [
      { policyId: 'bad', creatorBps: 5_001, platformBps: 5_000 },
      { policyId: 'bad', creatorBps: 5_000.5, platformBps: 4_999.5 },
      { policyId: 'bad', creatorBps: -1, platformBps: 10_001 },
      { policyId: '', creatorBps: 5_000, platformBps: 5_000 },
    ]) assert.throws(() => splitEligibleNet(1n, policy));
  });
});

describe('purchased-coin lot revenue allocation', () => {
  const initial = { totalCoins: 3n, netRevenueUsdMicros: 10n, spentCoins: 0n, attributedUsdMicros: 0n };

  it('conserves actual net settlement value; the final coin takes the remainder', () => {
    const one = allocateCoinLotRevenue(initial, 1n);
    const two = allocateCoinLotRevenue(one.updatedLot, 1n);
    const three = allocateCoinLotRevenue(two.updatedLot, 1n);
    assert.deepEqual([one.allocatedUsdMicros, two.allocatedUsdMicros, three.allocatedUsdMicros], [3n, 3n, 4n]);
    assert.equal(three.remainingCoins, 0n);
    assert.equal(three.remainingNetUsdMicros, 0n);
    assert.equal(three.updatedLot.attributedUsdMicros, 10n);
  });

  it('has the same cumulative attribution for one spend or several spends', () => {
    for (let total = 1n; total <= 17n; total++) {
      for (let net = 0n; net <= 23n; net++) {
        let lot = { totalCoins: total, netRevenueUsdMicros: net, spentCoins: 0n, attributedUsdMicros: 0n };
        let allocated = 0n;
        for (let spent = 0n; spent < total; spent++) {
          const result = allocateCoinLotRevenue(lot, 1n);
          lot = result.updatedLot;
          allocated += result.allocatedUsdMicros;
        }
        assert.equal(allocated, allocateCoinLotRevenue({ ...lot, spentCoins: 0n, attributedUsdMicros: 0n }, total).allocatedUsdMicros);
        assert.equal(allocated, net);
      }
    }
  });

  it('preserves attribution at intermediate partitions, including metadata-bearing records', () => {
    const persistedLot = { ...initial, id: 'persisted-lot' };
    const one = allocateCoinLotRevenue(persistedLot, 1n);
    const two = allocateCoinLotRevenue(one.updatedLot, 1n);
    const batch = allocateCoinLotRevenue(initial, 2n);
    assert.equal(one.allocatedUsdMicros + two.allocatedUsdMicros, batch.allocatedUsdMicros);
    assert.equal(two.remainingNetUsdMicros, batch.remainingNetUsdMicros);
    assert.deepEqual(two.updatedLot, { ...batch.updatedLot, id: 'persisted-lot' });
  });

  it('rejects overspending, corrupt attribution and invalid lots', () => {
    assert.throws(() => allocateCoinLotRevenue(initial, 4n), RangeError);
    assert.throws(() => allocateCoinLotRevenue(initial, 0n), RangeError);
    assert.throws(() => allocateCoinLotRevenue(initial, -1n), RangeError);
    assert.throws(() => allocateCoinLotRevenue({ ...initial, totalCoins: 0n }, 1n), RangeError);
    assert.throws(() => allocateCoinLotRevenue({ ...initial, spentCoins: 1n, attributedUsdMicros: 2n }, 1n), RangeError);
    assert.throws(() => allocateCoinLotRevenue({ ...initial, spentCoins: 4n }, 1n), RangeError);
    assert.throws(() => allocateCoinLotRevenue({ ...initial, totalCoins: 3 as unknown as bigint }, 1n), TypeError);
    assert.throws(() => allocateCoinLotRevenue({ ...initial, spentCoins: undefined as unknown as bigint }, 1n), TypeError);
    const invalidPrototype = Object.create({
      totalCoins: -1n, netRevenueUsdMicros: -1n, spentCoins: -2n, attributedUsdMicros: -2n,
    });
    assert.throws(() => allocateCoinLotRevenue(invalidPrototype, 1n), RangeError);
  });
});
