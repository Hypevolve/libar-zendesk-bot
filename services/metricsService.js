const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_DIR = path.join(__dirname, "..", ".runtime");
const METRICS_PATH = path.join(RUNTIME_DIR, "metrics.json");

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function loadMetrics() {
  try {
    return JSON.parse(fs.readFileSync(METRICS_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

const initialMetrics = loadMetrics() || {
  counters: {},
  updatedAt: new Date().toISOString()
};

function persistMetrics() {
  ensureRuntimeDir();
  const tempPath = `${METRICS_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(initialMetrics, null, 2), "utf8");
  fs.renameSync(tempPath, METRICS_PATH);
}

function increment(metricName, delta = 1) {
  if (!metricName) {
    return;
  }

  initialMetrics.counters[metricName] = Number(initialMetrics.counters[metricName] || 0) + delta;
  initialMetrics.updatedAt = new Date().toISOString();
  persistMetrics();
}

function getSnapshot() {
  return {
    counters: { ...initialMetrics.counters },
    updatedAt: initialMetrics.updatedAt
  };
}

function reset() {
  initialMetrics.counters = {};
  initialMetrics.updatedAt = new Date().toISOString();
  persistMetrics();
}

module.exports = {
  getSnapshot,
  increment,
  reset
};
