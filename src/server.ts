import { Application, Router } from "@oak/oak";
import {
  applySyncOptions,
  loadConfig,
  SyncOptions,
} from "./config.ts";
import { Config } from "./types.ts";
import { normalizeInput } from "./parser.ts";
import {
  initSyncContext,
  MissingTokenError,
  runSync,
  SyncContext,
  UserMismatchError,
} from "./runner.ts";
import { parseInputRecords } from "./loader.ts";
import { InputRecord } from "./types.ts";
import { Mutex, MutexTimeoutError } from "./mutex.ts";

const LOCK_TIMEOUT_MS = 5000;

type RawSyncOptions = Partial<{
  dry_run: boolean;
  token: string | null;
  sync_prefix: string;
  require_conversion_hint: boolean;
  enable_fx_pairing: boolean;
  fx_max_rel_delta: number;
  consider_deleted_transactions: boolean;
  company_id: number;
}>;

class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

type ParsedBody = {
  transactions: InputRecord[];
  options: Record<string, unknown>;
};

function parseServerArgs(argv: string[]): Partial<Config> {
  const overrides: Partial<Config> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--state":
        overrides.statePath = argv[++i];
        break;
      case "--rates":
        overrides.rateCachePath = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return overrides;
}

function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1]?.trim() || null;
}

function parseBody(payload: unknown): ParsedBody {
  if (!payload || typeof payload !== "object") {
    throw new HttpError(400, "Body must be a JSON object");
  }
  const obj = payload as Record<string, unknown>;
  const options = obj.options ?? {};
  if (options && typeof options !== "object") {
    throw new HttpError(400, "`options` must be an object when present");
  }
  const allowedOptions = new Set([
    "dry_run",
    "token",
    "sync_prefix",
    "require_conversion_hint",
    "enable_fx_pairing",
    "fx_max_rel_delta",
    "consider_deleted_transactions",
    "company_id",
  ]);
  for (const key of Object.keys(options as Record<string, unknown>)) {
    if (!allowedOptions.has(key)) {
      throw new HttpError(400, `Unknown option '${key}'`);
    }
  }
  const transactions = parseInputRecords(
    obj.transactions,
    (message) => new HttpError(400, message),
    "`transactions`",
  );
  return { transactions, options: options as Record<string, unknown> };
}

function parseRawOptions(raw: Record<string, unknown>): SyncOptions {
  const options = raw as RawSyncOptions;
  const out: SyncOptions = {};
  if (options.dry_run !== undefined) {
    if (typeof options.dry_run !== "boolean") {
      throw new HttpError(400, "`options.dry_run` must be boolean");
    }
    out.dryRun = options.dry_run;
  }
  if (options.token !== undefined) {
    if (options.token !== null && typeof options.token !== "string") {
      throw new HttpError(400, "`options.token` must be string");
    }
    out.token = options.token ?? undefined;
  }
  if (options.sync_prefix !== undefined) {
    if (typeof options.sync_prefix !== "string") {
      throw new HttpError(400, "`options.sync_prefix` must be string");
    }
    out.syncPrefix = options.sync_prefix;
  }
  if (options.require_conversion_hint !== undefined) {
    if (typeof options.require_conversion_hint !== "boolean") {
      throw new HttpError(
        400,
        "`options.require_conversion_hint` must be boolean",
      );
    }
    out.requireConversionHint = options.require_conversion_hint;
  }
  if (options.enable_fx_pairing !== undefined) {
    if (typeof options.enable_fx_pairing !== "boolean") {
      throw new HttpError(400, "`options.enable_fx_pairing` must be boolean");
    }
    out.enableFxPairing = options.enable_fx_pairing;
  }
  if (options.fx_max_rel_delta !== undefined) {
    const num = Number(options.fx_max_rel_delta);
    if (!Number.isFinite(num)) {
      throw new HttpError(400, "`options.fx_max_rel_delta` must be a number");
    }
    out.fxMaxRelDelta = num;
  }
  if (options.consider_deleted_transactions !== undefined) {
    if (typeof options.consider_deleted_transactions !== "boolean") {
      throw new HttpError(
        400,
        "`options.consider_deleted_transactions` must be boolean",
      );
    }
    out.considerDeletedTransactions = options.consider_deleted_transactions;
  }
  if (options.company_id !== undefined) {
    const num = Number(options.company_id);
    if (!Number.isFinite(num)) {
      throw new HttpError(400, "`options.company_id` must be a number");
    }
    out.companyId = num;
  }
  return out;
}

function resolveToken(
  options: SyncOptions,
  authHeader: string | null,
  envToken: string | null,
): string | null {
  const tokenFromHeader = parseBearer(authHeader);
  const candidate = options.token ?? tokenFromHeader ?? envToken;
  if (typeof candidate === "string" && candidate.trim() === "") return null;
  return candidate ?? null;
}

function logRequest(
  method: string,
  path: string,
  status: number,
  message?: string,
  extra?: Record<string, unknown>,
) {
  const payload: Record<string, unknown> = { method, path, status };
  if (message) payload.message = message;
  if (extra) Object.assign(payload, extra);
  console.log(JSON.stringify(payload));
}

