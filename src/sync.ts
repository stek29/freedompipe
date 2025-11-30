import {
  Config,
  DiffRequest,
  DiffResponse,
  NormalizedTransaction,
  StateSnapshot,
  ZenAccount,
  ZenTransaction,
} from "./types.ts";
import { lastIbanToken, round2, uniquePush } from "./utils.ts";
import { accountBySyncId, collectBankIds, mergeSnapshot } from "./state.ts";
import { pairFx, pairSameCurrency, TransferPair } from "./matcher.ts";
import { ibanTypeToZenType } from "./parser.ts";

interface ResolutionResult {
  accountMap: Map<string, ZenAccount>;
  created: ZenAccount[];
  updated: ZenAccount[];
  syncMap: Record<string, string[]>;
}

interface BuildContext {
  config: Config;
  snapshot: StateSnapshot;
  instruments: Map<string, number>;
  userId: number;
  nowTs: number;
}

export async function buildDiff(
  normalized: NormalizedTransaction[],
  snapshot: StateSnapshot,
  config: Config,
  getRate: (date: string, from: string, to: string) => Promise<number>,
): Promise<{ diff: DiffRequest; accountSyncMap: Record<string, string[]> }> {
  const instruments = new Map<string, number>();
  for (const inst of snapshot.instrument) {
    instruments.set(inst.shortTitle.toUpperCase(), inst.id);
  }
  const userId = snapshot.user?.[0]?.id;
  if (!userId) {
    throw new Error("Missing user id in snapshot");
  }
  const nowTs = Math.floor(Date.now() / 1000);
  const ctx: BuildContext = { config, snapshot, instruments, userId, nowTs };

  const bankIdMap = collectBankIds(
    snapshot.transaction,
    !config.considerDeletedTransactions,
  );
  const filtered = normalized.filter((tx) => {
    const existing = bankIdMap.get(tx.bankId);
    return !existing;
  });

  const resolution = resolveAccounts(filtered, ctx);
  const byAccount = resolution.accountMap;

  const incomes = filtered.filter((t) => t.direction === "income");
  const outcomes = filtered.filter((t) => t.direction === "outcome");

  const samePairs = pairSameCurrency(incomes, outcomes);
  const pairedIncomeIds = new Set(samePairs.map((p) => p.income.bankId));
  const pairedOutcomeIds = new Set(samePairs.map((p) => p.outcome.bankId));

  const leftoverIncomes = incomes.filter((t) => !pairedIncomeIds.has(t.bankId));
  const leftoverOutcomes = outcomes.filter((t) =>
    !pairedOutcomeIds.has(t.bankId)
  );

  const fxPairs = config.enableFxPairing === false
    ? []
    : await pairFx(
      leftoverIncomes,
      leftoverOutcomes,
      config.requireConversionHint,
      config.fxMaxRelDelta,
      getRate,
    );
  for (const p of fxPairs) {
    pairedIncomeIds.add(p.income.bankId);
    pairedOutcomeIds.add(p.outcome.bankId);
  }

  const remainingIncomes = leftoverIncomes.filter((t) =>
    !pairedIncomeIds.has(t.bankId)
  );
  const remainingOutcomes = leftoverOutcomes.filter((t) =>
    !pairedOutcomeIds.has(t.bankId)
  );

  const transactions: ZenTransaction[] = [];
  for (const pair of samePairs) {
    transactions.push(makeTransfer(pair, byAccount, ctx));
  }
  for (const pair of fxPairs) {
    transactions.push(makeTransfer(pair, byAccount, ctx));
  }
  for (const inc of remainingIncomes) {
    transactions.push(makeSingle(inc, byAccount, ctx));
  }
  for (const out of remainingOutcomes) {
    transactions.push(makeSingle(out, byAccount, ctx));
  }

  const balanceDeltas = computeBalanceDeltas(transactions);
  const accountsForDiff = applyBalanceDeltas(balanceDeltas, resolution);

  const diff: DiffRequest = {
    currentClientTimestamp: nowTs,
    serverTimestamp: snapshot.serverTimestamp,
    account: dedupeAccounts([
      ...resolution.created,
      ...resolution.updated,
      ...accountsForDiff,
    ]),
    transaction: transactions,
    tag: [],
    budget: [],
    merchant: [],
    reminder: [],
    reminderMarker: [],
  };

  return { diff, accountSyncMap: resolution.syncMap };
}

