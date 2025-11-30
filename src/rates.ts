import { RateCache, RateCacheEntry } from "./types.ts";
import { round2 } from "./utils.ts";

export class RateStore {
  #path: string;
  #cache: RateCache;

  constructor(path: string) {
    this.#path = path;
    this.#cache = {};
  }

  async load(): Promise<void> {
    try {
      const text = await Deno.readTextFile(this.#path);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const normalized: RateCache = {};
      for (const [date, value] of Object.entries(parsed)) {
        const val = value as Record<string, unknown>;
        if ("pairs" in val || "cbr" in val || "exchangeUsd" in val) {
          normalized[date] = {
            pairs: (val.pairs as Record<string, number>) ?? {},
            cbr: val.cbr as Record<string, number> | undefined,
            exchangeUsd: val.exchangeUsd as Record<string, number> | undefined,
          };
        } else {
          normalized[date] = { pairs: val as Record<string, number> };
        }
      }
      this.#cache = normalized;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        this.#cache = {};
        return;
      }
      throw err;
    }
  }

  async save(): Promise<void> {
    await Deno.writeTextFile(this.#path, JSON.stringify(this.#cache, null, 2));
  }

  get(date: string, from: string, to: string): number | undefined {
    const entry = this.#cache[date];
    if (!entry) return undefined;
    const direct = entry.pairs?.[`${from}->${to}`];
    if (direct !== undefined) return direct;

    const computed = computeFromRaw(entry, from, to);
    if (computed !== undefined) {
      this.set(date, from, to, computed);
      this.set(date, to, from, 1 / computed);
      return computed;
    }
    return undefined;
  }

  set(date: string, from: string, to: string, rate: number): void {
    if (!this.#cache[date]) this.#cache[date] = { pairs: {} };
    this.#cache[date].pairs[`${from}->${to}`] = round2(rate);
  }

  setRaw(date: string, raw: RawRateData): void {
    if (!this.#cache[date]) this.#cache[date] = { pairs: {} };
    if (raw.kind === "cbr") {
      this.#cache[date].cbr = raw.rates;
    } else if (raw.kind === "exchangeUsd") {
      this.#cache[date].exchangeUsd = raw.rates;
    }
  }
}

export interface RateProvider {
  getRate(date: string, from: string, to: string): Promise<number>;
}

export type RawRateData =
  | { kind: "cbr"; rates: Record<string, number> }
  | { kind: "exchangeUsd"; rates: Record<string, number> };

export interface RawRateProvider extends RateProvider {
  getRaw(date: string): Promise<RawRateData>;
}

export class CompositeRateProvider implements RateProvider {
  constructor(private providers: RateProvider[]) {}

  async getRate(date: string, from: string, to: string): Promise<number> {
    for (const provider of this.providers) {
      try {
        return await provider.getRate(date, from, to);
      } catch (_err) {
        continue;
      }
    }
    throw new Error(`No rate available for ${from}->${to} on ${date}`);
  }
}

export class CachedRateProvider implements RateProvider {
  constructor(private store: RateStore, private upstream: RateProvider) {}

  async getRate(date: string, from: string, to: string): Promise<number> {
    if (from === to) return 1;
    const cached = this.store.get(date, from, to);
    if (cached !== undefined) return cached;

    if (isRawProvider(this.upstream)) {
      const raw = await this.upstream.getRaw(date);
      this.store.setRaw(date, raw);
      const computed = this.store.get(date, from, to);
      if (computed !== undefined) return computed;
    }

    const value = await this.upstream.getRate(date, from, to);
    this.store.set(date, from, to, value);
    this.store.set(date, to, from, 1 / value);
    return value;
  }
}

export class CbrRateProvider implements RawRateProvider {
  async getRate(date: string, from: string, to: string): Promise<number> {
    if (from === to) return 1;
    const rates = await this.fetch(date);
    const fromRate = from === "RUB" ? 1 : rates[from.toUpperCase()];
    const toRate = to === "RUB" ? 1 : rates[to.toUpperCase()];
    if (!fromRate || !toRate) throw new Error("Missing CBR rate");
    return round2(fromRate / toRate);
  }

  async getRaw(date: string): Promise<RawRateData> {
    const rates = await this.fetch(date);
    return { kind: "cbr", rates };
  }

  private async fetch(date: string): Promise<Record<string, number>> {
    const [year, month, day] = date.split("-");
    const queryDate = `${day}/${month}/${year}`;
    const url = `https://www.cbr.ru/scripts/XML_daily_eng.asp?date_req=${queryDate}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CBR fetch failed ${res.status}`);
    const body = await res.text();
    return parseCbrXml(body);
  }
}

export class ExchangeApiRateProvider implements RawRateProvider {
  async getRate(date: string, from: string, to: string): Promise<number> {
    if (from === to) return 1;
    const payload = await this.fetch(date);
    const usdRates = payload.usd as Record<string, number>;
    const fromKey = from.toLowerCase();
    const toKey = to.toLowerCase();
    const fromRate = usdRates[fromKey];
    const toRate = usdRates[toKey];
    if (!fromRate || !toRate) throw new Error("Missing exchange-api rate");
    return round2(toRate / fromRate);
  }

  async getRaw(date: string): Promise<RawRateData> {
    const payload = await this.fetch(date);
    return { kind: "exchangeUsd", rates: payload.usd as Record<string, number> };
  }

  private async fetch(date: string): Promise<{ date: string; usd: Record<string, number> }> {
    const url = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Exchange-api fetch failed ${res.status}`);
    return res.json();
  }
}

function parseCbrXml(xml: string): Record<string, number> {
  const result: Record<string, number> = { RUB: 1 };
  const valuteBlocks = xml.split(/<Valute[^>]*>/).slice(1);
  for (const block of valuteBlocks) {
    const charCodeMatch = block.match(/<CharCode>([^<]+)<\/CharCode>/);
    const nominalMatch = block.match(/<Nominal>([^<]+)<\/Nominal>/);
    const valueMatch = block.match(/<Value>([^<]+)<\/Value>/);
    if (!charCodeMatch || !valueMatch || !nominalMatch) continue;
    const code = charCodeMatch[1].toUpperCase();
    const nominal = Number(nominalMatch[1].replace(",", "."));
    const value = Number(valueMatch[1].replace(",", "."));
    if (!Number.isFinite(value) || !Number.isFinite(nominal) || nominal === 0) continue;
    result[code] = value / nominal;
  }
  return result;
}

function isRawProvider(provider: RateProvider): provider is RawRateProvider {
  return (provider as RawRateProvider).getRaw !== undefined;
}

function computeFromRaw(entry: RateCacheEntry, from: string, to: string): number | undefined {
  if (from === to) return 1;
  const upperFrom = from.toUpperCase();
  const upperTo = to.toUpperCase();

  if (entry.cbr) {
    const fromRate = upperFrom === "RUB" ? 1 : entry.cbr[upperFrom];
    const toRate = upperTo === "RUB" ? 1 : entry.cbr[upperTo];
    if (fromRate && toRate) {
      return round2(fromRate / toRate);
    }
  }

  if (entry.exchangeUsd) {
    const fromKey = from.toLowerCase();
    const toKey = to.toLowerCase();
    const fromRate = entry.exchangeUsd[fromKey];
    const toRate = entry.exchangeUsd[toKey];
    if (fromRate && toRate) {
      return round2(toRate / fromRate);
    }
  }

  return undefined;
}
