import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface DatasetBVerificationResult {
  passed: boolean;
  errors: string[];
  checkedFiles: string[];
}

interface ReconciledReport {
  currency: string;
  usdToCnyRate: number;
  approvedCount: number;
  excludedIds: string[];
  totalApprovedCny: number;
  byProject: Record<string, number>;
  items: Array<{
    id: string;
    vendor: string;
    category: string;
    project: string;
    amountCny: number;
    source: string;
  }>;
}

const EXPECTED_IDS = ["INV-2026-101", "INV-2026-102", "INV-2026-103", "PETTY-2026-01"];

function approxEqual(a: number, b: number, eps = 0.01): boolean {
  return Math.abs(a - b) <= eps;
}

export function verifyDatasetB(outputDir: string): DatasetBVerificationResult {
  const errors: string[] = [];
  const jsonPath = join(outputDir, "reconciled_expenses.json");
  const csvPath = join(outputDir, "reconciled_expenses.csv");
  const checkedFiles = [jsonPath, csvPath];

  if (!existsSync(jsonPath)) {
    errors.push(`Missing required output: ${jsonPath}`);
  } else {
    try {
      const report = JSON.parse(readFileSync(jsonPath, "utf8")) as Partial<ReconciledReport>;
      if (report.currency !== "CNY") {
        errors.push(`currency expected CNY, got ${String(report.currency)}`);
      }
      if (report.approvedCount !== 4) {
        errors.push(`approvedCount expected 4, got ${String(report.approvedCount)}`);
      }
      if (typeof report.totalApprovedCny !== "number" || !approxEqual(report.totalApprovedCny, 4330.5)) {
        errors.push(`totalApprovedCny expected 4330.5, got ${String(report.totalApprovedCny)}`);
      }
      if (!Array.isArray(report.excludedIds) || !report.excludedIds.includes("INV-2026-104")) {
        errors.push("excludedIds must include INV-2026-104");
      }
      if (typeof report.byProject?.["Q4-Launch"] !== "number" || !approxEqual(report.byProject["Q4-Launch"], 3130.5)) {
        errors.push(`byProject.Q4-Launch expected 3130.5, got ${String(report.byProject?.["Q4-Launch"])}`);
      }
      if (typeof report.byProject?.["Infra-Core"] !== "number" || !approxEqual(report.byProject["Infra-Core"], 1200.0)) {
        errors.push(`byProject.Infra-Core expected 1200.0, got ${String(report.byProject?.["Infra-Core"])}`);
      }
      const itemIds = new Set((report.items ?? []).map((item) => item.id));
      for (const expectedId of EXPECTED_IDS) {
        if (!itemIds.has(expectedId)) {
          errors.push(`Missing approved item in JSON items: ${expectedId}`);
        }
      }
      if (itemIds.has("INV-2026-104")) {
        errors.push("Cancelled item INV-2026-104 must not appear in approved items");
      }
    } catch (err) {
      errors.push(`Invalid JSON in reconciled_expenses.json: ${String(err)}`);
    }
  }

  if (!existsSync(csvPath)) {
    errors.push(`Missing required output: ${csvPath}`);
  } else {
    const lines = readFileSync(csvPath, "utf8")
      .replace(/^\uFEFF/, "")
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0);
    if (lines[0]?.trim() !== "id,vendor,category,project,amount_cny,source") {
      errors.push(`Unexpected CSV header: ${lines[0]}`);
    }
    if (lines.length - 1 !== EXPECTED_IDS.length) {
      errors.push(`Expected ${EXPECTED_IDS.length} CSV rows, got ${lines.length - 1}`);
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
  const result = verifyDatasetB(outputDir);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.passed ? 0 : 1);
}
