#!/usr/bin/env python3
"""
Extract bank transactions from PDF statements that contain selectable text.

Dependencies:
    pip install pdfplumber

Example:
    python extract_transactions.py --format csv -o transactions.csv statement.pdf
"""
from __future__ import annotations

import argparse
import csv
import json
import logging
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from enum import Enum
from pathlib import Path
from typing import List, Optional

import pdfplumber

TABLE_SETTINGS = {
    "vertical_strategy": "lines",
    "horizontal_strategy": "lines",
    "intersection_tolerance": 5,
    "snap_tolerance": 3,
    "join_tolerance": 3,
    "edge_min_length": 3,
}

METADATA_FIELDS = ["account_iban", "account_currency", "account_type"]

@dataclass(frozen=True)
class ColumnSpec:
    attr: str
    header: str
    is_decimal: bool = False


class Column(Enum):
    DATE = ColumnSpec("date", "Дата операции")
    DOCUMENT_NUMBER = ColumnSpec("document_number", "Номер документа")
    BANK_NAME = ColumnSpec("bank_name", "Наименование банка бенефициара/получателя")
    BANK_BIC = ColumnSpec("bank_bic", "БИК банка бенефициара/получателя")
    COUNTERPARTY_NAME = ColumnSpec("counterparty_name", "Наименование бенефициара/отправителя")
    COUNTERPARTY_BIN = ColumnSpec("counterparty_bin", "БИН/ИИН бенефициара/отправителя")
    COUNTERPARTY_ACCOUNT = ColumnSpec("counterparty_account", "Номер счета бенефициара/отправителя")
    DEBIT = ColumnSpec("debit", "Дебет", True)
    CREDIT = ColumnSpec("credit", "Кредит", True)
    DESCRIPTION = ColumnSpec("description", "Назначение платежа")


COLUMN_ORDER = tuple(Column)
EXPECTED_HEADERS = [column.value.header for column in COLUMN_ORDER]
COMPACT_HEADERS = ["дата операции", "номер документа", "сумма", "назначение платежа"]
COMPACT_TOTAL_RE = re.compile(r"^\s*(Дебет|Кредит)\s*:\s*(.*?)\s*$", re.IGNORECASE)
COLUMN_INDEX = {column: idx for idx, column in enumerate(COLUMN_ORDER)}
CSV_FIELD_ORDER = METADATA_FIELDS + [column.value.attr for column in COLUMN_ORDER]

SUMMARY_PREFIX = "Итого"

WHITESPACE_RE = re.compile(r"[\s\u00a0\u2007\u202f]+")
SLASH_SPACE_RE = re.compile(r"\s*/\s*")
DATE_INPUT_FORMAT = "%d.%m.%Y"
DATE_OUTPUT_FORMAT = "%Y-%m-%d"
ACCOUNT_PATTERN = re.compile(r"Сч[её]т[:\s]+([A-Z0-9 ]{10,})", re.IGNORECASE)
CURRENCY_PATTERN = re.compile(r"Валют[аы][:\s]+([A-Z]{3})", re.IGNORECASE)


@dataclass(frozen=True)
class StatementMetadata:
    account_iban: str
    account_currency: str
    account_type: str


@dataclass
class Transaction:
    account_iban: str
    account_currency: str
    account_type: str
    date: datetime
    document_number: str
    bank_name: str
    bank_bic: str
    counterparty_name: str
    counterparty_bin: str
    counterparty_account: str
    debit: Optional[Decimal]
    credit: Optional[Decimal]
    description: str
    source: str
    page: int


def normalize_cell(cell: Optional[str]) -> str:
    if cell is None:
        return ""
    text = WHITESPACE_RE.sub(" ", str(cell))
    return text.strip()


def canonicalize_header(text: str) -> str:
    return SLASH_SPACE_RE.sub("/", text)


def normalize_header(row: List[str]) -> List[str]:
    return [canonicalize_header(cell) for cell in row]


def headers_match(normalized_header: List[str]) -> bool:
    return normalized_header[: len(EXPECTED_HEADERS)] == EXPECTED_HEADERS


def header_is_summary(normalized_header: List[str]) -> bool:
    return bool(normalized_header) and normalized_header[0].startswith(SUMMARY_PREFIX)


def parse_date(cell: str) -> Optional[datetime]:
    if not cell:
        return None
    try:
        return datetime.strptime(cell, DATE_INPUT_FORMAT)
    except ValueError:
        return None


def parse_amount(text: str) -> Optional[Decimal]:
    if not text:
        return None
    token = text.replace(" ", "")
    try:
        return Decimal(token)
    except InvalidOperation:
        return None


def detect_account_type(text: str) -> str:
    normalized = WHITESPACE_RE.sub(" ", text).casefold()
    if "выписка по текущему счету" in normalized:
        return "current"
    if "выписка по депозитному счету" in normalized:
        return "deposit"
    return "unknown"


