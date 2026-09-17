# 2026 Ledger → Money HQ import notes

This file documents the conversion performed from the uploaded `2026 Ledger.xlsx`.

## Reconciled current position from the updated ledger

- Cash/checking included in Safe to Spend: **$830.49**
- Wealthfront + TSP tracked savings/retirement: **$5,844.24**
- Credit-card debt: **$18,586.06**
- Total debt represented in the workbook using the latest card balances: **$170,425.18**

The debt total uses the current card balances in the Ledger tab rather than the older credit-card subtotal displayed in `Sheet26`, which is lower by $117.44.

## Import volume

- 14 accounts
- 1,361 historical ledger entries
- 13 debts
- 6 recurring-bill candidates
- 43 historical bill-paid markers
- 6 possible exact-adjacent duplicate entries preserved for review

## Recurring bill candidates

The workbook supports reasonably confident recurring candidates for:
- Mortgage
- Electric
- Water
- Phone
- Natural Gas
- Car Insurance

The import uses the most recent observed payment as an **estimate**, not as a promised future bill amount. Exact due days and autopay status were not present in the workbook.

## Important accounting treatment

Credit-card purchases are counted as spending when they occur on the card ledger. Credit-card payments are treated as transfers rather than spending so the same purchase is not counted twice.

Savings movements and ordinary account-to-account transfers are also excluded from spending reports.

The source workbook records months, not exact transaction dates. Money HQ preserves that limitation with a `monthOnly` flag.

## Review flags preserved rather than deleted

The importer found a small number of adjacent, exact-value repeats that may be genuine transactions or duplicates. They remain in the import and appear in Settings → Import Review. Nothing was silently deleted.
