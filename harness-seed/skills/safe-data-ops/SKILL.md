---
name: safe-data-ops
description: Safely inspect, transform, and verify local CSV, JSON, and log files.
---

# Safe Data Operations

When transforming or summarizing local structured data (CSV, TSV, JSON, logs):
1. Sample headers and raw bytes first before assuming UTF-8 or a fixed delimiter.
2. Write transformed results to explicit output paths rather than silently clobbering raw inputs.
3. After generating an output file, verify it exists, is non-empty, and matches expected row/record counts and totals.