def extract_statement_metadata(pdf: pdfplumber.PDF, pdf_path: Path) -> StatementMetadata:
    if not pdf.pages:
        raise ValueError(f"В файле {pdf_path} нет страниц")

    text_chunks = []
    for page in pdf.pages[:2]:
        page_text = page.extract_text() or ""
        if page_text:
            text_chunks.append(page_text)

    combined_text = "\n".join(text_chunks)
    normalized_text = WHITESPACE_RE.sub(" ", combined_text)

    account_match = ACCOUNT_PATTERN.search(normalized_text)
    if not account_match:
        raise ValueError(f"Не удалось найти номер счета в {pdf_path.name}")
    account_iban = account_match.group(1).replace(" ", "").upper()

    currency_match = CURRENCY_PATTERN.search(normalized_text)
    if not currency_match:
        raise ValueError(f"Не удалось найти валюту счета в {pdf_path.name}")
    account_currency = currency_match.group(1).upper()

    account_type = detect_account_type(normalized_text)

    return StatementMetadata(
        account_iban=account_iban,
        account_currency=account_currency,
        account_type=account_type,
    )


def is_data_row(cells: List[str]) -> bool:
    return len(cells) > COLUMN_INDEX[Column.DESCRIPTION] and parse_date(cells[COLUMN_INDEX[Column.DATE]]) is not None


def is_summary_row(cells: List[str]) -> bool:
    return bool(cells) and cells[0].startswith(SUMMARY_PREFIX)


def parse_summary_count(cells: List[str]) -> Optional[int]:
    if len(cells) > 1:
        token = cells[1].replace(" ", "")
        if token.isdigit():
            return int(token)
    return None


def verify_compact_totals(pdf: pdfplumber.PDF, transactions: List[Transaction], source_name: str) -> None:
    statement_totals = {}
    for page in pdf.pages:
        for line in (page.extract_text() or "").splitlines():
            match = COMPACT_TOTAL_RE.fullmatch(line)
            if match:
                amount = parse_amount(normalize_cell(match.group(2)))
                if amount is None or not amount.is_finite():
                    raise ValueError(f"Invalid statement total in {source_name}")
                statement_totals[match.group(1).casefold()] = abs(amount)

    totals = {
        "дебет": sum(tx.debit for tx in transactions if tx.debit is not None),
        "кредит": sum(tx.credit for tx in transactions if tx.credit is not None),
    }
    if statement_totals != totals:
        raise ValueError(f"Transaction totals do not match the statement in {source_name}")


def parse_compact_row(
    cells: List[str], metadata: StatementMetadata, source_name: str, page: int
) -> Optional[Transaction]:
    # Merged footer cells appear in the first column.
    if len(cells) == len(COMPACT_HEADERS) and not any(cells[1:]):
        return None
    if len(cells) != len(COMPACT_HEADERS):
        raise ValueError(f"Unexpected compact row width in {source_name} on page {page}")
    date, document_number, signed_amount, description = cells
    parsed_date = parse_date(date)
    amount = parse_amount(signed_amount)
    if not parsed_date or not document_number or amount is None or not amount.is_finite():
        raise ValueError(f"Invalid transaction row in {source_name} on page {page}")
    return Transaction(
        account_iban=metadata.account_iban,
        account_currency=metadata.account_currency,
        account_type=metadata.account_type,
        date=parsed_date,
        document_number=document_number,
        bank_name="",
        bank_bic="",
        counterparty_name="",
        counterparty_bin="",
        counterparty_account="",
        debit=-amount if amount < 0 else None,
        credit=amount if amount >= 0 else None,
        description=description,
        source=source_name,
        page=page,
    )


