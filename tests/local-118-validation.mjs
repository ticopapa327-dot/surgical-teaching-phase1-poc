import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildStepPlan,
  localAddresses,
  markdownReport,
  parseArgs,
  runValidation,
  timestamp
} = require("../scripts/local-118-validation.cjs");

assert.match(timestamp(new Date("2026-06-14T01:02:03.004Z")), /^2026-06-14T01-02-03-004Z$/);

assert.deepEqual(
  buildStepPlan({ includeAudit: true }).map((step) => step.id),
  ["build", "audit-high", "script-tests", "ui-smoke", "signaling-contract"]
);

assert.deepEqual(
  buildStepPlan({ skipBuild: true, skipSmoke: true }).map((step) => step.id),
  ["script-tests", "signaling-contract"]
);

const parsed = parseArgs(["--dry-run", "--skip-build", "--skip-smoke", "--skip-signaling", "--id", "local-test"]);
assert.equal(parsed.dryRun, true);
assert.equal(parsed.id, "local-test");
assert.deepEqual(
  parsed.steps.map((step) => step.id),
  ["script-tests"]
);

const report = runValidation(parsed, process.cwd());
assert.equal(report.ok, true);
assert.equal(report.dryRun, true);
assert.equal(report.steps.length, 1);
assert.equal(report.steps[0].planned, true);
assert.equal(report.resources.before, null);
assert.equal(report.resources.after, null);

const markdown = markdownReport({ ...report, reportPath: "validation-results/local-118-validation/local-test.json" });
assert.match(markdown, /# 118 Local Validation/);
assert.match(markdown, /\| script-tests \| PASS \|/);

const addresses = localAddresses("192.168.1.118");
assert.equal(Array.isArray(addresses), true);
assert.equal(addresses.every((item) => item.name && item.address), true);

console.log("local 118 validation test passed");
