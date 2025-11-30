import { encodeHex } from "std/encoding/hex";

const encoder = new TextEncoder();

export async function sha1Hex(value: string): Promise<string> {
  const data = encoder.encode(value);
  const buffer = await crypto.subtle.digest("SHA-1", data);
  return encodeHex(buffer);
}

export function parseIsoDate(value: string): Date | null {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return null;
  return new Date(ts);
}

export function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseAmount(value: string): number | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\s+/g, "").replace(",", ".");
  const num = Number(normalized);
  if (Number.isNaN(num)) return null;
  return round2(num);
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function lastIbanToken(iban: string): string {
  const normalized = iban.replace(/\s+/g, "");
  return normalized.slice(-8) || normalized;
}

export async function buildBankId(prefix: string, docNumber: string, postingDate: string): Promise<string> {
  const digest = await sha1Hex(`${docNumber}${postingDate}`);
  return `${prefix}-${digest}`;
}

export function uniquePush(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
  }
}

export function appendComment(base: string | null | undefined, addition: string): string {
  if (base && base.trim()) {
    return `${base.trim()} ${addition}`;
  }
  return addition;
}