def extract_transactions_from_pdf(pdf_path: Path, logger: logging.Logger) -> List[Transaction]:
    source_name = pdf_path.name
    transactions: List[Transaction] = []
    final_summary_count: Optional[int] = None
    column_indices = COLUMN_INDEX
    compact = False
    detailed = False

    with pdfplumber.open(pdf_path) as pdf:
        metadata = extract_statement_metadata(pdf, pdf_path)
        for page_number, page in enumerate(pdf.pages, start=1):
            tables = page.extract_tables(TABLE_SETTINGS) or []
            if not tables:
                tables = page.extract_tables()

            for table in tables:
                rows = [[normalize_cell(cell) for cell in (row or [])] for row in table]
                rows = [row for row in rows if any(cell for cell in row)]
                if not rows:
                    continue

                header_normalized = normalize_header(rows[0])
                compact_header = [cell.casefold() for cell in header_normalized] == COMPACT_HEADERS
                compact_continuation = (
                    compact and len(rows[0]) == len(COMPACT_HEADERS) and parse_date(rows[0][0])
                )
                if compact_header or compact_continuation:
                    compact = True
                    for cells in rows[1:] if compact_header else rows:
                        transaction = parse_compact_row(cells, metadata, source_name, page_number)
                        if transaction is not None:
                            transactions.append(transaction)
                    continue

                use_rows = rows

                if headers_match(header_normalized):
                    detailed = True
                    use_rows = rows[1:]
                elif header_is_summary(header_normalized):
                    summary_count = parse_summary_count(rows[0])
                    if summary_count is not None:
                        final_summary_count = summary_count
                    continue
                elif not is_data_row(rows[0]):
                    logger.warning(
                        "Skipping table with unexpected header on %s page %s", source_name, page_number
                    )
                    continue
                else:
                    detailed = True

                expected_count = None
                if use_rows and is_summary_row(use_rows[-1]):
                    summary = use_rows[-1]
                    expected_count = parse_summary_count(summary)
                    if expected_count is not None:
                        final_summary_count = expected_count
                    use_rows = use_rows[:-1]

                for cells in use_rows:
                    if len(cells) <= column_indices[Column.DESCRIPTION]:
                        continue

                    parsed_date = parse_date(cells[column_indices[Column.DATE]])
                    if not parsed_date:
                        continue

                    document_number = cells[column_indices[Column.DOCUMENT_NUMBER]]
                    bank_name = cells[column_indices[Column.BANK_NAME]]
                    bank_bic = cells[column_indices[Column.BANK_BIC]]
                    counterparty_name = cells[column_indices[Column.COUNTERPARTY_NAME]]
                    counterparty_bin = cells[column_indices[Column.COUNTERPARTY_BIN]]
                    counterparty_account = cells[
                        column_indices[Column.COUNTERPARTY_ACCOUNT]
                    ]
                    description = cells[column_indices[Column.DESCRIPTION]]

                    debit = parse_amount(cells[column_indices[Column.DEBIT]])
                    credit = parse_amount(cells[column_indices[Column.CREDIT]])

                    if debit is None and credit is None:
                        continue

                    transactions.append(
                        Transaction(
                            account_iban=metadata.account_iban,
                            account_currency=metadata.account_currency,
                            account_type=metadata.account_type,
                            date=parsed_date,
                            document_number=document_number,
                            bank_name=bank_name,
                            bank_bic=bank_bic,
                            counterparty_name=counterparty_name,
                            counterparty_bin=counterparty_bin,
                            counterparty_account=counterparty_account,
                            debit=debit,
                            credit=credit,
                            description=description,
                            source=source_name,
                            page=page_number,
                        )
                    )

                if expected_count is not None:
                    current_total = len(transactions)
                    if current_total != expected_count:
                        logger.warning(
                            "Summary count mismatch on %s page %s: expected %s, got %s",
                            source_name, page_number, expected_count, current_total,
                        )

        if compact:
            if detailed:
                raise ValueError(f"Mixed transaction table layouts in {source_name}")
            verify_compact_totals(pdf, transactions, source_name)
        elif final_summary_count is not None and final_summary_count != len(transactions):
            raise ValueError(f"Transaction count does not match the statement in {source_name}")
        elif not transactions and final_summary_count != 0:
            raise ValueError(f"No recognized transactions or empty statement totals in {source_name}")

    return transactions


def output_csv(transactions: List[Transaction], destination: Optional[Path]) -> None:
    fieldnames = CSV_FIELD_ORDER
    rows = [serialize_core_fields(tx) for tx in transactions]

    if destination:
        with destination.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)
    else:
        writer = csv.DictWriter(sys.stdout, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def output_json(transactions: List[Transaction], destination: Optional[Path]) -> None:
    payload = []
    for tx in transactions:
        entry = serialize_core_fields(tx)
        entry.update(
            source=tx.source,
            page=tx.page,
        )
        payload.append(entry)

    if destination:
        destination.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    else:
        print(json.dumps(payload, indent=2, ensure_ascii=False))


def format_decimal(value: Optional[Decimal]) -> str:
    if value is None:
        return ""
    return format(value, "f")


def serialize_core_fields(tx: Transaction) -> dict:
    data = {
        "account_iban": tx.account_iban,
        "account_currency": tx.account_currency,
        "account_type": tx.account_type,
    }
    for column in COLUMN_ORDER:
        attr = column.value.attr
        value = getattr(tx, attr)
        if column is Column.DATE:
            data[attr] = value.strftime(DATE_OUTPUT_FORMAT)
        elif column.value.is_decimal:
            data[attr] = format_decimal(value)
        else:
            data[attr] = value
    return data


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract transactions from PDF statements without OCR.")
    parser.add_argument("pdfs", nargs="+", type=Path, help="One or more PDF statement files.")
    parser.add_argument("-o", "--output", type=Path, help="Optional destination file path.")
    parser.add_argument("--format", choices=("csv", "json"), default="csv", help="Output format (default: csv).")
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=("DEBUG", "INFO", "WARNING", "ERROR"),
        help="Logging verbosity (default: INFO).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=getattr(logging, args.log_level), format="%(levelname)s: %(message)s")
    logger = logging.getLogger("extract-transactions")

    all_transactions: List[Transaction] = []
    for pdf in args.pdfs:
        if not pdf.exists():
            logger.error("File not found: %s", pdf)
            continue
        try:
            transactions = extract_transactions_from_pdf(pdf, logger)
        except ValueError as exc:
            logger.error("%s", exc)
            sys.exit(1)
        all_transactions.extend(transactions)

    all_transactions.sort(key=lambda tx: (tx.date, tx.document_number, tx.account_iban, tx.source, tx.page))

    if args.format == "csv":
        output_csv(all_transactions, args.output)
    else:
        output_json(all_transactions, args.output)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
