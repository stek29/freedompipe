## Freedom Finance KZ to ZenMoney

a pipeline of tools to parse and ingest PDFs from Freedom Banker app into ZenMoney

## ZenMoney Syncer

> [!WARNING] 
> This tool is mostly "vibe coded", works for me on my own files, but might mess with your data.
> Use carefully, verify dry-run outputs.
> **No warranty or liability**

CLI tool that reads normalized transaction JSON, resolves/creates ZenMoney accounts, pairs transfers/conversions, and emits `/v8/diff` payloads.

It should be fully idempotent, only creating transactions that are missing. Deleted transactions stay gone on reruns by default; if you want them recreated, pass `--ignore-deleted` / `ZEN_IGNORE_DELETED_TRANSACTIONS=1`.


## Quick start
```
deno task run --input transactions.json --company-id 15492 --dry-run
```

## Config (env or flags)
- `--input` / `-i`: Normalized transactions JSON to read (required).
- `ZENMONEY_TOKEN` / `--token`: OAuth bearer for `/v8/diff` (required for all runs, including dry-run to fetch snapshot).
- `ZEN_STATE_PATH` / `--state`: Path to persisted snapshot (default `state.json`).
- `ZEN_RATE_CACHE_PATH` / `--rates`: FX cache file (default `rates-cache.json`).
- `ZEN_SYNC_PREFIX` / `--prefix`: BankID prefix (default `fp-sync`).
- `ZEN_COMPANY_ID` / `--company`: Company id for account resolution/creation (required), ZenMoney's bank ID (i.e. 15492 for the FFIN KZ).
- `ZEN_DRY_RUN` / `--dry-run`: Skip API call, pretty-print diff.
- `ZEN_DRY_RUN_OUTPUT` / `--dry-output`: File to write diff in dry-run (stdout by default).
- `ZEN_REQUIRE_CONVERSION_HINT=0` / `--no-conversion-hint`: Allow FX pairing without “Конвертация” hint.
- `ZEN_ENABLE_FX_PAIRING=0` / `--no-fx` / `--no-fx-pairing`: Disable FX pairing altogether.
- `ZEN_FX_MAX_REL_DELTA` / `--fx-max-rel-delta`: FX pairing tolerance (default `0.15`).
- `ZEN_IGNORE_DELETED_TRANSACTIONS=1` / `--ignore-deleted`: Recreate transactions you've deleted by ignoring them during bankID dedupe (default: keep deleted transactions skipped so they stay gone).

## Notes
- Dry-run still fetches the latest snapshot, updates the rate cache, but does not persist state or post the diff.
- Posting date is appended as `Cleared: <date>` only when op_date overrides the posting date.
- Accounts are resolved strictly by IBAN tail; card `*last4` values are appended to `syncID` for reference only.

## Behavior highlights
- Idempotent bankIDs: `[prefix]-sha1(document_number + posting_date)` per row.
- Accounts resolved by IBAN tail within the provided company; missing accounts auto-created per design; card `*last4` are stored in `syncID` but not used for resolution.
- Archived accounts matched by IBAN tail are automatically unarchived.
- Existing account fields (e.g., title and other metadata) are left unchanged; only `syncID` is extended, `archive` toggled when matched, and balance adjusted by the delta of new transactions.
- Transfers paired exact same-currency, FX paired by rate within 15% using CBR → fallback exchange-api (cached).
- Card descriptors parsed for op_date/op_amount/op_currency/card last4; boilerplate stripped; cleared note appended.
- Dry-run writes diff without touching state; rate cache still updated.
- Account balances are adjusted by the cumulative delta of newly generated transactions, never reset or fully recomputed.

## Getting an API token
1. Go to https://zerro.app, authorize, then copy the token from https://zerro.app/token
2. Go to https://budgera.com, authorize, then copy the API key in settings

# Freedom Finance PDF file extractor
`extract_transactions.py` -- using `pdfplumber` extract tables of transactions and other metadata  (like account number and currency).

Extracts into CSV or JSON, JSON can be used with the Syncer.

# License

See LICENSE.md, but consider the LLM use warning above.

# References

- https://github.com/AKosmachyov/zenmoney-us-bank-integration
- https://github.com/sakost/zenmoney-api
- https://github.com/ardov/zerro/tree/master/src/6-shared
- https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API#diff
- https://github.com/zenmoney/ZenPlugins/tree/master/src/plugins/ffin-kz

  this plugin could've replaced this project, but it's very limited and doesn't seem to work with my PDFs from Freedom Banker (non-KZ-resident app)