function resolveAccounts(
  transactions: NormalizedTransaction[],
  ctx: BuildContext,
): ResolutionResult {
  const { snapshot, instruments, config, nowTs } = ctx;
  const syncMap: Record<string, string[]> = {};
  const created: ZenAccount[] = [];
  const updated: ZenAccount[] = [];
  const accountMap = new Map<string, ZenAccount>();
  const requirements = new Map<
    string,
    { currency: string; type: string; savings: boolean; cardLast4: Set<string> }
  >();

  for (const tx of transactions) {
    if (!requirements.has(tx.accountIban)) {
      const mapped = ibanTypeToZenType(tx.accountType);
      requirements.set(tx.accountIban, {
        currency: tx.accountCurrency.toUpperCase(),
        type: mapped.type,
        savings: mapped.savings,
        cardLast4: new Set<string>(),
      });
    }
    if (tx.cardLast4) {
      requirements.get(tx.accountIban)!.cardLast4.add(tx.cardLast4);
    }
  }

  for (const [iban, req] of requirements.entries()) {
    const tail = lastIbanToken(iban);
    const existing = accountBySyncId(snapshot.account, tail, config.companyId);

    const syncID: string[] = existing?.syncID ? [...existing.syncID] : [];
    uniquePush(syncID, tail);
    for (const card of req.cardLast4) uniquePush(syncID, card);

    const instrumentId = instruments.get(req.currency);
    if (!instrumentId) {
      throw new Error(`Unknown instrument for currency ${req.currency}`);
    }

    if (existing) {
      const updatedAcc: ZenAccount = { ...existing };
      updatedAcc.syncID = syncID;
      if (updatedAcc.archive) {
        updatedAcc.archive = false;
        console.warn(`Unarchiving account ${updatedAcc.title}`);
      }
      updatedAcc.changed = nowTs;
      accountMap.set(iban, updatedAcc);
      const mutated =
        JSON.stringify(stripNulls(existing)) !==
          JSON.stringify(stripNulls(updatedAcc));
      if (mutated) {
        updated.push(updatedAcc);
      }
      syncMap[updatedAcc.id] = syncID;
    } else {
      const newAcc: ZenAccount = {
        id: crypto.randomUUID(),
        user: ctx.userId,
        instrument: instrumentId,
        type: req.type,
        savings: req.savings,
        title: iban,
        syncID,
        inBalance: true,
        startBalance: 0,
        balance: 0,
        creditLimit: 0,
        company: config.companyId,
        archive: false,
        enableCorrection: true,
        balanceCorrectionType: "request",
        private: false,
        role: null,
        enableSMS: true,
        changed: nowTs,
      };
      created.push(newAcc);
      accountMap.set(iban, newAcc);
      syncMap[newAcc.id] = syncID;
    }
  }

  return { accountMap, created, updated, syncMap };
}

function stripNulls<T>(obj: T): T {
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v === undefined) continue;
    copy[k] = v;
  }
  return copy as T;
}

function makeSingle(
  tx: NormalizedTransaction,
  accounts: Map<string, ZenAccount>,
  ctx: BuildContext,
): ZenTransaction {
  const acc = accounts.get(tx.accountIban);
  if (!acc) throw new Error(`Account not resolved for ${tx.accountIban}`);
  const instrumentId = ctx.instruments.get(tx.accountCurrency.toUpperCase());
  if (!instrumentId) {
    throw new Error(`Missing instrument for ${tx.accountCurrency}`);
  }
  const id = crypto.randomUUID();

  const income = tx.direction === "income" ? tx.amount : 0;
  const outcome = tx.direction === "outcome" ? tx.amount : 0;

  const opOutcome =
    tx.direction === "outcome" && tx.opCurrency &&
      tx.opCurrency !== tx.accountCurrency
      ? tx.opAmount ?? null
      : null;
  const opIncome =
    tx.direction === "income" && tx.opCurrency &&
      tx.opCurrency !== tx.accountCurrency
      ? tx.opAmount ?? null
      : null;
  const opInstr = tx.opCurrency
    ? ctx.instruments.get(tx.opCurrency) ?? null
    : null;

  const incomeBankID = tx.direction === "income" ? tx.bankId : null;
  const outcomeBankID = tx.direction === "outcome" ? tx.bankId : null;

  return {
    id,
    user: ctx.userId,
    date: tx.txnDate,
    income: round2(income),
    outcome: round2(outcome),
    incomeInstrument: instrumentId,
    outcomeInstrument: instrumentId,
    incomeAccount: acc.id,
    outcomeAccount: acc.id,
    changed: ctx.nowTs,
    created: ctx.nowTs,
    deleted: false,
    viewed: false,
    hold: false,
    qrCode: null,
    source: null,
    tag: null,
    comment: tx.comment ?? null,
    payee: tx.payee ?? null,
    originalPayee: null,
    opIncome,
    opOutcome,
    opIncomeInstrument: opIncome ? opInstr : null,
    opOutcomeInstrument: opOutcome ? opInstr : null,
    latitude: null,
    longitude: null,
    merchant: null,
    incomeBankID,
    outcomeBankID,
    reminderMarker: null,
  };
}

