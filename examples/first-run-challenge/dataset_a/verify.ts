import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

export interface DatasetAVerificationResult {
  passed: boolean;
  errors: string[];
  checkedFiles: string[];
}

interface BillingSummary {
  currency: string;
  usdToCnyRate: number;
  recordCount: number;
  voidedCount: number;
  grossPaidCny: number;
  refundTotalCny: number;
  netTotalCny: number;
  byCategory: Record<string, number>;
}

const EXPECTED_SUMMARY: BillingSummary = {
  currency: "CNY",
  usdToCnyRate: 7.2,
  recordCount: 9,
  voidedCount: 2,
  grossPaidCny: 6656.75,
  refundTotalCny: -500.75,
  netTotalCny: 6156.0,
  byCategory: {
    Cloud: 2850.5,
    Meals: 345.5,
    Network: 500.0,
    Office: 300.0,
    Software: 2160.0,
  },
};

const EXPECTED_IDS = [
  "EAST-101",
  "EAST-102",
  "EAST-103",
  "HQ-001",
  "HQ-002",
  "HQ-003",
  "SOUTH-201",
  "SOUTH-202",
  "SOUTH-203",
];

const EXPECTED_VENDORS: Record<string, string> = {
  "EAST-101": "华东云算力有限公司",
  "EAST-102": "星河办公采购",
  "EAST-103": "星河办公采购",
};

function approxEqual(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) <= eps;
}

export function verifyDatasetA(outputDir: string): DatasetAVerificationResult {
  const errors: string[] = [];
  const summaryPath = join(outputDir, "billing_summary.json");
  const csvPath = join(outputDir, "billing_cleaned.csv");
  const checkedFiles = [summaryPath, csvPath];

  if (!existsSync(summaryPath)) {
    errors.push(`Missing required output: ${summaryPath}`);
  } else {
    try {
      const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Partial<BillingSummary>;
      if (summary.currency !== EXPECTED_SUMMARY.currency) {
        errors.push(`currency expected CNY, got ${String(summary.currency)}`);
      }
      if (summary.recordCount !== EXPECTED_SUMMARY.recordCount) {
        errors.push(`recordCount expected ${EXPECTED_SUMMARY.recordCount}, got ${String(summary.recordCount)}`);
      }
      if (summary.voidedCount !== EXPECTED_SUMMARY.voidedCount) {
        errors.push(`voidedCount expected ${EXPECTED_SUMMARY.voidedCount}, got ${String(summary.voidedCount)}`);
      }
      if (typeof summary.grossPaidCny !== "number" || !approxEqual(summary.grossPaidCny, EXPECTED_SUMMARY.grossPaidCny)) {
        errors.push(`grossPaidCny expected ${EXPECTED_SUMMARY.grossPaidCny}, got ${String(summary.grossPaidCny)}`);
      }
      if (typeof summary.refundTotalCny !== "number" || !approxEqual(summary.refundTotalCny, EXPECTED_SUMMARY.refundTotalCny)) {
        errors.push(`refundTotalCny expected ${EXPECTED_SUMMARY.refundTotalCny}, got ${String(summary.refundTotalCny)}`);
      }
      if (typeof summary.netTotalCny !== "number" || !approxEqual(summary.netTotalCny, EXPECTED_SUMMARY.netTotalCny)) {
        errors.push(`netTotalCny expected ${EXPECTED_SUMMARY.netTotalCny}, got ${String(summary.netTotalCny)}`);
      }
      for (const [cat, expectedVal] of Object.entries(EXPECTED_SUMMARY.byCategory)) {
        const actual = summary.byCategory?.[cat];
        if (typeof actual !== "number" || !approxEqual(actual, expectedVal)) {
          errors.push(`byCategory.${cat} expected ${expectedVal}, got ${String(actual)}`);
        }
      }
    } catch (err) {
      errors.push(`Invalid JSON in billing_summary.json: ${String(err)}`);
    }
  }

  if (!existsSync(csvPath)) {
    errors.push(`Missing required output: ${csvPath}`);
  } else {
    const rawCsv = readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "").trim();
    const lines = rawCsv.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      errors.push("billing_cleaned.csv is empty");
    } else {
      const header = lines[0]?.trim();
      if (header !== "id,date,vendor,category,amount_cny,status,source_file") {
        errors.push(`Unexpected CSV header: ${header}`);
      }
      const dataLines = lines.slice(1);
      if (dataLines.length !== EXPECTED_IDS.length) {
        errors.push(`Expected ${EXPECTED_IDS.length} data rows in billing_cleaned.csv, got ${dataLines.length}`);
      }
      const seenIds: string[] = [];
      for (const line of dataLines) {
        const cols = line.split(",");
        const id = cols[0]?.trim() ?? "";
        const vendor = cols[2]?.trim() ?? "";
        seenIds.push(id);
        const expectedVendor = EXPECTED_VENDORS[id];
        if (expectedVendor && vendor !== expectedVendor) {
          errors.push(`Encoding mismatch for ${id}: expected vendor "${expectedVendor}", got "${vendor}"`);
        }
      }
      for (const id of EXPECTED_IDS) {
        if (!seenIds.includes(id)) {
          errors.push(`Missing expected record ID in CSV: ${id}`);
        }
      }
    }
  }

  return {
    passed: errors.length === 0,
    errors,
    checkedFiles,
  };
}

if (import.meta.main) {
  const argIdx = process.argv.indexOf("--output-dir");
  const defaultOut = join(dirname(import.meta.path), "output");
  const outputDir = argIdx >= 0 && process.argv[argIdx + 1] ? process.argv[argIdx + 1]! : defaultOut;
  const result = verifyDatasetA(outputDir);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
