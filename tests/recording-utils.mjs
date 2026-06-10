import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { Writable } from "node:stream";

const require = createRequire(import.meta.url);
const {
  extensionFromMime,
  ftpRemoteFileName,
  ftpSecureMode,
  isPathInside,
  safeRecordingFilePath,
  sanitizeName,
  writeBufferToStream
} = require("../electron/recording-utils.cjs");

assert.equal(sanitizeName('ch1 <bad> / name?.webm'), "ch1__bad____name_.webm");
assert.equal(sanitizeName("  spaced   name  "), "_spaced_name_");
assert.equal(sanitizeName("."), "recording");
assert.equal(sanitizeName(".."), "recording");
assert.equal(extensionFromMime("video/mp4"), "mp4");
assert.equal(extensionFromMime("video/webm;codecs=vp8,opus"), "webm");
assert.equal(ftpSecureMode("implicit"), "implicit");
assert.equal(ftpSecureMode("YES"), true);
assert.equal(ftpSecureMode("off"), false);
assert.equal(ftpRemoteFileName({ fileName: "bad:name?.webm" }), "bad_name_.webm");
assert.equal(ftpRemoteFileName({ fileName: ".." }), "recording");

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

const chunks = [];
const successStream = new Writable({
  write(chunk, _encoding, callback) {
    chunks.push(Buffer.from(chunk));
    callback();
  }
});
const written = await writeBufferToStream(successStream, new Uint8Array([1, 2, 3]));
assert.equal(written, 3);
assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3]));

const failureStream = new Writable({
  write(_chunk, _encoding, callback) {
    callback(new Error("disk_full"));
  }
});
await assert.rejects(() => writeBufferToStream(failureStream, Buffer.from([4])), /disk_full/);

console.log("recording utils test passed");
