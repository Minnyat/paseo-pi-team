#!/usr/bin/env node

const args = process.argv.slice(2);
const mode = process.env.OCR_FIXTURE_MODE ?? "";
const file = process.env.OCR_FIXTURE_FILE ?? "src/reviewed.js";

if (args.includes("version")) {
  if (mode === "old-version") console.log("open-code-review v1.8.9 (fixture)");
  else if (mode === "format-capable") console.log("open-code-review v1.9.2 (fixture)");
  else console.log("open-code-review v1.8.10 (fixture)");
  process.exit(0);
}
if (args.includes("--help")) {
  if (mode === "missing-capability") {
    console.log("delegate command help without required flags");
  } else if (mode === "format-capable") {
    console.log("--repo <path> --from <ref> --to <ref> --format <text|json>");
  } else {
    console.log("--repo <path> --from <ref> --to <ref>");
  }
  process.exit(0);
}
// A format-capable OCR must actually be invoked with --format json.
if (mode === "format-capable" && (args.includes("preview") || args.includes("rule"))) {
  const flagIndex = args.indexOf("--format");
  if (flagIndex === -1 || args[flagIndex + 1] !== "json") {
    console.error("fixture: expected --format json in argv");
    process.exit(1);
  }
}
if (args.includes("preview")) {
  if (mode === "preview-malformed") {
    console.log("{not-json");
    process.exit(0);
  }
  const zero = process.env.OCR_FIXTURE_ZERO === "1";
  console.log(JSON.stringify({
    schema_version: "1",
    mode: "range",
    from: process.env.OCR_FIXTURE_FROM ?? "base",
    to: process.env.OCR_FIXTURE_TO ?? "candidate",
    merge_base: process.env.OCR_FIXTURE_MERGE_BASE ?? "0000000000000000000000000000000000000000",
    total_files: zero ? 0 : 1,
    reviewable_count: zero ? 0 : 1,
    excluded_count: 0,
    reviewable_files: zero ? [] : [{ path: file, status: "modified", insertions: 1, deletions: 1 }],
    excluded_files: [],
  }));
  process.exit(0);
}
if (args.includes("rule")) {
  if (mode === "rules-malformed") {
    console.log(JSON.stringify({ schema_version: "1", groups: [{ group_id: 1, files: [file] }] }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    schema_version: "1",
    groups: [{ group_id: 1, source: "default", pattern: "*.js", files: [file, ...(process.env.OCR_FIXTURE_EXTRA_RULE_FILE ? [process.env.OCR_FIXTURE_EXTRA_RULE_FILE] : [])], rule: "Check correctness and regressions." }],
  }));
  process.exit(0);
}
console.error("unknown fixture command");
process.exit(1);
