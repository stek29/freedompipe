import { Config } from "./types.ts";

const defaultConfig: Config = {
  apiBase: "https://api.zenmoney.ru/v8",
  token: Deno.env.get("ZENMONEY_TOKEN") ?? null,
  statePath: Deno.env.get("ZEN_STATE_PATH") ?? "state.json",
  rateCachePath: Deno.env.get("ZEN_RATE_CACHE_PATH") ?? "rates-cache.json",
  dryRun: Deno.env.get("ZEN_DRY_RUN") === "1",
  dryRunOutput: Deno.env.get("ZEN_DRY_RUN_OUTPUT") ?? undefined,
  syncerPrefix: Deno.env.get("ZEN_SYNC_PREFIX") ?? "fp-sync",
  companyId: Number(Deno.env.get("ZEN_COMPANY_ID")),
  requireConversionHint: Deno.env.get("ZEN_REQUIRE_CONVERSION_HINT") !== "0",
  enableFxPairing: Deno.env.get("ZEN_ENABLE_FX_PAIRING") !== "0",
  fxMaxRelDelta: (() => {
    const raw = Deno.env.get("ZEN_FX_MAX_REL_DELTA");
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : 0.15;
  })(),
  considerDeletedTransactions:
    Deno.env.get("ZEN_IGNORE_DELETED_TRANSACTIONS") === "1" ? false : true,
};

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return { ...defaultConfig, ...overrides };
}
