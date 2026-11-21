# Dataset B: Meeting Notes & Receipt Reconciliation

## Task Prompt
Inspect all markdown meeting notes under `dataset_b/inbox/notes/` and all JSON receipts under `dataset_b/inbox/receipts/`.
Reconcile approved expenses in **CNY** (`1 USD = 7.20 CNY`), exclude cancelled items, include meeting-approved petty cash entries, and write:
1. `dataset_b/output/reconciled_expenses.json`
2. `dataset_b/output/reconciled_expenses.csv`

## Rules
1. Receipts may use `invoiceId` or `receipt_id`, and `amount` (number or string) or `amountCents`.
2. Exclude any item marked `cancelled` in either the receipt JSON or meeting notes.
3. Include approved petty-cash reimbursements recorded in meeting notes even if no separate JSON receipt exists.
4. Sort items ascending by `id`.

## Output Schemas

### `dataset_b/output/reconciled_expenses.csv`
Header:
`id,vendor,category,project,amount_cny,source`

### `dataset_b/output/reconciled_expenses.json`
```json
{
  "currency": "CNY",
  "usdToCnyRate": 7.2,
  "approvedCount": 4,
  "excludedIds": ["INV-2026-104"],
  "totalApprovedCny": 4330.5,
  "byProject": {
    "Infra-Core": 1200,
    "Q4-Launch": 3130.5
  },
  "items": [
    {
      "id": "INV-2026-101",
      "vendor": "Skyline Air",
      "category": "Travel",
      "project": "Q4-Launch",
      "amountCny": 2450,
      "source": "receipt+notes"
    }
  ]
}
```