async function handleSync(
  body: { json: () => Promise<unknown> },
  headers: Headers,
  ctx: SyncContext,
  baseConfig: ReturnType<typeof loadConfig>,
  mutex: Mutex,
  path: string,
  requestId: string,
  startTime: number,
): Promise<{ status: number; body: Record<string, unknown>; logExtra: Record<string, unknown> }> {
  const payload = await body.json().catch(() => {
    throw new HttpError(400, "Invalid JSON");
  });
  const { transactions, options } = parseBody(payload);
  const parsedOptions = parseRawOptions(options);
  const redactedRawOptions = { ...options };
  if ("token" in redactedRawOptions) {
    redactedRawOptions.token = "<redacted>";
  }
  const token = resolveToken(parsedOptions, headers.get("authorization"), baseConfig.token);
  logRequest("POST", path, 0, undefined, {
    req_id: requestId,
    raw_options: redactedRawOptions,
    txn_count: transactions.length,
    event: "request_start",
    start_time_ms: startTime,
  });
  let config;
  try {
    config = applySyncOptions(baseConfig, parsedOptions, token);
    if (!config.token) {
      throw new MissingTokenError();
    }
  } catch (err) {
    if (err instanceof MissingTokenError) throw err;
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }

  const release = await mutex.acquire(LOCK_TIMEOUT_MS).catch((err) => {
    if (err instanceof MutexTimeoutError) {
      throw new HttpError(429, "Another sync is already running");
    }
    throw err;
  });

  try {
    const normalized = await normalizeInput(
      transactions,
      config.syncerPrefix,
    ).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(400, message);
    });
    const result = await runSync(normalized, config, ctx);
    const logExtra: Record<string, unknown> = {
      req_id: requestId,
      start_time_ms: startTime,
      txn_count: transactions.length,
      dry_run: result.dryRun,
      counts: result.counts,
    };
    if (result.dryRun) {
      logExtra.diff_present = Boolean(result.diff);
    } else {
      logExtra.server_timestamp = result.serverTimestamp;
      logExtra.snapshot_timestamp = result.snapshotTimestamp;
    }

    if (result.dryRun) {
      return {
        status: 200,
        body: {
          status: "ok",
          dry_run: true,
          counts: result.counts,
          diff: result.diff,
        },
        logExtra,
      };
    }

    return {
      status: 200,
      body: {
        status: "ok",
        dry_run: false,
        counts: result.counts,
        server_timestamp: result.serverTimestamp,
        snapshot_timestamp: result.snapshotTimestamp,
      },
      logExtra,
    };
  } finally {
    release();
  }
}

function mapError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof HttpError) {
    return { status: err.status, body: { status: "error", message: err.message, details: err.details } };
  }
  if (err instanceof MissingTokenError) {
    return { status: 401, body: { status: "error", message: err.message } };
  }
  if (err instanceof UserMismatchError) {
    return {
      status: 409,
      body: {
        status: "error",
        message: err.message,
      },
    };
  }
  return { status: 500, body: { status: "error", message: err instanceof Error ? err.message : String(err) } };
}

async function start() {
  const baseConfig = loadConfig(parseServerArgs(Deno.args));
  const ctx = await initSyncContext(baseConfig);
  const mutex = new Mutex();
  const hostname = Deno.env.get("ZEN_HOST") ?? "0.0.0.0";
  const parsedPort = Number(Deno.env.get("ZEN_PORT") ?? "8936");
  const port = Number.isFinite(parsedPort) ? parsedPort : 8936;

  const app = new Application();
  const router = new Router();

  router.get("/health", (context) => {
    context.response.status = 200;
    context.response.body = { status: "ok" };
  });

  router.post("/sync", async (context) => {
    const body = context.request.body;
    const url = new URL(context.request.url);
    const reqId = crypto.randomUUID();
    const startTime = Date.now();
    const result = await handleSync(
      body,
      context.request.headers,
      ctx,
      baseConfig,
      mutex,
      url.pathname,
      reqId,
      startTime,
    );
    context.response.status = result.status;
    context.response.body = result.body;
    (context.state as Record<string, unknown>).logExtra = {
      ...result.logExtra,
      req_id: reqId,
      start_time_ms: startTime,
    };
  });

  app.use(async (context, next) => {
    let status = 500;
    let message: string | undefined;
    try {
      await next();
      status = context.response.status || 404;
    } catch (err) {
      const mapped = mapError(err);
      status = mapped.status;
      message = typeof mapped.body.message === "string"
        ? mapped.body.message
        : undefined;
      context.response.status = mapped.status;
      context.response.body = mapped.body;
      const meta = (context.state as { logExtra?: Record<string, unknown> }).logExtra ?? {};
      meta.req_id ??= crypto.randomUUID();
      meta.start_time_ms ??= Date.now();
      const duration = Date.now() - Number(meta.start_time_ms);
      logRequest(context.request.method, new URL(context.request.url).pathname, status, message, {
        ...meta,
        event: "request_end",
        duration_ms: duration,
      });
      return;
    } finally {
      const url = new URL(context.request.url);
      const meta = (context.state as { logExtra?: Record<string, unknown> }).logExtra ?? {};
      const duration = meta.start_time_ms ? (Date.now() - Number(meta.start_time_ms)) : undefined;
      logRequest(context.request.method, url.pathname, status, message, {
        ...meta,
        event: "request_end",
        duration_ms: duration,
      });
    }
  });

  app.use(router.routes());
  app.use(router.allowedMethods());
  app.use((context) => {
    context.response.status = 404;
    context.response.body = { status: "error", message: "Not found" };
  });

  console.log(JSON.stringify({ event: "listening", hostname, port }));
  await app.listen({ hostname, port });
}

if (import.meta.main) {
  start();
}
