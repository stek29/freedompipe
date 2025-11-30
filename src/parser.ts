import { AccountType, InputRecord, NormalizedTransaction } from "./types.ts";
import { appendComment, buildBankId, formatDate, parseAmount, parseIsoDate } from "./utils.ts";

interface DescriptorParseResult {
  opDate?: string;
  opAmount?: number;
  opCurrency?: string;
  cardLast4?: string;
  payee?: string | null;
  residue?: string | null;
}

const CARD_PATTERN =
  /Дата(?: и время)? транзакции:\s*(?<date>\d{2}\.\d{2}\.\d{4})(?: [0-9:]{8})?.*?Номер карты:\s*(?<card>[\d*-]{8,}).*?Сумма транзакции:\s*(?<amount>[\d.,]+)\s*(?<currency>[A-Z]{3}).*?(?:операция:\s*(?<operation>.*?))(?:Учетный курс|$)/i;

const CARD_PATTERN_SHORT =
  /Дата транзакции:\s*(?<date>\d{2}\.\d{2}\.\d{4}).*?Номер карты:\s*(?<card>[\d*-]{8,}).*?Сумма транзакции:\s*(?<amount>[\d.,]+)\s*(?<currency>[A-Z]{3}).*?(?:Операция:\s*(?<operation>.*?))(?:Учетный курс|$)/i;

const CONVERSION_HINT_RE = /^(конвертация$|transfer of own funds$|зачисление купленной валюты|зачисление проданой валюты|выплата вклада по договору)/i;
const BOILERPLATE_PATTERNS: RegExp[] = [
  /^выплата вклада с депозитного договора.+/i,
  /^выплата вклада по договору.+/i,
  /^прием вклада по договору.+/i,
  /^конвертация$/i,
  /^transfer of own funds$/i,
  /^зачисление купленной валюты.+/i,
  /^зачисление проданой валюты.+/i,
];

const PAY_INTEREST_PATTERN = /^выплата процентов по вкладу/i;

const CLEARED_LABEL = "Cleared";

function parseOperationText(operation: string): { payee: string | null; residue: string | null } {
  if (operation.includes("\\")) {
    const withSlashes = operation.split("\\").filter(Boolean);

    const normalizeFirst = (text: string): string => {
      const trailingToken = text.match(/([A-Z0-9*]{5,})\s*$/i);
      if (trailingToken) return trailingToken[1];
      const words = text.trim().split(/\s+/);
      return words[words.length - 1] ?? "";
    };

    const normalized = withSlashes.map((seg, idx) => (idx === 0 ? normalizeFirst(seg) : seg.trim()));
    const payee = normalized[normalized.length - 1]?.trim() || null;
    const residue = normalized.length > 1 ? normalized.slice(0, -1).join("\\") : null;
    return { payee, residue };
  }

  const placeMatch = operation.match(/место [^:]*транзакц[^:]*:\s*([^,]+)(?:,|$)/i);
  if (placeMatch) {
    const place = placeMatch[1].trim();
    const [payeeRaw, ...rest] = place.split(">");
    const payee = payeeRaw.trim() || null;
    const residue = rest.join(">").trim() || null;
    return { payee, residue };
  }

  return { payee: null, residue: null };
}

function parseDescriptor(text: string): DescriptorParseResult | null {
  const source = text.trim();
  const match = source.match(CARD_PATTERN) ?? source.match(CARD_PATTERN_SHORT);
  if (!match?.groups) return null;

  const opDate = match.groups.date;
  const cardRaw = match.groups.card;
  const amountStr = match.groups.amount;
  const currency = match.groups.currency?.toUpperCase();
  const operation = (match.groups.operation ?? "").trim();

  const opAmount = parseAmount(amountStr);
  const cardDigitsMatch = cardRaw.match(/(\d{4})\s*$/);
  const cardLast4 = cardDigitsMatch ? `*${cardDigitsMatch[1]}` : undefined;

  const { payee, residue } = parseOperationText(operation);

  return {
    opDate: normalizeDotDate(opDate),
    opAmount: opAmount ?? undefined,
    opCurrency: currency,
    cardLast4,
    payee: payee || null,
    residue: residue || null,
  };
}

function normalizeDotDate(text: string): string | undefined {
  const parts = text.split(".");
  if (parts.length !== 3) return undefined;
  const [d, m, y] = parts;
  return `${y}-${m}-${d}`;
}

function cleanupBoilerplate(comment: string): { cleaned: string | null; conversionHint: boolean } {
  const stripped = comment.trim();
  for (const pattern of BOILERPLATE_PATTERNS) {
    if (pattern.test(stripped)) {
      return { cleaned: null, conversionHint: true };
    }
  }
  const conversionHint = CONVERSION_HINT_RE.test(stripped);
  const cleaned = stripped || null;
  return { cleaned, conversionHint };
}

function ensureTxnDate(postingDate: string, opDate?: string): string {
  if (!opDate) return postingDate;
  const parsedOp = parseIsoDate(opDate);
  return parsedOp ? formatDate(parsedOp) : postingDate;
}

export async function normalizeRecord(
  record: InputRecord,
  prefix: string,
): Promise<NormalizedTransaction> {
  const postingDate = record.date;
  const direction = record.credit ? "income" : "outcome";
  const amount = direction === "income" ? parseAmount(record.credit) : parseAmount(record.debit);
  if (amount === null) {
    throw new Error(`Row ${record.document_number} missing amount`);
  }

  const descriptor = record.description?.trim() ?? "";
  const descriptorParsed = parseDescriptor(descriptor);
  const { cleaned, conversionHint } = cleanupBoilerplate(descriptor);

  const txnDate = ensureTxnDate(postingDate, descriptorParsed?.opDate);
  let comment = descriptorParsed?.residue ?? cleaned ?? null;
  if (txnDate !== postingDate) {
    comment = appendComment(comment, `${CLEARED_LABEL}: ${postingDate}`);
  }

  const bankId = await buildBankId(prefix, record.document_number, postingDate);

  const bankNamePayee =
    PAY_INTEREST_PATTERN.test(descriptor) && record.bank_name?.trim()
      ? record.bank_name.trim()
      : null;
  return {
    source: record.source,
    accountIban: record.account_iban,
    accountCurrency: record.account_currency.toUpperCase(),
    accountType: record.account_type,
    postingDate,
    txnDate,
    docNumber: record.document_number,
    bankName: record.bank_name,
    bankBic: record.bank_bic,
    counterpartyName: record.counterparty_name,
    counterpartyAccount: record.counterparty_account,
    counterpartyBin: record.counterparty_bin,
    direction,
    amount,
    payee:
      descriptorParsed?.payee ??
        bankNamePayee ??
        record.counterparty_name ??
        null,
    comment,
    opAmount: descriptorParsed?.opAmount,
    opCurrency: descriptorParsed?.opCurrency?.toUpperCase(),
    cardLast4: descriptorParsed?.cardLast4,
    bankId,
    rawComment: descriptor,
    conversionHint,
    wasDeleted: false,
  };
}

export async function normalizeInput(
  records: InputRecord[],
  prefix: string,
): Promise<NormalizedTransaction[]> {
  return await Promise.all(records.map((r) => normalizeRecord(r, prefix)));
}

export function ibanTypeToZenType(type: AccountType): { type: string; savings: boolean } {
  // set different type of account for current and deposit accounts of the deposit card
  if (type === "current") {
    return { type: "ccard", savings: false };
  }
  return { type: "checking", savings: false };
}
