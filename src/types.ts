export type AccountType = "current" | "deposit";

export interface InputRecord {
  account_iban: string;
  account_currency: string;
  account_type: AccountType;
  date: string; // posting date YYYY-MM-DD
  document_number: string;
  bank_name: string;
  bank_bic: string;
  counterparty_name: string;
  counterparty_bin: string;
  counterparty_account: string;
  debit: string;
  credit: string;
  description: string;
  source?: string;
  page?: number;
}

export interface NormalizedTransaction {
  source?: string;
  accountIban: string;
  accountCurrency: string;
  accountType: AccountType;
  postingDate: string;
  txnDate: string;
  docNumber: string;
  bankName?: string;
  bankBic?: string;
  counterpartyName?: string;
  counterpartyAccount?: string;
  counterpartyBin?: string;
  direction: "income" | "outcome";
  amount: number;
  payee?: string | null;
  comment?: string | null;
  opAmount?: number;
  opCurrency?: string;
  cardLast4?: string;
  bankId: string;
  rawComment: string;
  conversionHint: boolean;
  wasDeleted: boolean;
}

export interface RateCache {
  [date: string]: RateCacheEntry;
}

export interface RateCacheEntry {
  pairs: Record<string, number>;
  cbr?: Record<string, number>; // currency -> rate vs RUB (upper-case)
  exchangeUsd?: Record<string, number>; // currency -> rate vs USD (lower-case keys)
}

export interface StateSnapshot {
  serverTimestamp: number | null;
  currentClientTimestamp: number | null;
  account: ZenAccount[];
  transaction: ZenTransaction[];
  instrument: ZenInstrument[];
  user: ZenUser[];
  company?: ZenCompany[];
}

export interface PersistedState {
  snapshot: StateSnapshot;
  accountSyncMap: Record<string, string[]>; // accountId -> syncIDs seen
}

export interface Config {
  apiBase: string;
  token: string | null;
  statePath: string;
  rateCachePath: string;
  dryRun: boolean;
  dryRunOutput?: string;
  syncerPrefix: string;
  companyId: number;
  requireConversionHint: boolean;
  enableFxPairing: boolean;
  fxMaxRelDelta: number;
  considerDeletedTransactions: boolean;
}

export interface ZenInstrument {
  id: number;
  shortTitle: string;
  title?: string;
  changed?: number;
  symbol?: string;
  rate?: number;
}

export interface ZenUser {
  id: number;
  changed?: number;
  currency?: number;
}

export interface ZenCompany {
  id: number;
  changed?: number;
  title?: string;
  fullTitle?: string;
}

export interface ZenAccount {
  id: string;
  user: number;
  instrument: number | null;
  type: string;
  title: string;
  syncID: string[] | null;
  inBalance: boolean;
  savings?: boolean;
  balance?: number;
  startBalance?: number;
  creditLimit?: number;
  company?: number | null;
  archive?: boolean;
  enableCorrection?: boolean;
  balanceCorrectionType?: string | null;
  private?: boolean;
  role?: number | null;
  enableSMS?: boolean;
  changed?: number;
}

export interface ZenTransaction {
  id: string;
  user: number;
  date: string;
  income: number;
  outcome: number;
  incomeInstrument: number;
  outcomeInstrument: number;
  incomeAccount: string;
  outcomeAccount: string;
  changed: number;
  created: number;
  deleted?: boolean;
  viewed?: boolean;
  hold?: boolean;
  qrCode?: string | null;
  source?: string | null;
  tag?: string[] | null;
  comment?: string | null;
  payee?: string | null;
  originalPayee?: string | null;
  opIncome?: number | null;
  opOutcome?: number | null;
  opIncomeInstrument?: number | null;
  opOutcomeInstrument?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  merchant?: string | null;
  incomeBankID?: string | null;
  outcomeBankID?: string | null;
  reminderMarker?: string | null;
}

export interface DiffRequest {
  currentClientTimestamp: number;
  serverTimestamp: number | null;
  transaction?: ZenTransaction[];
  account?: ZenAccount[];
  tag?: unknown[];
  budget?: unknown[];
  merchant?: unknown[];
  reminder?: unknown[];
  reminderMarker?: unknown[];
}

export interface DiffResponse {
  serverTimestamp: number;
  currentClientTimestamp: number;
  transaction: ZenTransaction[];
  account: ZenAccount[];
  instrument: ZenInstrument[];
  user: ZenUser[];
  company?: ZenCompany[];
}