function makeTransfer(
  pair: TransferPair,
  accounts: Map<string, ZenAccount>,
  ctx: BuildContext,
): ZenTransaction {
  const incomeAcc = accounts.get(pair.income.accountIban);
  const outcomeAcc = accounts.get(pair.outcome.accountIban);
  if (!incomeAcc || !outcomeAcc) throw new Error("Transfer account missing");

  const incomeInstrument = ctx.instruments.get(
    pair.income.accountCurrency.toUpperCase(),
  );
  const outcomeInstrument = ctx.instruments.get(
    pair.outcome.accountCurrency.toUpperCase(),
  );
  if (!incomeInstrument || !outcomeInstrument) {
    throw new Error("Missing instrument for transfer");
  }

  const id = crypto.randomUUID();
  const date = pair.income.txnDate <= pair.outcome.txnDate
    ? pair.income.txnDate
    : pair.outcome.txnDate;

  return {
    id,
    user: ctx.userId,
    date,
    income: round2(pair.income.amount),
    outcome: round2(pair.outcome.amount),
    incomeInstrument,
    outcomeInstrument,
    incomeAccount: incomeAcc.id,
    outcomeAccount: outcomeAcc.id,
    changed: ctx.nowTs,
    created: ctx.nowTs,
    deleted: false,
    viewed: false,
    hold: false,
    qrCode: null,
    source: null,
    tag: null,
    comment: pair.income.comment ?? pair.outcome.comment ?? null,
    payee: pair.income.payee ?? pair.outcome.payee ?? null,
    originalPayee: null,
    opIncome: null,
    opOutcome: null,
    opIncomeInstrument: null,
    opOutcomeInstrument: null,
    latitude: null,
    longitude: null,
    merchant: null,
    incomeBankID: pair.income.bankId,
    outcomeBankID: pair.outcome.bankId,
    reminderMarker: null,
  };
}

function computeBalanceDeltas(
  transactions: ZenTransaction[],
): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const tx of transactions) {
    const outDelta = -(tx.outcome || 0);
    const inDelta = tx.income || 0;
    const net = inDelta + outDelta;

    const outAcc = tx.outcomeAccount;
    const inAcc = tx.incomeAccount;

    if (net !== 0 && inAcc === outAcc) {
      addDelta(deltas, inAcc, net);
    } else {
      if (outDelta !== 0) addDelta(deltas, outAcc, outDelta);
      if (inDelta !== 0) addDelta(deltas, inAcc, inDelta);
    }
  }
  return deltas;
}

function addDelta(map: Map<string, number>, accId: string, delta: number) {
  map.set(accId, round2((map.get(accId) ?? 0) + delta));
}

function applyBalanceDeltas(
  deltas: Map<string, number>,
  resolution: ResolutionResult,
): ZenAccount[] {
  const accountsToUpdate: ZenAccount[] = [];
  for (const [accountId, delta] of deltas.entries()) {
    const existing = resolution.updated.find((a) => a.id === accountId) ??
      resolution.created.find((a) => a.id === accountId);
    const source = existing ??
      Array.from(resolution.accountMap.values()).find((a) =>
        a.id === accountId
      );
    if (!source) continue;
    const updated = { ...source };
    const currentBalance = typeof source.balance === "number"
      ? source.balance
      : 0;
    updated.balance = round2(currentBalance + delta);
    if (!updated.changed) updated.changed = Math.floor(Date.now() / 1000);
    accountsToUpdate.push(updated);
  }

  // Avoid duplicating already-created accounts in the update list
  const newAccountIds = new Set(resolution.created.map((a) => a.id));
  return accountsToUpdate.filter((a) => !newAccountIds.has(a.id));
}

export function mergeResponseSnapshot(
  previous: StateSnapshot,
  diffResponse: DiffResponse,
): StateSnapshot {
  return mergeSnapshot(previous, diffResponse);
}

function dedupeAccounts(items: ZenAccount[]): ZenAccount[] {
  const byId = new Map<string, ZenAccount>();
  for (const acc of items) {
    byId.set(acc.id, acc);
  }
  return [...byId.values()];
}
