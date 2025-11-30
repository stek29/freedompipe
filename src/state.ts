import {
  DiffRequest,
  DiffResponse,
  PersistedState,
  StateSnapshot,
  ZenAccount,
  ZenTransaction,
} from "./types.ts";

export class StateStore {
  #path: string;
  #state: PersistedState | null = null;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    try {
      const text = await Deno.readTextFile(this.#path);
      this.#state = JSON.parse(text) as PersistedState;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        this.#state = null;
        return;
      }
      throw err;
    }
  }

  snapshot(): StateSnapshot {
    if (!this.#state) {
      return {
        serverTimestamp: null,
        currentClientTimestamp: null,
        account: [],
        transaction: [],
        instrument: [],
        user: [],
      };
    }
    return this.#state.snapshot;
  }

  accountSyncMap(): Record<string, string[]> {
    return this.#state?.accountSyncMap ?? {};
  }

  async save(
    snapshot: StateSnapshot,
    accountSyncMap: Record<string, string[]>,
  ): Promise<void> {
    const payload: PersistedState = { snapshot, accountSyncMap };
    await Deno.writeTextFile(this.#path, JSON.stringify(payload, null, 2));
    this.#state = payload;
  }
}

export async function fetchDiff(
  apiBase: string,
  token: string,
  body: DiffRequest,
): Promise<DiffResponse> {
  // if (!!body.transaction?.length || !!body.account?.length) {
  //   throw Error("fuck you man, no write access for you");
  // }

  const res = await fetch(`${apiBase}/diff/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Diff request failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<DiffResponse>;
}

export function mergeSnapshot(
  prev: StateSnapshot,
  diff: DiffResponse,
): StateSnapshot {
  const mergeById = <T extends { id: string | number }>(
    before: T[],
    after?: T[],
  ): T[] => {
    if (!after || after.length === 0) return before;
    const merged = [...before];
    for (const item of after) {
      const idx = merged.findIndex((row) => row.id === item.id);
      if (idx === -1) merged.push(item);
      else merged[idx] = item;
    }
    return merged;
  };

  return {
    serverTimestamp: diff.serverTimestamp,
    currentClientTimestamp: diff.currentClientTimestamp,
    account: mergeById(prev.account, diff.account),
    transaction: mergeById(prev.transaction, diff.transaction),
    instrument: mergeById(prev.instrument, diff.instrument),
    user: mergeById(prev.user, diff.user),
    company: mergeById(prev.company ?? [], diff.company),
  };
}

export function buildEmptyDiff(timestamp: number | null): DiffRequest {
  const now = Math.floor(Date.now() / 1000);
  return {
    currentClientTimestamp: now,
    serverTimestamp: timestamp,
    transaction: [],
    account: [],
    tag: [],
    budget: [],
    merchant: [],
    reminder: [],
    reminderMarker: [],
  };
}

export function collectBankIds(
  transactions: ZenTransaction[],
  ignoreDeleted = true,
): Map<string, ZenTransaction> {
  const map = new Map<string, ZenTransaction>();
  for (const tx of transactions) {
    if (ignoreDeleted && tx.deleted) continue;
    if (tx.incomeBankID) map.set(tx.incomeBankID, tx);
    if (tx.outcomeBankID) map.set(tx.outcomeBankID, tx);
  }
  return map;
}

export function accountBySyncId(
  accounts: ZenAccount[],
  syncId: string,
  companyId?: number,
): ZenAccount | undefined {
  return accounts.find((acc) =>
    acc.syncID?.includes(syncId) && (companyId === undefined || acc.company === companyId)
  );
}
