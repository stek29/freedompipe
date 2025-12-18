"""
n8n Code node (Python, Native).

Input:
    - Run Once for All Items
    - Each item has a PDF statement in binary:
        - base64 mode:
            item["binary"]["attachment_0"]["data"]  -> base64-encoded PDF bytes
        - filesystem-v2 mode:
            item["binary"]["attachment_0"]["data"] == "filesystem-v2"
            item["binary"]["attachment_0"]["id"]   -> "filesystem-v2:<relative_path_under_storage>"
            and BINARY_DATA_STORAGE_PATH must point to the binary storage directory
            (usually ".../n8n/binaryData")

Output:
    - One n8n item per transaction:
        item["json"] = {
            account_iban,
            account_currency,
            account_type,
            date,              # 'YYYY-MM-DD'
            document_number,
            bank_name,
            bank_bic,
            counterparty_name,
            counterparty_bin,
            counterparty_account,
            debit,             # string, empty if None
            credit,            # string, empty if None
            description,
            source,            # PDF name
            page               # page number
        }
    - Sorted by (date, document_number, account_iban, source, page)

needs n8n runners config env-overrides, i.e.:
    "N8N_RUNNERS_STDLIB_ALLOW": "base64,io,json,re,dataclasses,datetime,decimal,enum,typing,_strptime,time,pathlib",
    "N8N_RUNNERS_EXTERNAL_ALLOW": "pdfplumber",
    "N8N_RUNNERS_BUILTINS_DENY": ""
"""

import base64
import io
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from enum import Enum
from pathlib import Path
from typing import List, Optional, Union

import pdfplumber


# === n8n-specific settings ===

# Name of the binary property containing the PDF
BINARY_PROPERTY_NAME = "attachment_0"

# Path to n8n binary storage root (used for filesystem-v2).
# Set this to your n8n binaryData directory (e.g. "/home/runner/binaryData").
BINARY_DATA_STORAGE_PATH = "/n8n-binary-data"


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
    COUNTERPARTY_NAME = ColumnSpec(
        "counterparty_name", "Наименование бенефициара/отправителя"
    )
    COUNTERPARTY_BIN = ColumnSpec("counterparty_bin", "БИН/ИИН бенефициара/отправителя")
    COUNTERPARTY_ACCOUNT = ColumnSpec(
        "counterparty_account", "Номер счета бенефициара/отправителя"
    )
    DEBIT = ColumnSpec("debit", "Дебет", True)
    CREDIT = ColumnSpec("credit", "Кредит", True)
    DESCRIPTION = ColumnSpec("description", "Назначение платежа")


COLUMN_ORDER = tuple(Column)
EXPECTED_HEADERS = [column.value.header for column in COLUMN_ORDER]
COLUMN_INDEX = {column: idx for idx, column in enumerate(COLUMN_ORDER)}

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


def extract_statement_metadata(
    pdf: pdfplumber.PDF, source_name: str
) -> StatementMetadata:
    if not pdf.pages:
        raise ValueError(f"В файле {source_name} нет страниц")

    text_chunks = []
    for page in pdf.pages[:2]:
        page_text = page.extract_text() or ""
        if page_text:
            text_chunks.append(page_text)

    combined_text = "\n".join(text_chunks)
    normalized_text = WHITESPACE_RE.sub(" ", combined_text)

    account_match = ACCOUNT_PATTERN.search(normalized_text)
    if not account_match:
        raise ValueError(f"Не удалось найти номер счета в {source_name}")
    account_iban = account_match.group(1).replace(" ", "").upper()

    currency_match = CURRENCY_PATTERN.search(normalized_text)
    if not currency_match:
        raise ValueError(f"Не удалось найти валюту счета в {source_name}")
    account_currency = currency_match.group(1).upper()

    account_type = detect_account_type(normalized_text)

    return StatementMetadata(
        account_iban=account_iban,
        account_currency=account_currency,
        account_type=account_type,
    )


def is_data_row(cells: List[str]) -> bool:
    return (
        len(cells) > COLUMN_INDEX[Column.DESCRIPTION]
        and parse_date(cells[COLUMN_INDEX[Column.DATE]]) is not None
    )


def is_summary_row(cells: List[str]) -> bool:
    return bool(cells) and cells[0].startswith(SUMMARY_PREFIX)


def parse_summary_count(cells: List[str]) -> Optional[int]:
    if len(cells) > 1:
        token = cells[1].replace(" ", "")
        if token.isdigit():
            return int(token)
    return None


