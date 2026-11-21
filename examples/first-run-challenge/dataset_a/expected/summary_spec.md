# Dataset A: Dirty Multi-Encoding Billing Reconciliation

## Task Prompt
Scan all CSV files under `dataset_a/raw/`, parse every valid transaction, normalize all amounts to **CNY**, and produce two output files under `dataset_a/output/`:
1. `dataset_a/output/billing_cleaned.csv`
2. `dataset_a/output/billing_summary.json`

## Normalization Rules
1. **Encodings & Preambles**:
   - Files may be `UTF-8` (with or without BOM) or `GB18030` / `GBK`.
   - Ignore preamble comment/banner lines before the actual CSV column header.
   - Ignore blank lines.
2. **Column Mapping**:
   - Column names and order vary across branches (e.g. `Record_ID` / `单据编号` / `id`, `Txn_Date` / `日期` / `tx_date`, `Vendor_Name` / `供应商名称` / `supplier`, `Category` / `费用类别` / `dept_category`, `Amount_Raw` / `金额` / `gross_amount`, `Status` / `状态` / `status`, `Notes` / `备注` / `memo`).
3. **Currency & Amount Parsing**:
   - Strip currency prefixes (`¥`, `￥`, `CNY`), thousands separators (`,`), and quotes.
   - Convert accounting parentheses `(180.00)` and leading minus `-¥200.00` / `-￥120.75` to negative numbers.
   - Convert `USD` (`$`) to `CNY` using fixed reference rate **`1 USD = 7.20 CNY`**.
   - Round monetary values to 2 decimal places.
4. **Status Filtering**:
   - Include `PAID` and `REFUND` rows in `billing_cleaned.csv` and net totals.
   - Exclude `VOID` rows from `billing_cleaned.csv` and net totals, and count them in `voidedCount`.

## Output Schemas

### `dataset_a/output/billing_cleaned.csv`
Header:
`id,date,vendor,category,amount_cny,status,source_file`
Sorted ascending by `id`.

### `dataset_a/output/billing_summary.json`
```json
{
  "currency": "CNY",
  "usdToCnyRate": 7.2,
  "recordCount": 9,
  "voidedCount": 2,
  "grossPaidCny": 6656.75,
  "refundTotalCny": -500.75,
  "netTotalCny": 6156,
  "byCategory": {
    "Cloud": 2850.5,
    "Meals": 345.5,
    "Network": 500,
    "Office": 300,
    "Software": 2160
  }
}
```
