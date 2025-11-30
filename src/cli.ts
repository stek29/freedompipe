import { loadConfig } from "./config.ts";
import { loadJsonTransactions } from "./loader.ts";
import { normalizeInput } from "./parser.ts";
import {
  CachedRateProvider,
  CbrRateProvider,
  CompositeRateProvider,
  ExchangeApiRateProvider,
  RateStore,
} from "./rates.ts";
import { buildDiff } from "./sync.ts";
import {
  buildEmptyDiff,
  fetchDiff,
  mergeSnapshot,
  StateStore,
} from "./state.ts";
import { DiffRequest } from "./types.ts";

type CliArgs = {
  input?: string;
  dryRun: boolean;
  dryOutput?: string;
  token?: string;
  statePath?: string;
  rateCachePath?: string;
  companyId?: number;
  syncPrefix?: string;
  requireConversionHint?: boolean;
  enableFxPairing?: boolean;
  fxMaxRelDelta?: number;
  considerDeletedTransactions?: boolean;
  showHelp: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false, showHelp: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--input":
      case "-i":
        args.input = argv[++i];
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--dry-output":
        args.dryOutput = argv[++i];
        break;
      case "--token":
        args.token = argv[++i];
        break;
      case "--state":
        args.statePath = argv[++i];
        break;
      case "--rates":
        args.rateCachePath = argv[++i];
        break;
      case "--company":
        args.companyId = Number(argv[++i]);
        break;
      case "--prefix":
        args.syncPrefix = argv[++i];
        break;
      case "--no-conversion-hint":
        args.requireConversionHint = false;
        break;
      case "--no-fx":
      case "--no-fx-pairing":
        args.enableFxPairing = false;
        break;
      case "--no-cleared":
        break;
      case "--consider-deleted":
        args.considerDeletedTransactions = true;
        break;
      case "--fx-max-rel-delta":
        args.fxMaxRelDelta = Number(argv[++i]);
        break;
      case "--help":
      case "-h":
        args.showHelp = true;
        break;
      default:
        if (!args.input && !arg.startsWith("-")) {
          args.input = arg;
        } else {
          throw new Error(`Unknown argument ${arg}`);
        }
    }
    if (args.showHelp) break;
  }
  if (!args.input && !args.showHelp) {
    throw new Error("Input file is required (--input)");
  }
  return args;
}

function printHelp(log: (msg?: string) => void = console.log) {
  log(`Usage: deno task run --input <file> [options]

Options:
  -i, --input <path>           Normalized transactions JSON to read (required)
  --dry-run                    Skip API call and pretty-print diff
  --dry-output <path>          File to write diff in dry-run (stdout by default)
  --token <token>              OAuth bearer for ZenMoney /v8/diff
  --state <path>               Path to persisted snapshot (default: state.json)
  --rates <path>               FX cache file (default: rates-cache.json)
  --company <id>               Company id for account resolution/creation
  --prefix <value>             BankID prefix (default: fp-sync)
  --no-conversion-hint         Allow FX pairing without conversion hint
  --no-fx, --no-fx-pairing     Disable FX pairing altogether
  --fx-max-rel-delta <number>  FX pairing tolerance (default: 0.15)
  --consider-deleted           Include deleted txns when deduping bankIDs
  -h, --help                   Show this message and exit
`);
}

async function maybeRefreshSnapshot(
  token: string | null,
  state: StateStore,
  apiBase: string,
) {
  let snapshot = state.snapshot();
  if (!token) {
    return snapshot;
  }
  const emptyDiff: DiffRequest = buildEmptyDiff(snapshot.serverTimestamp);
  const response = await fetchDiff(apiBase, token, emptyDiff);
  snapshot = mergeSnapshot(snapshot, response);
  return snapshot;
}

async function main() {
  const args = parseArgs(Deno.args);
  if (args.showHelp) {
    printHelp();
    return;
  }
  const base = loadConfig();
  const config = loadConfig({
    dryRun: args.dryRun || base.dryRun,
    dryRunOutput: args.dryOutput ?? base.dryRunOutput,
    token: args.token ?? base.token,
    statePath: args.statePath ?? base.statePath,
    rateCachePath: args.rateCachePath ?? base.rateCachePath,
    companyId: args.companyId ?? base.companyId,
    syncerPrefix: args.syncPrefix ?? base.syncerPrefix,
    requireConversionHint: args.requireConversionHint ??
      base.requireConversionHint,
    enableFxPairing: args.enableFxPairing ?? base.enableFxPairing,
    fxMaxRelDelta: args.fxMaxRelDelta ?? base.fxMaxRelDelta,
    considerDeletedTransactions: args.considerDeletedTransactions ??
      base.considerDeletedTransactions,
  });

  if (!config.token) {
    throw new Error("API token required (set ZENMONEY_TOKEN or --token)");
  }

  if (typeof config.companyId !== "number" || Number.isNaN(config.companyId)) {
    throw new Error("Company id is required (set ZEN_COMPANY_ID or --company)");
  }

  const stateStore = new StateStore(config.statePath);
  await stateStore.load();
  let snapshot = await maybeRefreshSnapshot(
    config.token,
    stateStore,
    config.apiBase,
  );

  if (!snapshot.serverTimestamp && !config.token) {
    throw new Error(
      "No cached state available and token missing; cannot proceed",
    );
  }

  const rateStore = new RateStore(config.rateCachePath);
  await rateStore.load();
  const upstreamRates = new CompositeRateProvider([
    new CbrRateProvider(),
    new ExchangeApiRateProvider(),
  ]);
  const rateProvider = new CachedRateProvider(rateStore, upstreamRates);

  const records = await loadJsonTransactions(args.input!);
  const normalized = await normalizeInput(
    records,
    config.syncerPrefix,
  );

  const { diff, accountSyncMap } = await buildDiff(
    normalized,
    snapshot,
    config,
    (date, from, to) => rateProvider.getRate(date, from, to),
  );

  const accountCount = diff.account?.length ?? 0;
  const txnCount = diff.transaction?.length ?? 0;

  if (config.dryRun) {
    const output = JSON.stringify(diff, null, 2);
    if (config.dryRunOutput) {
      await Deno.writeTextFile(config.dryRunOutput, output);
      console.log(
        `Dry-run diff written to ${config.dryRunOutput} (accounts=${accountCount}, txns=${txnCount})`,
      );
    } else {
      console.log(output);
    }
    await rateStore.save();
    return;
  }

  const response = await fetchDiff(config.apiBase, config.token!, diff);
  snapshot = mergeSnapshot(snapshot, response);
  const mergedSyncMap = { ...stateStore.accountSyncMap(), ...accountSyncMap };
  await stateStore.save(snapshot, mergedSyncMap);
  await rateStore.save();
  console.log(
    `Sync completed. Accounts sent=${accountCount}, txns sent=${txnCount}. Server timestamp: ${response.serverTimestamp}`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    printHelp(console.error);
    Deno.exit(1);
  });
}
