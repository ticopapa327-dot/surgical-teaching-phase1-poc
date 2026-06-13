import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { describeExitCode, npmCommandParts, parseNonNegativeNumber } = require("../scripts/cross-machine-validation.cjs");

assert.deepEqual(describeExitCode(0), {
  exitCode: 0,
  exitCodeHex: "0x00000000",
  exitCodeName: ""
});

assert.deepEqual(describeExitCode(3221226505), {
  exitCode: 3221226505,
  exitCodeHex: "0xC0000409",
  exitCodeName: "STATUS_STACK_BUFFER_OVERRUN"
});

assert.deepEqual(describeExitCode(null), {
  exitCode: null,
  exitCodeHex: "",
  exitCodeName: ""
});

assert.equal(parseNonNegativeNumber("30", 10, "duration"), 30);
assert.equal(parseNonNegativeNumber("", 10, "duration"), 10);
assert.throws(() => parseNonNegativeNumber("-1", 10, "duration"), /duration must be a non-negative number/);

const wrappedNpm = npmCommandParts("remote:devtools:real-mic:run", ["--", "npm", "run", "test:remote:audio"]);
assert.equal(wrappedNpm.args.includes("remote:devtools:real-mic:run"), true);
assert.equal(wrappedNpm.args.includes("test:remote:audio"), true);

console.log("cross validation utils test passed");
