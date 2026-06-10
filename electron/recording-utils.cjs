const path = require("path");

function sanitizeName(value) {
  return String(value || "recording")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function ftpSecureMode(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "implicit") return "implicit";
  return ["1", "true", "yes", "on"].includes(text);
}

function ftpRemoteFileName(item) {
  return sanitizeName(path.basename(item.fileName || item.filePath || `${item.id}.webm`));
}

function extensionFromMime(mimeType) {
  if (mimeType && mimeType.includes("mp4")) return "mp4";
  return "webm";
}

function isPathInside(parentDir, targetPath) {
  if (!parentDir || !targetPath) return false;
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRecordingFilePath(recordingsDir, item) {
  if (!item?.filePath) return "";
  const filePath = path.resolve(item.filePath);
  return isPathInside(recordingsDir, filePath) ? filePath : "";
}

module.exports = {
  sanitizeName,
  ftpSecureMode,
  ftpRemoteFileName,
  extensionFromMime,
  isPathInside,
  safeRecordingFilePath
};
