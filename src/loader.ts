import { InputRecord } from "./types.ts";

const REQUIRED_TX_STRING_FIELDS = [
  "account_iban",
  "account_currency",
  "account_type",
  "date",
  "document_number",
  "bank_name",
  "bank_bic",
  "counterparty_name",
  "counterparty_bin",
  "counterparty_account",
  "debit",
  "credit",
  "description",
] as const satisfies ReadonlyArray<keyof InputRecord>;

const ACCOUNT_TYPES = new Set<InputRecord["account_type"]>(["current", "deposit"]);

function buildInputRecord(
  value: unknown,
  idx: number,
  errorFactory: (message: string) => Error,
): InputRecord {
  if (!value || typeof value !== "object") {
    throw errorFactory(`Transaction at index ${idx} must be an object`);
  }
  const obj = value as Record<string, unknown>;
  const base = Object.create(null) as Record<typeof REQUIRED_TX_STRING_FIELDS[number], string>;
  for (const key of REQUIRED_TX_STRING_FIELDS) {
    const val = obj[key];
    if (typeof val !== "string") {
      throw errorFactory(`Transaction ${idx}: '${key}' must be a string`);
    }
    base[key] = val;
  }
  const accountType = base.account_type;
  if (!ACCOUNT_TYPES.has(accountType as InputRecord["account_type"])) {
    throw errorFactory(`Transaction ${idx}: 'account_type' must be 'current' or 'deposit'`);
  }
  const typedAccountType = accountType as InputRecord["account_type"];

  const record: InputRecord = {
    ...base,
    account_type: typedAccountType,
  };
  if (typeof obj.source === "string") record.source = obj.source;
  if (typeof obj.page === "number") record.page = obj.page;
  return record;
}

export function parseInputRecords(
  value: unknown,
  errorFactory: (message: string) => Error = (message) => new Error(message),
  label = "Input",
): InputRecord[] {
  if (!Array.isArray(value)) {
    throw errorFactory(`${label} must be an array of transaction records`);
  }
  return value.map((item, idx) => buildInputRecord(item, idx, errorFactory));
}

export async function loadJsonTransactions(path: string): Promise<InputRecord[]> {
  const data = await Deno.readTextFile(path);
  const parsed = JSON.parse(data);
  return parseInputRecords(parsed);
}