def extract_transactions_from_pdf_source(
    binary_source: Union[Path, io.BytesIO], source_name: str
) -> List[Transaction]:
    """Extract transactions from a PDF source accepted by pdfplumber (Path or BytesIO)."""
    transactions: List[Transaction] = []
    final_summary_count: Optional[int] = None
    column_indices = COLUMN_INDEX

    with pdfplumber.open(binary_source) as pdf:
        metadata = extract_statement_metadata(pdf, source_name)
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
                use_rows = rows

                if headers_match(header_normalized):
                    use_rows = rows[1:]
                elif header_is_summary(header_normalized):
                    continue
                elif not is_data_row(rows[0]):
                    print(
                        f"WARNING: Skipping table with unexpected header on {source_name} page {page_number}"
                    )
                    continue

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
                        print(
                            f"WARNING: Summary count mismatch on {source_name} page {page_number}: "
                            f"expected {expected_count}, got {current_total}"
                        )

    if not transactions and final_summary_count is None:
        print(f"WARNING: No transactions found in {source_name}")
    elif not transactions and final_summary_count == 0:
        pass
    elif final_summary_count is not None and final_summary_count != len(transactions):
        print(
            f"WARNING: Final summary count mismatch on {source_name}: "
            f"expected {final_summary_count}, got {len(transactions)}"
        )

    return transactions


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


def get_n8n_binary_source(file_entry: dict) -> Union[Path, io.BytesIO]:
    """
    Return an n8n binary source.

    For inline mode this returns an in-memory BytesIO wrapping the decoded bytes.
    For filesystem-v2 mode this returns a Path pointing to the stored binary file.

    Supports:
      - Inline base64: {"data": "<base64...>"}
      - filesystem-v2: {"data": "filesystem-v2", "id": "filesystem-v2:<fileId>"}

    For filesystem-v2, BINARY_DATA_STORAGE_PATH must be set to the n8n binary storage directory.
    """
    binary_id = file_entry.get("id")
    if binary_id:
        if ":" not in binary_id:
            raise ValueError("Binary 'id' is not in '<mode>:<fileId>' format")
        mode, file_id = binary_id.split(":", 1)

        if mode in {"filesystem-v2", "filesystem"}:
            if not BINARY_DATA_STORAGE_PATH:
                raise ValueError(
                    "BINARY_DATA_STORAGE_PATH must be set for filesystem-v2 binary data"
                )
            base_path = Path(BINARY_DATA_STORAGE_PATH).resolve()
            file_path = (base_path / file_id).resolve()
            if base_path != file_path and base_path not in file_path.parents:
                raise ValueError(
                    f"Disallowed filesystem-v2 path outside storage root: {file_id}"
                )

            if not file_path.is_file():
                raise ValueError(f"filesystem-v2 binary file not found: {file_path}")
            return file_path

        raise ValueError(f"Unsupported binary storage mode '{mode}'")

    b64_data = file_entry.get("data")
    if not b64_data:
        raise ValueError("Binary entry has no 'data' field")

    if b64_data == "filesystem-v2":
        raise ValueError(
            "Binary entry uses filesystem-v2 but has no 'id' field; cannot locate binary file"
        )

    try:
        raw = base64.b64decode(b64_data)
    except Exception as exc:
        raise ValueError(f"Failed to base64-decode PDF: {exc}") from exc
    return io.BytesIO(raw)


# === Main logic for n8n ===

input_items = _items  # list of incoming items

rows_for_sort: List[dict] = []

for idx, item in enumerate(input_items):
    binary = item.get("binary") or {}
    if not binary:
        raise ValueError(f"Item {idx} has no binary data")

    file_entry = binary.get(BINARY_PROPERTY_NAME)
    if file_entry is None:
        raise ValueError(
            f"Item {idx} missing expected binary property '{BINARY_PROPERTY_NAME}'"
        )

    source_name = file_entry.get("fileName") or f"item_{idx}.pdf"
    binary_source = get_n8n_binary_source(file_entry)
    transactions = extract_transactions_from_pdf_source(binary_source, source_name)

    for tx in transactions:
        row = serialize_core_fields(tx)
        row.update(
            source=tx.source,
            page=tx.page,
        )
        rows_for_sort.append(
            {
                "json": row,
                "pairedItem": {"item": idx},
            }
        )

# Sort like in the original CLI script
rows_for_sort.sort(
    key=lambda item: (
        item["json"]["date"],
        item["json"]["document_number"],
        item["json"]["account_iban"],
        item["json"]["source"],
        item["json"]["page"],
    )
)

return rows_for_sort
