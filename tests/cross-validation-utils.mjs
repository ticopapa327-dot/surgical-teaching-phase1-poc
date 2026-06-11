import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { describeExitCode } = require("../scripts/cross-machine-validation.cjs");

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

console.log("cross validation utils test passed");
