import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  extensionFromMime,
  ftpRemoteFileName,
  ftpSecureMode,
  isPathInside,
  safeRecordingFilePath,
  sanitizeName
} = require("../electron/recording-utils.cjs");

assert.equal(sanitizeName('ch1 <bad> / name?.webm'), "ch1__bad____name_.webm");
assert.equal(sanitizeName("  spaced   name  "), "_spaced_name_");
assert.equal(extensionFromMime("video/mp4"), "mp4");
assert.equal(extensionFromMime("video/webm;codecs=vp8,opus"), "webm");
assert.equal(ftpSecureMode("implicit"), "implicit");
assert.equal(ftpSecureMode("YES"), true);
assert.equal(ftpSecureMode("off"), false);
assert.equal(ftpRemoteFileName({ fileName: "bad:name?.webm" }), "bad_name_.webm");

const root = path.resolve("tmp-recording-root");
const inside = path.join(root, "session", "case.webm");
const outside = path.join(path.dirname(root), "outside.webm");
const siblingPrefix = `${root}-sibling`;

assert.equal(isPathInside(root, inside), true);
assert.equal(isPathInside(root, root), true);
assert.equal(isPathInside(root, outside), false);
assert.equal(isPathInside(root, path.join(siblingPrefix, "case.webm")), false);
assert.equal(safeRecordingFilePath(root, { filePath: inside }), path.resolve(inside));
assert.equal(safeRecordingFilePath(root, { filePath: outside }), "");
assert.equal(safeRecordingFilePath(root, null), "");

console.log("recording utils test passed");
