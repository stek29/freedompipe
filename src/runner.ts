import {
  Config,
  DiffRequest,
  DiffResponse,
  NormalizedTransaction,
  StateSnapshot,
} from "./types.ts";
import { buildDiff, mergeResponseSnapshot } from "./sync.ts";
import {
  buildEmptyDiff,
  fetchDiff,
  mergeSnapshot,
  StateStore,
} from "./state.ts";
import {
  CachedRateProvider,
  CbrRateProvider,
  CompositeRateProvider,
  ExchangeApiRateProvider,
  RateProvider,
  RateStore,
} from "./rates.ts";

export class MissingTokenError extends Error {
  constructor() {
    super("API token required (set ZENMONEY_TOKEN or provide per-request)");
  }
}

export class UserMismatchError extends Error {
  storedUserId: number | null;
  incomingUserId: number | null;

  constructor(storedUserId: number | null, incomingUserId: number | null) {
    super(
      `User mismatch: stored=${storedUserId ?? "none"} incoming=${incomingUserId ?? "none"}`,
    );
    this.storedUserId = storedUserId;
    this.incomingUserId = incomingUserId;
  }
}

export interface SyncContext {
  stateStore: StateStore;
  rateStore: RateStore;
  rateProvider: RateProvider;
}

export interface SyncResult {
  dryRun: boolean;
  diff: DiffRequest;
  counts: { accounts: number; transactions: number };
  response?: DiffResponse;
  snapshotTimestamp: number | null;
  serverTimestamp?: number;
}

function extractUserId(snapshot: StateSnapshot): number | null {
  return snapshot.user?.[0]?.id ?? null;
}

function assertUserConsistency(
  previous: StateSnapshot,
  next: StateSnapshot,
): void {
  const storedUserId = extractUserId(previous);
  const incomingUserId = extractUserId(next);
  if (incomingUserId === null) {
    throw new Error("Missing user id in refreshed snapshot");
  }
  if (storedUserId !== null && storedUserId !== incomingUserId) {
    throw new UserMismatchError(storedUserId, incomingUserId);
  }
}

export async function refreshSnapshotWithGuard(
  stateStore: StateStore,
  apiBase: string,
  token: string | null,
): Promise<StateSnapshot> {
  if (!token) throw new MissingTokenError();
  const previous = stateStore.snapshot();
  const emptyDiff = buildEmptyDiff(previous.serverTimestamp);
  const response = await fetchDiff(apiBase, token, emptyDiff);
  const merged = mergeSnapshot(previous, response);
  assertUserConsistency(previous, merged);
  return merged;
}

export function createRateProvider(rateStore: RateStore): RateProvider {
  const upstreamRates = new CompositeRateProvider([
    new CbrRateProvider(),
    new ExchangeApiRateProvider(),
  ]);
  return new CachedRateProvider(rateStore, upstreamRates);
}

export async function initSyncContext(config: Config): Promise<SyncContext> {
  const stateStore = new StateStore(config.statePath);
  await stateStore.load();
  const rateStore = new RateStore(config.rateCachePath);
  await rateStore.load();
  const rateProvider = createRateProvider(rateStore);
  return { stateStore, rateStore, rateProvider };
}

export async function runSync(
  normalized: NormalizedTransaction[],
  config: Config,
  ctx: SyncContext,
): Promise<SyncResult> {
  if (!config.token) throw new MissingTokenError();

  const snapshot = await refreshSnapshotWithGuard(
    ctx.stateStore,
    config.apiBase,
    config.token,
  );

  const { diff, accountSyncMap } = await buildDiff(
    normalized,
    snapshot,
    config,
    (date, from, to) => ctx.rateProvider.getRate(date, from, to),
  );

  const counts = {
    accounts: diff.account?.length ?? 0,
    transactions: diff.transaction?.length ?? 0,
  };

  if (config.dryRun) {
    await ctx.rateStore.save();
    return {
      dryRun: true,
      diff,
      counts,
      snapshotTimestamp: snapshot.serverTimestamp,
    };
  }

  const response = await fetchDiff(config.apiBase, config.token!, diff);
  const mergedSnapshot = mergeResponseSnapshot(snapshot, response);
  assertUserConsistency(snapshot, mergedSnapshot);
  const mergedSyncMap = {
    ...ctx.stateStore.accountSyncMap(),
    ...accountSyncMap,
  };
  await ctx.stateStore.save(mergedSnapshot, mergedSyncMap);
  await ctx.rateStore.save();

  return {
    dryRun: false,
    diff,
    counts,
    response,
    snapshotTimestamp: mergedSnapshot.serverTimestamp,
    serverTimestamp: response.serverTimestamp,
  };
}
