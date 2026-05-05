const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_DIR = path.join(__dirname, "..", ".runtime");
const STORE_PATH = path.join(RUNTIME_DIR, "runtime-store.json");
const SESSION_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const WEBHOOK_RETENTION_MS = 24 * 60 * 60 * 1000;
const START_RETENTION_MS = 6 * 60 * 60 * 1000;

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function normalizeTimestamp(value) {
  const timestamp = new Date(value || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function pruneSessions(sessions = [], now = Date.now()) {
  return (Array.isArray(sessions) ? sessions : []).filter((session) => {
    const updatedAt = normalizeTimestamp(session?.updatedAt || session?.createdAt);
    return updatedAt > 0 && now - updatedAt <= SESSION_RETENTION_MS;
  });
}

function pruneWebhookEntries(entries = [], now = Date.now()) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const createdAt = Number(entry?.createdAt || 0);
    return Number.isFinite(createdAt) && now - createdAt <= WEBHOOK_RETENTION_MS;
  });
}

function pruneRecentStarts(entries = [], now = Date.now()) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => {
    const createdAt = Number(entry?.createdAt || 0);
    return Number.isFinite(createdAt) && now - createdAt <= START_RETENTION_MS;
  });
}

function loadRuntimeState() {
  const parsed = readJsonFile(STORE_PATH) || {};
  const now = Date.now();

  return {
    sessions: pruneSessions(parsed.sessions, now),
    processedWebhookAudits: pruneWebhookEntries(parsed.processedWebhookAudits, now),
    processedWebhookMessages: pruneWebhookEntries(parsed.processedWebhookMessages, now),
    recentChatStarts: pruneRecentStarts(parsed.recentChatStarts, now)
  };
}

function saveRuntimeState(state = {}) {
  ensureRuntimeDir();

  const payload = {
    sessions: pruneSessions(state.sessions),
    processedWebhookAudits: pruneWebhookEntries(state.processedWebhookAudits),
    processedWebhookMessages: pruneWebhookEntries(state.processedWebhookMessages),
    recentChatStarts: pruneRecentStarts(state.recentChatStarts),
    savedAt: new Date().toISOString()
  };

  const tempPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tempPath, STORE_PATH);
}

module.exports = {
  loadRuntimeState,
  saveRuntimeState
};
