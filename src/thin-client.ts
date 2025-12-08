import { loadConfig } from "./config.ts";
import { loadJsonTransactions } from "./loader.ts";

type ThinCliArgs = {
  input?: string;
  dryRun: boolean;
  token?: string;
  companyId?: number;
  syncPrefix?: string;
  requireConversionHint?: boolean;
  enableFxPairing?: boolean;
  fxMaxRelDelta?: number;
  considerDeletedTransactions?: boolean;
  serverUrl?: string;
  showHelp: boolean;
};

function parseArgs(argv: string[]): ThinCliArgs {
  const args: ThinCliArgs = { dryRun: false, showHelp: false };
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
      case "--token":
        args.token = argv[++i];
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
      case "--fx-max-rel-delta":
        args.fxMaxRelDelta = Number(argv[++i]);
        break;
      case "--ignore-deleted":
        args.considerDeletedTransactions = false;
        break;
      case "--server":
        args.serverUrl = argv[++i];
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
  log(`Usage: deno task client --input <file> [options]

Options:
  -i, --input <path>           Normalized transactions JSON to read (required)
  --server <url>               Sync server base URL (default: http://127.0.0.1:8936)
  --dry-run                    Pass dry-run to the server
  --token <token>              OAuth bearer to forward to the server
  --company <id>               Company id for account resolution/creation
  --prefix <value>             BankID prefix (default: fp-sync)
  --no-conversion-hint         Allow FX pairing without conversion hint
  --no-fx, --no-fx-pairing     Disable FX pairing altogether
  --fx-max-rel-delta <number>  FX pairing tolerance (default: 0.15)
  --ignore-deleted             Ignore deleted txns when deduping bankIDs
  -h, --help                   Show this message and exit
`);
}

function resolveSyncUrl(raw?: string): URL {
  const base = raw ?? Deno.env.get("ZEN_SYNC_URL") ?? "http://127.0.0.1:8936";
  let url: URL;
  try {
    url = new URL(base);
  } catch (_err) {
    throw new Error(`Invalid server URL: ${base}`);
  }
  const trimmed = url.pathname.replace(/\/+$/, "");
  const basePath = trimmed === "" ? "/" : trimmed;
  if (basePath.endsWith("/sync")) {
    url.pathname = basePath;
  } else if (basePath === "/") {
    url.pathname = "/sync";
  } else {
    url.pathname = `${basePath}/sync`;
  }
  return url;
}

function buildOptions(args: ThinCliArgs) {
  const base = loadConfig();
  const token = args.token ?? base.token ?? undefined;
  return {
    token,
    options: {
      dry_run: args.dryRun || base.dryRun,
      token,
      sync_prefix: args.syncPrefix ?? base.syncerPrefix,
      require_conversion_hint: args.requireConversionHint ??
        base.requireConversionHint,
      enable_fx_pairing: args.enableFxPairing ?? base.enableFxPairing,
      fx_max_rel_delta: args.fxMaxRelDelta ?? base.fxMaxRelDelta,
      consider_deleted_transactions: args.considerDeletedTransactions ??
        base.considerDeletedTransactions,
      company_id: args.companyId ?? base.companyId,
    },
  };
}

async function sendSyncRequest(
  url: URL,
  body: Record<string, unknown>,
  token?: string,
): Promise<{ status: number; text: string }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}

async function main() {
  const args = parseArgs(Deno.args);
  if (args.showHelp) {
    printHelp();
    return;
  }

  const { options, token } = buildOptions(args);
  const syncUrl = resolveSyncUrl(args.serverUrl);

  const transactions = await loadJsonTransactions(args.input!);
  const result = await sendSyncRequest(syncUrl, { transactions, options }, token);
  console.log(`HTTP ${result.status}`);
  try {
    const parsed = JSON.parse(result.text);
    console.log(JSON.stringify(parsed, null, 2));
  } catch (_err) {
    console.log(result.text);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    printHelp(console.error);
    Deno.exit(1);
  });
}
