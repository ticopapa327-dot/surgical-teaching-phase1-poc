const { app, BrowserWindow, ipcMain, protocol, shell, session, net, dialog, screen } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const ftp = require("basic-ftp");
const {
  extensionFromMime,
  ftpRemoteFileName,
  ftpSecureMode,
  safeRecordingFilePath,
  sanitizeName
} = require("./recording-utils.cjs");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "recording",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true
    }
  }
]);

const activeRecordings = new Map();

function getDataPaths() {
  const dataDir = app.getPath("userData");
  const recordingsDir = path.join(dataDir, "recordings");
  const indexPath = path.join(recordingsDir, "recordings-index.json");
  fs.mkdirSync(recordingsDir, { recursive: true });
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, "[]", "utf8");
  }
  return { dataDir, recordingsDir, indexPath };
}

function readIndex() {
  const { indexPath } = getDataPaths();
  try {
    const raw = fs.readFileSync(indexPath, "utf8").trim();
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeIndex(items) {
  const { indexPath } = getDataPaths();
  fs.writeFileSync(indexPath, JSON.stringify(items, null, 2), "utf8");
}

function ftpConfigFromEnv() {
  const host = String(process.env.UST_FTP_HOST || "").trim();
  if (!host) return null;
  return {
    host,
    port: Number(process.env.UST_FTP_PORT || 21),
    user: process.env.UST_FTP_USER || "anonymous",
    password: process.env.UST_FTP_PASSWORD || "anonymous@",
    secure: ftpSecureMode(process.env.UST_FTP_SECURE),
    remoteDir: String(process.env.UST_FTP_REMOTE_DIR || "").trim()
  };
}

function attachFileUrls(items) {
  return items.map((item) => ({
    ...item,
    fileUrl: `recording://${encodeURIComponent(item.id)}`
  }));
}

function publicDisplay(display) {
  return {
    id: display.id,
    label: display.label || `Display ${display.id}`,
    primary: display.id === screen.getPrimaryDisplay().id,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor
  };
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(["media", "display-capture"].includes(permission));
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
  if (!app.isPackaged) {
    await win.loadURL(devUrl);
  } else {
    await win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  getDataPaths();

  protocol.handle("recording", async (request) => {
    const url = new URL(request.url);
    const id = decodeURIComponent(url.hostname);
    const { recordingsDir } = getDataPaths();
    const item = readIndex().find((entry) => entry.id === id);
    const filePath = safeRecordingFilePath(recordingsDir, item);
    if (!filePath || !fs.existsSync(filePath)) {
      return new Response("Recording not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("app:get-info", () => {
  const paths = getDataPaths();
  return {
    appName: app.getName(),
    appVersion: app.getVersion(),
    ...paths
  };
});

ipcMain.handle("display:list", () => {
  return screen.getAllDisplays().map(publicDisplay);
});

ipcMain.handle("recording:create", (_event, payload) => {
  const { recordingsDir } = getDataPaths();
  const startedAt = payload.startedAt || new Date().toISOString();
  const sessionId = sanitizeName(payload.sessionId || startedAt);
  const channelName = sanitizeName(payload.channelLabel || payload.channelId || "channel");
  const ext = extensionFromMime(payload.mimeType);
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionDir = path.join(recordingsDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const fileName = `${channelName}-${sanitizeName(startedAt)}.${ext}`;
  const filePath = path.join(sessionDir, fileName);
  const stream = fs.createWriteStream(filePath);

  activeRecordings.set(id, {
    id,
    stream,
    filePath,
    bytes: 0,
    meta: {
      ...payload,
      id,
      startedAt,
      sessionId,
      filePath,
      fileName
    }
  });

  return { id, filePath, fileName };
});

ipcMain.handle("recording:write-chunk", (_event, payload) => {
  const entry = activeRecordings.get(payload.recordingId);
  if (!entry) return { ok: false, reason: "recording_not_found" };
  const chunk = Buffer.from(payload.chunk);
  entry.bytes += chunk.length;
  entry.stream.write(chunk);
  return { ok: true, bytes: entry.bytes };
});

ipcMain.handle("recording:close", async (_event, payload) => {
  const entry = activeRecordings.get(payload.recordingId);
  if (!entry) return { ok: false, reason: "recording_not_found" };
  activeRecordings.delete(payload.recordingId);

  await new Promise((resolve, reject) => {
    entry.stream.once("finish", resolve);
    entry.stream.once("error", reject);
    entry.stream.end();
  });

  const stoppedAt = payload.stoppedAt || new Date().toISOString();
  const stat = fs.existsSync(entry.filePath) ? fs.statSync(entry.filePath) : { size: entry.bytes };
  const item = {
    ...entry.meta,
    stoppedAt,
    durationMs: payload.durationMs || null,
    bytes: stat.size,
    status: "complete",
    createdAt: new Date().toISOString()
  };
  const index = readIndex();
  index.unshift(item);
  writeIndex(index);
  return { ok: true, item: attachFileUrls([item])[0] };
});

ipcMain.handle("recording:list", () => {
  return attachFileUrls(readIndex());
});

ipcMain.handle("recording:delete", (_event, id) => {
  const { recordingsDir } = getDataPaths();
  const index = readIndex();
  const item = index.find((entry) => entry.id === id);
  const filePath = safeRecordingFilePath(recordingsDir, item);
  if (filePath && fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
  writeIndex(index.filter((entry) => entry.id !== id));
  return { ok: true };
});

ipcMain.handle("recording:reveal", (_event, id) => {
  const { recordingsDir } = getDataPaths();
  const item = readIndex().find((entry) => entry.id === id);
  const filePath = safeRecordingFilePath(recordingsDir, item);
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: "recording_not_found" };
  shell.showItemInFolder(filePath);
  return { ok: true };
});

ipcMain.handle("recording:export", async (_event, id) => {
  const { recordingsDir } = getDataPaths();
  const item = readIndex().find((entry) => entry.id === id);
  const filePath = safeRecordingFilePath(recordingsDir, item);
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, reason: "recording_not_found" };
  }
  const result = await dialog.showSaveDialog({
    title: "导出录像",
    defaultPath: item.fileName || path.basename(item.filePath)
  });
  if (result.canceled || !result.filePath) return { ok: false, reason: "canceled" };
  fs.copyFileSync(filePath, result.filePath);
  return { ok: true, filePath: result.filePath };
});

ipcMain.handle("recording:ftp-upload", async (_event, id) => {
  const { recordingsDir } = getDataPaths();
  const item = readIndex().find((entry) => entry.id === id);
  const filePath = safeRecordingFilePath(recordingsDir, item);
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, reason: "recording_not_found" };
  }
  const config = ftpConfigFromEnv();
  if (!config) return { ok: false, reason: "ftp_not_configured" };
  if (!Number.isInteger(config.port) || config.port <= 0 || config.port > 65535) {
    return { ok: false, reason: "ftp_bad_port" };
  }

  const client = new ftp.Client(30000);
  client.ftp.verbose = process.env.UST_FTP_VERBOSE === "1";
  const remoteName = ftpRemoteFileName(item);
  try {
    await client.access({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      secure: config.secure
    });
    if (config.remoteDir) await client.ensureDir(config.remoteDir);
    await client.uploadFrom(filePath, remoteName);
    return {
      ok: true,
      remotePath: config.remoteDir ? path.posix.join(config.remoteDir, remoteName) : remoteName
    };
  } catch (error) {
    return { ok: false, reason: error.code || error.message || "ftp_upload_failed" };
  } finally {
    client.close();
  }
});

ipcMain.handle("recording:open-root", () => {
  const { recordingsDir } = getDataPaths();
  shell.openPath(recordingsDir);
  return { ok: true };
});
