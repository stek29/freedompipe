import { NormalizedTransaction } from "./types.ts";

export interface TransferPair {
  income: NormalizedTransaction;
  outcome: NormalizedTransaction;
  rateDelta: number;
}

export function pairSameCurrency(
  incomes: NormalizedTransaction[],
  outcomes: NormalizedTransaction[],
): TransferPair[] {
  const pairs: TransferPair[] = [];
  const sortedIncome = [...incomes].sort(stableCompare);
  const sortedOutcome = [...outcomes].sort(stableCompare);

  const keyFor = (tx: NormalizedTransaction): string =>
    `${tx.docNumber}|${tx.txnDate}|${tx.accountCurrency}|${tx.amount.toFixed(2)}`;

  const bucket = new Map<string, NormalizedTransaction[]>();
  for (const inc of sortedIncome) {
    const key = keyFor(inc);
    const list = bucket.get(key) ?? [];
    list.push(inc);
    bucket.set(key, list);
  }

  for (const out of sortedOutcome) {
    const key = keyFor(out);
    const list = bucket.get(key);
    if (!list || list.length === 0) continue;
    const inc = list.shift()!;
    if (list.length === 0) bucket.delete(key);
    pairs.push({ income: inc, outcome: out, rateDelta: 0 });
  }

  return pairs;
}

export async function pairFx(
  incomes: NormalizedTransaction[],
  outcomes: NormalizedTransaction[],
  requireHint: boolean,
  maxRelDelta: number,
  getRate: (date: string, from: string, to: string) => Promise<number>,
): Promise<TransferPair[]> {
  const BASE = "RUB";
  const pairs: TransferPair[] = [];
  const usedIncome = new Set<string>();
  const usedOutcome = new Set<string>();

  const sortedIncome = [...incomes].sort(stableCompare);
  const sortedOutcome = [...outcomes].sort(stableCompare);

  const toBaseValue = async (tx: NormalizedTransaction): Promise<number | null> => {
    const rate = await safeGetRate(getRate, tx.txnDate, tx.accountCurrency, BASE);
    if (rate === null) return null;
    return tx.amount * rate;
  };

  for (const out of sortedOutcome) {
    if (requireHint && !out.conversionHint) continue;
    if (usedOutcome.has(out.bankId)) continue;
    const outBase = await toBaseValue(out);
    if (outBase === null || outBase === 0) continue;

    let best: { inc: NormalizedTransaction; delta: number } | null = null;
    for (const inc of sortedIncome) {
      if (usedIncome.has(inc.bankId) || usedOutcome.has(out.bankId)) continue;
      if (requireHint && !inc.conversionHint) continue;
      if (inc.txnDate !== out.txnDate) continue;
      if (inc.accountCurrency === out.accountCurrency) continue;

      const incBase = await toBaseValue(inc);
      if (incBase === null) continue;

      const delta = Math.abs(incBase - outBase) / outBase;
      if (delta <= maxRelDelta) {
        if (!best || delta < best.delta) {
          best = { inc, delta };
        }
      }
    }
    if (best) {
      usedIncome.add(best.inc.bankId);
      usedOutcome.add(out.bankId);
      pairs.push({ income: best.inc, outcome: out, rateDelta: best.delta });
    }
  }
  return pairs;
}

function stableKey(tx: NormalizedTransaction): string {
  return `${tx.txnDate}-${tx.amount.toFixed(2)}-${tx.docNumber}`;
}

function stableCompare(
  a: NormalizedTransaction,
  b: NormalizedTransaction,
): number {
  const aKey = stableKey(a);
  const bKey = stableKey(b);
  if (aKey === bKey) return 0;
  return aKey < bKey ? -1 : 1;
}

async function safeGetRate(
  fn: (date: string, from: string, to: string) => Promise<number>,
  date: string,
  from: string,
  to: string,
): Promise<number | null> {
  try {
    return await fn(date, from, to);
  } catch (_err) {
    return null;
  }
}
