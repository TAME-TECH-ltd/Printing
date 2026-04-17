const electron = require("electron");
const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, Notification } =
  electron;
const {
  ThermalPrinter,
  PrinterTypes,
  CharacterSet,
  BreakLine,
} = require("node-thermal-printer");
const Database = require("better-sqlite3");
const os = require("os");

const userDataPath = app.getPath("userData");
const dbFilePath = path.join(userDataPath, "printing.sqlite");
console.log("Database path:", dbFilePath);

let db;
const activePrinterProcessors = new Set();
const printQueueTimers = new Map();
const suppressedRoundIds = new Set();
let recoveredInterruptedJobsCount = 0;
let lastKnownSystemPrinters = [];
let lastDashboardNotificationAt = 0;
let cachedStartupChecks = [];
let cachedStartupChecksAt = 0;

const PRINT_JOB_STATUS = {
  PENDING: "pending",
  PROCESSING: "processing",
  COMPLETED: "completed",
};

const PRINT_QUEUE_BASE_DELAY_MS = 3000;
const PRINT_QUEUE_MAX_DELAY_MS = 60000;
const PRINT_EXECUTION_TIMEOUT_MS = 20000;
const DASHBOARD_NOTIFICATION_THROTTLE_MS = 60000;
const DEFAULT_PRINTER_CHARACTER_SET = "PC852_LATIN2";
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const LOGO_MAX_WIDTH_PX = 420;
const LOGO_MAX_HEIGHT_PX = 190;

function initializeDatabase() {
  try {
    db = new Database(dbFilePath);
    db.pragma("journal_mode = WAL");

    db.exec(`
      CREATE TABLE IF NOT EXISTS printers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        type TEXT NOT NULL,
        ip TEXT,
        port TEXT,
        interface TEXT NOT NULL,
        content TEXT
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        base_url TEXT NOT NULL,
        outlet_code TEXT
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL
      );
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS print_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printer_id INTEGER,
        round_id INTEGER,
        printer_key TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_retry_at TEXT,
        locked_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        duration_ms INTEGER,
        test_mode INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_print_jobs_status_retry
      ON print_jobs (status, next_retry_at, created_at);
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS print_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printer_id INTEGER,
        printer_key TEXT NOT NULL,
        round_id INTEGER,
        job_id INTEGER,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        payload TEXT,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_print_logs_printer_created
      ON print_logs (printer_key, created_at DESC);
    `);

    ensureColumnExists("printers", "paused", "INTEGER NOT NULL DEFAULT 0");
    ensureColumnExists(
      "printers",
      "supports_cut",
      "INTEGER NOT NULL DEFAULT 1",
    );
    ensureColumnExists(
      "printers",
      "supports_beep",
      "INTEGER NOT NULL DEFAULT 1",
    );
    ensureColumnExists("printers", "supports_qr", "INTEGER NOT NULL DEFAULT 1");
    ensureColumnExists("printers", "print_logo", "INTEGER NOT NULL DEFAULT 1");
    ensureColumnExists(
      "printers",
      "character_set",
      `TEXT NOT NULL DEFAULT '${DEFAULT_PRINTER_CHARACTER_SET}'`,
    );

    ensureColumnExists("print_jobs", "printer_id", "INTEGER");
    ensureColumnExists("print_jobs", "started_at", "TEXT");
    ensureColumnExists("print_jobs", "completed_at", "TEXT");
    ensureColumnExists("print_jobs", "duration_ms", "INTEGER");
    ensureColumnExists("print_jobs", "test_mode", "INTEGER NOT NULL DEFAULT 0");
    ensureColumnExists("settings", "remote_system_date", "TEXT");
    ensureColumnExists("settings", "remote_day_token", "TEXT");

    recoverInterruptedPrintJobs();

    const userCount = db.prepare("SELECT COUNT(*) as count FROM users").get();
    if (userCount.count === 0) {
      db.prepare("INSERT INTO users (username, password) VALUES (?, ?)").run(
        "admin",
        "tame123",
      );
      console.log("Default user created");
    }

    console.log("Database initialized successfully");
    return true;
  } catch (error) {
    console.error("Database initialization error:", error);
    throw error;
  }
}

function ensureColumnExists(tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some((column) => column.name === columnName)) {
    db.exec(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`,
    );
  }
}

function nowIsoString() {
  return new Date().toISOString();
}

function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }

  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function boolToInt(value, defaultValue = 0) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  return value ? 1 : 0;
}

function formatTimestampForUi(timestamp) {
  if (!timestamp) return null;

  try {
    return new Date(timestamp).toLocaleString("en-US", {
      timeZone: helper.timeZone,
    });
  } catch {
    return timestamp;
  }
}

function getPrinterIdFromKey(printerKey) {
  if (!printerKey || !printerKey.startsWith("printer:")) {
    return null;
  }

  const id = Number(printerKey.slice("printer:".length));
  return Number.isFinite(id) ? id : null;
}

function getPrinterRecordById(printerId) {
  if (!printerId) return null;
  return (
    db.prepare("SELECT * FROM printers WHERE id = ?").get(printerId) || null
  );
}

function getPrinterRecordByKey(printerKey) {
  const printerId = getPrinterIdFromKey(printerKey);
  if (!printerId) return null;
  return getPrinterRecordById(printerId);
}

function getPrinterDisplayName(printerKey) {
  const printer = getPrinterRecordByKey(printerKey);
  return printer?.name || printerKey;
}

function getSettingsRecord() {
  return db.prepare("SELECT * FROM settings LIMIT 1").get() || null;
}

function normalizeSystemDate(value) {
  if (!value) return null;
  const stringValue = String(value);
  return stringValue.length >= 10 ? stringValue.slice(0, 10) : stringValue;
}

function buildClientToken(data = {}) {
  const printerLabel = data?.printer || data?.printerKey || "printer";
  return `${os.hostname()}:${printerLabel}`;
}

function truncatePayload(payload) {
  const serialized =
    typeof payload === "string" ? payload : JSON.stringify(payload || {});
  return serialized.slice(0, 4000);
}

function buildPrinterKey(data = {}) {
  if (data.printerId) {
    return `printer:${data.printerId}`;
  }

  return [
    data.printer || "",
    data.interface || "",
    data.ip || "",
    data.port || "",
    data.content || "",
  ].join("|");
}

function buildPrintedMeta(data = {}) {
  return {
    latest: data?.round?.id,
    ...(data?.printerId ? { printerId: data.printerId } : {}),
    ...(data?.printerKey ? { printerKey: data.printerKey } : {}),
    ...(data?.clientToken ? { clientToken: data.clientToken } : {}),
    ...(data?.printAttempts ? { printAttempts: data.printAttempts } : {}),
    ...(data?.content ? { content: data.content } : {}),
  };
}

function clearAllPrintQueueTimers() {
  Array.from(printQueueTimers.keys()).forEach((printerKey) => {
    clearPrintQueueTimer(printerKey);
  });
}

function purgeQueuedRoundsForDayClose(remoteState = {}) {
  const jobs = db
    .prepare(
      `
        SELECT id, printer_id, printer_key, round_id, status
        FROM print_jobs
        WHERE round_id IS NOT NULL
          AND status IN (?, ?)
      `,
    )
    .all(PRINT_JOB_STATUS.PENDING, PRINT_JOB_STATUS.PROCESSING);

  if (!jobs.length) {
    return { purgedJobs: 0, purgedRounds: 0 };
  }

  jobs.forEach((job) => {
    if (job?.round_id) {
      suppressedRoundIds.add(Number(job.round_id));
    }
  });

  const result = db
    .prepare(
      `
        DELETE FROM print_jobs
        WHERE round_id IS NOT NULL
          AND status IN (?, ?)
      `,
    )
    .run(PRINT_JOB_STATUS.PENDING, PRINT_JOB_STATUS.PROCESSING);

  clearAllPrintQueueTimers();

  const purgedRounds = jobs.filter((job) => job?.round_id).length;
  const message = `Cleared ${result.changes} local print job(s) after day close`;

  insertPrintLog({
    printer_key: "system",
    event_type: "day-close-purge",
    status: "warning",
    message,
    payload: {
      systemDate: remoteState.systemDate || null,
      dayToken: remoteState.dayToken || null,
      purgedJobs: jobs.map((job) => job.id),
      purgedRounds: jobs.map((job) => job.round_id).filter(Boolean),
    },
  });

  mainWindow?.webContents.send("queue-reset", {
    message,
    purgedJobs: Number(result.changes || 0),
    purgedRounds,
    systemDate: remoteState.systemDate || null,
  });

  maybeNotify("Printing Service", message);
  sendDashboardUpdate();

  return {
    purgedJobs: Number(result.changes || 0),
    purgedRounds,
  };
}

function hasStaleQueuedRoundsForSystemDate(systemDate) {
  const normalizedSystemDate = normalizeSystemDate(systemDate);
  if (!normalizedSystemDate) {
    return false;
  }

  const jobs = db
    .prepare(
      `
        SELECT payload
        FROM print_jobs
        WHERE round_id IS NOT NULL
          AND status IN (?, ?)
      `,
    )
    .all(PRINT_JOB_STATUS.PENDING, PRINT_JOB_STATUS.PROCESSING);

  return jobs.some((job) => {
    const payload = safeJsonParse(job?.payload, {});
    const jobSystemDate = normalizeSystemDate(
      payload?.order?.system_date || payload?.round?.printed_date || null,
    );
    return jobSystemDate && jobSystemDate !== normalizedSystemDate;
  });
}

function syncRemotePrintState(data = {}) {
  if (!db) {
    return { success: false, message: "Database is not initialized" };
  }

  const settings = getSettingsRecord();
  const incomingDayToken = String(data?.dayToken || "").trim();
  const incomingSystemDate = String(data?.systemDate || "").trim() || null;

  if (!incomingDayToken && !incomingSystemDate) {
    return { success: true, changed: false, purgedJobs: 0, purgedRounds: 0 };
  }

  if (settings?.id) {
    db.prepare(
      `
        UPDATE settings
        SET remote_system_date = ?, remote_day_token = ?
        WHERE id = ?
      `,
    ).run(incomingSystemDate, incomingDayToken || null, settings.id);
  }

  const previousDayToken = String(settings?.remote_day_token || "").trim();
  const shouldPurgeOnInitialSync =
    !previousDayToken &&
    Boolean(incomingSystemDate) &&
    hasStaleQueuedRoundsForSystemDate(incomingSystemDate);

  if (
    !shouldPurgeOnInitialSync &&
    (!previousDayToken ||
      !incomingDayToken ||
      previousDayToken === incomingDayToken)
  ) {
    return { success: true, changed: false, purgedJobs: 0, purgedRounds: 0 };
  }

  const purgeResult = purgeQueuedRoundsForDayClose({
    systemDate: incomingSystemDate,
    dayToken: incomingDayToken,
  });

  return {
    success: true,
    changed: true,
    ...purgeResult,
  };
}

function recoverInterruptedPrintJobs() {
  if (!db) return;

  const now = nowIsoString();
  const result = db
    .prepare(
      `
      UPDATE print_jobs
      SET status = ?, locked_at = NULL, next_retry_at = COALESCE(next_retry_at, ?), updated_at = ?
      WHERE status = ?
    `,
    )
    .run(PRINT_JOB_STATUS.PENDING, now, now, PRINT_JOB_STATUS.PROCESSING);

  recoveredInterruptedJobsCount = Number(result?.changes || 0);
}

function insertPrintLog(entry = {}) {
  if (!db) return;

  db.prepare(
    `
      INSERT INTO print_logs (
        printer_id,
        printer_key,
        round_id,
        job_id,
        event_type,
        status,
        message,
        payload,
        duration_ms,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    entry.printer_id || null,
    entry.printer_key || "",
    entry.round_id || null,
    entry.job_id || null,
    entry.event_type || "job",
    entry.status || "info",
    entry.message || null,
    entry.payload ? truncatePayload(entry.payload) : null,
    entry.duration_ms || null,
    entry.created_at || nowIsoString(),
  );
}

function getQueueSummary() {
  const rows = db
    .prepare(
      `
        SELECT
          COUNT(*) AS total_jobs,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_jobs,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing_jobs,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_jobs,
          SUM(CASE WHEN status = 'pending' AND attempts > 0 THEN 1 ELSE 0 END) AS retry_jobs,
          MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending_at
        FROM print_jobs
      `,
    )
    .get();

  return {
    totalJobs: Number(rows?.total_jobs || 0),
    pendingJobs: Number(rows?.pending_jobs || 0),
    processingJobs: Number(rows?.processing_jobs || 0),
    completedJobs: Number(rows?.completed_jobs || 0),
    retryJobs: Number(rows?.retry_jobs || 0),
    oldestPendingAt: rows?.oldest_pending_at || null,
  };
}

function updateTrayStatus() {
  if (!tray || !db) return;

  const summary = getQueueSummary();
  const tooltip = [
    "Printing Service",
    `Pending: ${summary.pendingJobs}`,
    `Processing: ${summary.processingJobs}`,
    `Retrying: ${summary.retryJobs}`,
  ].join(" | ");

  tray.setToolTip(tooltip);
}

function maybeNotify(title, body) {
  if (!Notification?.isSupported?.()) return;

  const now = Date.now();
  if (now - lastDashboardNotificationAt < DASHBOARD_NOTIFICATION_THROTTLE_MS) {
    return;
  }

  lastDashboardNotificationAt = now;
  new Notification({
    title,
    body,
    silent: false,
  }).show();
}

function sendDashboardUpdate() {
  updateTrayStatus();
  mainWindow?.webContents.send("dashboard-updated");
}

function invalidateStartupChecksCache() {
  cachedStartupChecks = [];
  cachedStartupChecksAt = 0;
}

function mapPrinterForUi(printer) {
  return {
    ...printer,
    paused: Boolean(printer?.paused),
    supports_cut: Boolean(printer?.supports_cut),
    supports_beep: Boolean(printer?.supports_beep),
    supports_qr: Boolean(printer?.supports_qr),
    print_logo: Boolean(printer?.print_logo ?? 1),
    character_set: printer?.character_set || DEFAULT_PRINTER_CHARACTER_SET,
  };
}

function getRecentPrintLogs(limit = 30) {
  const rows = db
    .prepare(
      `
        SELECT *
        FROM print_logs
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT ?
      `,
    )
    .all(limit);

  return rows.map((row) => ({
    ...row,
    printer_name: getPrinterDisplayName(row.printer_key),
    created_at_label: formatTimestampForUi(row.created_at),
  }));
}

function getQueuedJobs(limit = 30) {
  const rows = db
    .prepare(
      `
        SELECT id, printer_id, round_id, printer_key, status, attempts, last_error, next_retry_at, created_at, test_mode
        FROM print_jobs
        WHERE status != ?
        ORDER BY
          CASE status WHEN 'processing' THEN 0 ELSE 1 END,
          COALESCE(datetime(next_retry_at), datetime(created_at)) ASC,
          id ASC
        LIMIT ?
      `,
    )
    .all(PRINT_JOB_STATUS.COMPLETED, limit);

  return rows.map((row) => ({
    ...row,
    printer_name: getPrinterDisplayName(row.printer_key),
    next_retry_at_label: formatTimestampForUi(row.next_retry_at),
    created_at_label: formatTimestampForUi(row.created_at),
    test_mode: Boolean(row.test_mode),
  }));
}

async function buildStartupChecks() {
  if (
    Date.now() - cachedStartupChecksAt < 30000 &&
    cachedStartupChecks.length
  ) {
    return cachedStartupChecks;
  }

  const settings = db.prepare("SELECT * FROM settings LIMIT 1").get();
  const configuredPrinters = db.prepare("SELECT * FROM printers").all();

  const checks = [
    {
      key: "database",
      label: "Local database",
      status: "ok",
      message: "SQLite queue database is available",
    },
    {
      key: "queue",
      label: "Queue recovery",
      status: recoveredInterruptedJobsCount > 0 ? "warning" : "ok",
      message:
        recoveredInterruptedJobsCount > 0
          ? `${recoveredInterruptedJobsCount} interrupted jobs were recovered on startup`
          : "No interrupted print jobs were found",
    },
    {
      key: "api-config",
      label: "API configuration",
      status: settings?.base_url ? "ok" : "warning",
      message: settings?.base_url
        ? `Connected to ${settings.base_url}`
        : "Server URL is not configured",
    },
    {
      key: "printers-config",
      label: "Configured printers",
      status: configuredPrinters.length ? "ok" : "warning",
      message: configuredPrinters.length
        ? `${configuredPrinters.length} printer(s) configured`
        : "No printers are configured yet",
    },
    {
      key: "system-printers",
      label: "System printers",
      status: lastKnownSystemPrinters.length ? "ok" : "warning",
      message: lastKnownSystemPrinters.length
        ? `${lastKnownSystemPrinters.length} printer(s) detected by Electron`
        : "System printers have not been detected yet",
    },
  ];

  if (configuredPrinters.length) {
    for (const printer of configuredPrinters.slice(0, 5)) {
      try {
        const payload = buildTestPrintPayload({
          printerId: printer.id,
          printer: printer.name,
          type: printer.type,
          interface: printer.interface,
          port: printer.port,
          ip: printer.ip,
          supportsCut: Boolean(printer.supports_cut),
          supportsBeep: Boolean(printer.supports_beep),
          supportsQr: Boolean(printer.supports_qr),
          printLogo: Boolean(printer.print_logo ?? 1),
          characterSet: printer.character_set,
        });
        const transport = resolvePrinterTransport(payload);
        let status = "ok";
        let message = `Ready via ${transport.uri}`;

        if (transport.shouldCheckConnection) {
          const checker = new ThermalPrinter({
            type: PrinterTypes[payload.type],
            characterSet: resolveCharacterSet(payload.characterSet),
            interface: transport.uri,
            removeSpecialCharacters: false,
            breakLine: BreakLine.WORD,
            options: { timeout: 4000 },
          });
          const isConnected = await withTimeout(
            checker.isPrinterConnected(),
            5000,
            "Startup printer check",
          );
          if (!isConnected) {
            status = "warning";
            message = `Printer is not responding via ${transport.uri}`;
          }
        }

        checks.push({
          key: `printer-${printer.id}`,
          label: printer.name,
          status: printer.paused ? "warning" : status,
          message: printer.paused ? "Printer is paused" : message,
        });
      } catch (error) {
        checks.push({
          key: `printer-${printer.id}`,
          label: printer.name,
          status: "danger",
          message: truncateErrorMessage(error),
        });
      }
    }
  }

  cachedStartupChecks = checks;
  cachedStartupChecksAt = Date.now();

  return checks;
}

async function getDashboardData() {
  const printers = db.prepare("SELECT * FROM printers ORDER BY id ASC").all();
  const summary = getQueueSummary();
  const printerSummaries = printers.map((printer) => {
    const printerKey = `printer:${printer.id}`;
    const queueRow = db
      .prepare(
        `
          SELECT
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_jobs,
            SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing_jobs,
            SUM(CASE WHEN status = 'pending' AND attempts > 0 THEN 1 ELSE 0 END) AS retry_jobs,
            MIN(CASE WHEN status = 'pending' THEN next_retry_at END) AS next_retry_at
          FROM print_jobs
          WHERE printer_key = ? AND status != ?
        `,
      )
      .get(printerKey, PRINT_JOB_STATUS.COMPLETED);

    const lastSuccess = db
      .prepare(
        `
          SELECT created_at, duration_ms, message
          FROM print_logs
          WHERE printer_key = ? AND status = 'success'
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT 1
        `,
      )
      .get(printerKey);

    const lastFailure = db
      .prepare(
        `
          SELECT created_at, message
          FROM print_logs
          WHERE printer_key = ? AND status = 'error'
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT 1
        `,
      )
      .get(printerKey);

    return {
      ...mapPrinterForUi(printer),
      queue: {
        pending: Number(queueRow?.pending_jobs || 0),
        processing: Number(queueRow?.processing_jobs || 0),
        retrying: Number(queueRow?.retry_jobs || 0),
        nextRetryAt: queueRow?.next_retry_at || null,
        nextRetryAtLabel: formatTimestampForUi(queueRow?.next_retry_at || null),
      },
      lastSuccessAt: lastSuccess?.created_at || null,
      lastSuccessAtLabel: formatTimestampForUi(lastSuccess?.created_at || null),
      lastSuccessDurationMs: lastSuccess?.duration_ms || null,
      lastErrorAt: lastFailure?.created_at || null,
      lastErrorAtLabel: formatTimestampForUi(lastFailure?.created_at || null),
      lastErrorMessage: lastFailure?.message || null,
    };
  });

  return {
    summary: {
      ...summary,
      oldestPendingAtLabel: formatTimestampForUi(summary.oldestPendingAt),
    },
    startupChecks: await buildStartupChecks(),
    printers: printerSummaries,
    queuedJobs: getQueuedJobs(),
    recentLogs: getRecentPrintLogs(),
  };
}

function clearPrintQueueTimer(printerKey) {
  const timer = printQueueTimers.get(printerKey);
  if (timer) {
    clearTimeout(timer);
    printQueueTimers.delete(printerKey);
  }
}

function schedulePrintQueue(printerKey, delay = 0) {
  if (!printerKey) return;

  clearPrintQueueTimer(printerKey);

  const timer = setTimeout(() => {
    printQueueTimers.delete(printerKey);
    processPrintQueue(printerKey).catch((error) => {
      console.error("Print queue processing failed:", error);
      schedulePrintQueue(printerKey, PRINT_QUEUE_BASE_DELAY_MS);
    });
  }, delay);

  printQueueTimers.set(printerKey, timer);
}

function scheduleAllPrintQueues() {
  if (!db) return;

  const printerKeys = db
    .prepare(
      `
        SELECT DISTINCT printer_key
        FROM print_jobs
        WHERE status IN (?, ?)
      `,
    )
    .all(PRINT_JOB_STATUS.PENDING, PRINT_JOB_STATUS.PROCESSING);

  printerKeys.forEach((row) => {
    if (row?.printer_key) {
      schedulePrintQueue(row.printer_key, 0);
    }
  });
}

function computeRetryDelayMs(attempts) {
  const normalizedAttempts = Math.max(1, Number(attempts) || 1);
  return Math.min(
    PRINT_QUEUE_BASE_DELAY_MS * Math.pow(2, normalizedAttempts - 1),
    PRINT_QUEUE_MAX_DELAY_MS,
  );
}

function truncateErrorMessage(error) {
  const message =
    error instanceof Error ? error.message : String(error || "Unknown error");
  return message.slice(0, 1000);
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

function resolvePrinterTransport(data = {}) {
  const interfaceType = String(data.interface || "").toUpperCase();

  if (data.ip) {
    const port = String(data.port || "").trim();
    return {
      uri: port ? `tcp://${data.ip}:${port}` : `tcp://${data.ip}`,
      shouldCheckConnection: true,
    };
  }

  if (interfaceType === "USB") {
    const sharedName = String(data.port || data.printer || "").trim();
    if (!sharedName) {
      throw new Error("Missing shared printer name");
    }

    const normalizedName = sharedName.replace(/^[/\\]+/, "");
    return {
      uri: `\\\\localhost\\${normalizedName}`,
      // UNC path existence checks are unreliable on some Windows setups.
      // For shared printers, treat execute() as the source of truth.
      shouldCheckConnection: false,
    };
  }

  const rawInterface = String(data.port || "").trim();
  if (!rawInterface) {
    throw new Error("Missing printer interface");
  }

  return {
    uri: rawInterface,
    shouldCheckConnection: true,
  };
}

function resolveCharacterSet(name) {
  if (!name) {
    return CharacterSet[DEFAULT_PRINTER_CHARACTER_SET];
  }

  return CharacterSet[name] || CharacterSet[DEFAULT_PRINTER_CHARACTER_SET];
}

function toPrintableString(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }

  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function sanitizeTableRows(rows = []) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows.map((row) => ({
    ...row,
    text: toPrintableString(row?.text, ""),
  }));
}

function getNestedValue(source, keyPath = []) {
  return keyPath.reduce(
    (current, key) =>
      current && typeof current === "object" ? current[key] : undefined,
    source,
  );
}

function getOptionalLogoSource(data = {}) {
  const candidatePaths = [["settings", "site_logo"]];

  for (const candidatePath of candidatePaths) {
    const value = getNestedValue(data, candidatePath);
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function addBackendPathIfNeeded(baseUrl, assetPath) {
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname.endsWith(".localhost")
    ) {
      return `${baseUrl}${assetPath}`;
    }
  } catch {
    if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) {
      return `${baseUrl}${assetPath}`;
    }
  }

  const cleanPath = assetPath.startsWith("/") ? assetPath : `/${assetPath}`;
  const insertPath = cleanPath.startsWith("/bkend/")
    ? cleanPath
    : `/bkend${cleanPath}`;
  return `${baseUrl}${insertPath}`;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPngBuffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

function tryDecodeInlinePngBuffer(source) {
  if (typeof source !== "string") {
    return null;
  }

  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.toLowerCase().startsWith(PNG_DATA_URL_PREFIX)) {
    return Buffer.from(trimmed.slice(PNG_DATA_URL_PREFIX.length), "base64");
  }

  if (trimmed.startsWith("iVBORw0KGgo")) {
    return Buffer.from(trimmed, "base64");
  }

  return null;
}

function resolveLocalLogoPath(source) {
  if (typeof source !== "string" || !source.trim()) {
    return null;
  }

  const trimmed = source.trim();
  const localCandidate = path.isAbsolute(trimmed)
    ? trimmed
    : path.resolve(__dirname, trimmed);

  return fs.existsSync(localCandidate) ? localCandidate : null;
}

function resolveRemoteLogoUrl(source) {
  if (typeof source !== "string" || !source.trim()) {
    return null;
  }

  const trimmed = source.trim();
  if (isHttpUrl(trimmed)) {
    return trimmed;
  }

  const baseUrl = getSettingsRecord()?.base_url;
  if (!baseUrl) {
    return null;
  }

  const normalizedPath = trimmed.replace(/^[/\\]+/, "");

  if (
    normalizedPath &&
    !normalizedPath.startsWith("uploads/") &&
    !normalizedPath.includes("://")
  ) {
    return addBackendPathIfNeeded(baseUrl, `/uploads/${normalizedPath}`);
  }

  try {
    if (normalizedPath.startsWith("uploads/")) {
      return addBackendPathIfNeeded(baseUrl, `/${normalizedPath}`);
    }

    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

async function loadLogoPngBuffer(data = {}) {
  const source = getOptionalLogoSource(data);
  if (!source) {
    return null;
  }

  const inlineBuffer = tryDecodeInlinePngBuffer(source);
  if (inlineBuffer) {
    if (!isPngBuffer(inlineBuffer)) {
      throw new Error("Inline logo is not a valid PNG image");
    }
    return inlineBuffer;
  }

  const localPath = resolveLocalLogoPath(source);
  if (localPath) {
    const fileBuffer = fs.readFileSync(localPath);
    if (!isPngBuffer(fileBuffer)) {
      throw new Error("Local logo must be a PNG image");
    }
    return fileBuffer;
  }

  const remoteUrl = resolveRemoteLogoUrl(source);
  if (!remoteUrl) {
    throw new Error("Logo source could not be resolved");
  }

  if (typeof globalThis.fetch !== "function") {
    throw new Error("Remote logo loading is not available in this runtime");
  }

  const response = await globalThis.fetch(remoteUrl);
  if (!response.ok) {
    throw new Error(`Logo download failed with status ${response.status}`);
  }

  const remoteBuffer = Buffer.from(await response.arrayBuffer());
  if (!isPngBuffer(remoteBuffer)) {
    throw new Error("Remote logo must be a PNG image");
  }

  return remoteBuffer;
}

async function printOptionalCompanyLogo(printer, data = {}) {
  const logoBuffer = await loadLogoPngBuffer(data);
  if (!logoBuffer) {
    return false;
  }

  let preparedBuffer = logoBuffer;
  try {
    const logoImage = nativeImage.createFromBuffer(logoBuffer);
    if (!logoImage.isEmpty()) {
      const { width, height } = logoImage.getSize();
      const scale = Math.min(
        LOGO_MAX_WIDTH_PX / Math.max(width, 1),
        LOGO_MAX_HEIGHT_PX / Math.max(height, 1),
        1,
      );

      if (scale < 1) {
        preparedBuffer = logoImage
          .resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
          })
          .toPNG();
      }
    }
  } catch (error) {
    console.warn("Failed to resize company logo:", error?.message || error);
  }

  printer.alignCenter();
  await printer.printImageBuffer(preparedBuffer);
  printer.newLine();
  return true;
}

function buildTestPrintPayload(data = {}) {
  return {
    ...data,
    round: {
      id: null,
      category: "TEST",
      round_no: "TEST",
      destination: "SERVICE",
      origin: "SERVICE",
    },
    order: {
      id: "TEST",
      client: "Printer Test",
      waiter: os.userInfo().username,
      table_name: "N/A",
      system_date: new Date().toISOString(),
      order_time: new Date().toISOString(),
      grand_total: 0,
      total_taxes: 0,
    },
    items: [
      {
        name: "Printer connection check",
        quantity: 1,
        price: 0,
        amount: 0,
      },
    ],
    settings: {
      site_name: "Printing Service",
      app_tin: "TEST",
      app_phone: os.hostname(),
      app_email: "local@test",
      site_address: "Local diagnostic ticket",
      momo_code: "",
      ...(data.settings || {}),
    },
    testMode: true,
  };
}

function enqueuePrintJob(data = {}) {
  if (!db) {
    throw new Error("Database is not initialized");
  }

  const roundId = Number(data?.round?.id) || null;
  const printerId = Number(data?.printerId) || null;
  const printerKey = buildPrinterKey(data);
  const now = nowIsoString();
  const payload = JSON.stringify({
    ...data,
    printerKey,
    clientToken: data?.clientToken || buildClientToken(data),
  });

  if (roundId) {
    const completedJob = db
      .prepare(
        `
          SELECT id
          FROM print_jobs
          WHERE round_id = ? AND printer_key = ? AND status = ?
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(roundId, printerKey, PRINT_JOB_STATUS.COMPLETED);

    if (completedJob) {
      setTimeout(() => {
        mainWindow?.webContents.send("printedContent", buildPrintedMeta(data));
      }, 0);

      return {
        success: true,
        queued: false,
        deduplicated: true,
        jobId: completedJob.id,
      };
    }

    const existingJob = db
      .prepare(
        `
          SELECT id
          FROM print_jobs
          WHERE round_id = ? AND printer_key = ? AND status IN (?, ?)
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(
        roundId,
        printerKey,
        PRINT_JOB_STATUS.PENDING,
        PRINT_JOB_STATUS.PROCESSING,
      );

    if (existingJob) {
      db.prepare(
        `
          UPDATE print_jobs
          SET payload = ?, updated_at = ?
          WHERE id = ?
        `,
      ).run(payload, now, existingJob.id);

      schedulePrintQueue(printerKey, 0);

      return { success: true, queued: false, jobId: existingJob.id };
    }
  }

  const result = db
    .prepare(
      `
        INSERT INTO print_jobs (
          printer_id,
          round_id,
          printer_key,
          payload,
          status,
          attempts,
          test_mode,
          next_retry_at,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `,
    )
    .run(
      printerId,
      roundId,
      printerKey,
      payload,
      PRINT_JOB_STATUS.PENDING,
      boolToInt(data?.testMode, 0),
      now,
      now,
      now,
    );

  insertPrintLog({
    printer_id: printerId,
    printer_key: printerKey,
    round_id: roundId,
    job_id: result.lastInsertRowid,
    event_type: data?.testMode ? "test-print" : "queued",
    status: "queued",
    message: data?.testMode
      ? "Test print queued"
      : `Queued round ${roundId || "manual"} for printing`,
    payload,
  });

  schedulePrintQueue(printerKey, 0);
  sendDashboardUpdate();

  return {
    success: true,
    queued: true,
    jobId: result.lastInsertRowid,
  };
}

function getNextQueuedPrintJob(printerKey, includeFuture = false) {
  if (!db) return null;

  const dueFilter = includeFuture
    ? ""
    : "AND (next_retry_at IS NULL OR next_retry_at <= ?)";
  const params = includeFuture
    ? [PRINT_JOB_STATUS.PENDING, printerKey]
    : [PRINT_JOB_STATUS.PENDING, printerKey, nowIsoString()];

  return db
    .prepare(
      `
        SELECT *
        FROM print_jobs
        WHERE status = ?
          AND printer_key = ?
          ${dueFilter}
        ORDER BY COALESCE(datetime(next_retry_at), datetime(created_at)) ASC, id ASC
        LIMIT 1
      `,
    )
    .get(...params);
}

function markPrintJobProcessing(jobId) {
  const now = nowIsoString();
  db.prepare(
    `
      UPDATE print_jobs
      SET status = ?, locked_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ?
    `,
  ).run(PRINT_JOB_STATUS.PROCESSING, now, now, now, jobId);
}

function markPrintJobCompleted(jobId, durationMs = null) {
  const now = nowIsoString();
  db.prepare(
    `
      UPDATE print_jobs
      SET status = ?, locked_at = NULL, completed_at = ?, duration_ms = ?, updated_at = ?, next_retry_at = NULL
      WHERE id = ?
    `,
  ).run(PRINT_JOB_STATUS.COMPLETED, now, durationMs, now, jobId);
}

function markPrintJobForRetry(job, error) {
  const now = nowIsoString();
  const attempts = Number(job?.attempts || 0) + 1;
  const retryDelayMs = computeRetryDelayMs(attempts);
  const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
  const message = truncateErrorMessage(error);

  db.prepare(
    `
      UPDATE print_jobs
      SET status = ?, attempts = ?, last_error = ?, locked_at = NULL, next_retry_at = ?, updated_at = ?
      WHERE id = ?
    `,
  ).run(PRINT_JOB_STATUS.PENDING, attempts, message, retryAt, now, job.id);

  if (attempts === 1 || attempts % 5 === 0) {
    const printerName = getPrinterDisplayName(job?.printer_key);
    mainWindow?.webContents.send("print-error", {
      message: `Print failed. Retrying in ${Math.round(retryDelayMs / 1000)}s.`,
      error: message,
      attempts,
      roundId: job?.round_id || null,
      printerName,
    });

    maybeNotify("Printing Service", `${printerName}: ${message}`);
  }

  return retryDelayMs;
}

function getRetryDelayUntil(nextRetryAt) {
  if (!nextRetryAt) return 0;
  const nextTimestamp = new Date(nextRetryAt).getTime();
  if (Number.isNaN(nextTimestamp)) return 0;
  return Math.max(0, nextTimestamp - Date.now());
}

async function processPrintQueue(printerKey) {
  if (!db || !printerKey || activePrinterProcessors.has(printerKey)) return;

  const printer = getPrinterRecordByKey(printerKey);
  if (printer?.paused) {
    return;
  }

  const job = getNextQueuedPrintJob(printerKey);
  if (!job) {
    const futureJob = getNextQueuedPrintJob(printerKey, true);
    if (futureJob) {
      schedulePrintQueue(
        printerKey,
        getRetryDelayUntil(futureJob.next_retry_at),
      );
    }
    return;
  }

  activePrinterProcessors.add(printerKey);
  markPrintJobProcessing(job.id);
  insertPrintLog({
    printer_id: job.printer_id,
    printer_key: printerKey,
    round_id: job.round_id,
    job_id: job.id,
    event_type: "processing",
    status: "processing",
    message: `Processing job ${job.id}`,
  });
  sendDashboardUpdate();

  try {
    const payload = JSON.parse(job.payload);
    const startedAt = Date.now();
    await performPrintJob(payload);
    const durationMs = Date.now() - startedAt;
    const remainingJob = db
      .prepare("SELECT id FROM print_jobs WHERE id = ?")
      .get(job.id);
    const wasPurgedByDayClose =
      !remainingJob ||
      (job?.round_id && suppressedRoundIds.has(Number(job.round_id)));

    if (wasPurgedByDayClose) {
      insertPrintLog({
        printer_id: job.printer_id,
        printer_key: printerKey,
        round_id: job.round_id,
        job_id: job.id,
        event_type: "discarded",
        status: "warning",
        message: `Discarded completed print for round ${job.round_id || "manual"} after day close`,
        duration_ms: durationMs,
      });
      sendDashboardUpdate();
      schedulePrintQueue(printerKey, 0);
      return;
    }

    markPrintJobCompleted(job.id, durationMs);
    mainWindow?.webContents.send(
      "printedContent",
      buildPrintedMeta({
        ...payload,
        printerId: job.printer_id || payload?.printerId,
        printerKey,
        printAttempts: Number(job?.attempts || 0) + 1,
        clientToken: payload?.clientToken || buildClientToken(payload),
      }),
    );
    insertPrintLog({
      printer_id: job.printer_id,
      printer_key: printerKey,
      round_id: job.round_id,
      job_id: job.id,
      event_type: payload?.testMode ? "test-print" : "completed",
      status: "success",
      message: payload?.testMode
        ? "Test print completed successfully"
        : `Printed round ${job.round_id || "manual"} successfully`,
      payload,
      duration_ms: durationMs,
    });
    sendDashboardUpdate();
    schedulePrintQueue(printerKey, 0);
  } catch (error) {
    console.error("Print job failed:", error);
    const retryDelayMs = markPrintJobForRetry(job, error);
    insertPrintLog({
      printer_id: job.printer_id,
      printer_key: printerKey,
      round_id: job.round_id,
      job_id: job.id,
      event_type: "failed",
      status: "error",
      message: truncateErrorMessage(error),
    });
    sendDashboardUpdate();
    schedulePrintQueue(printerKey, retryDelayMs);
  } finally {
    activePrinterProcessors.delete(printerKey);
  }
}

async function performPrintJob(data) {
  const transport = resolvePrinterTransport(data);
  const supportsCut = data?.supportsCut !== false;
  const supportsBeep = data?.supportsBeep !== false;
  const supportsQr = data?.supportsQr !== false;
  const shouldPrintLogo = data?.printLogo !== false;
  const roundCategory = toPrintableString(data?.round?.category).toUpperCase();
  const order = data?.order || {};
  const settings = data?.settings || {};
  const items = Array.isArray(data?.items) ? data.items : [];
  const options = {
    type: PrinterTypes[data.type],
    characterSet: resolveCharacterSet(data?.characterSet),
    removeSpecialCharacters: false,
    breakLine: BreakLine.WORD,
    options: {
      timeout: 10000,
    },
    interface: transport.uri,
  };

  const printer = new ThermalPrinter(options);
  if (transport.shouldCheckConnection) {
    const isConnected = await withTimeout(
      printer.isPrinterConnected(),
      PRINT_EXECUTION_TIMEOUT_MS,
      "Printer connection check",
    );

    if (!isConnected) {
      throw new Error(`Printer is not connected (${transport.uri})`);
    }
  }

  const print = (text, fallback = "") =>
    printer.print(toPrintableString(text, fallback));
  const println = (text, fallback = "") =>
    printer.println(toPrintableString(text, fallback));
  const tableCustom = (rows) => printer.tableCustom(sanitizeTableRows(rows));

  printer.alignCenter();
  printer.setTypeFontA();
  if (
    shouldPrintLogo &&
    (roundCategory === "ORDER" || roundCategory === "INVOICE")
  ) {
    try {
      await withTimeout(
        printOptionalCompanyLogo(printer, data),
        5000,
        "Company logo loading",
      );
    } catch (error) {
      console.warn("Skipping company logo:", error?.message || error);
      printer.alignCenter();
    }
  }
  printer.setTextDoubleHeight();
  printer.setTextDoubleWidth();
  println(settings?.site_name);
  printer.setTextNormal();
  println(`TIN: ${toPrintableString(settings?.app_tin)}`);
  println(`Tel: ${toPrintableString(settings?.app_phone)}`);
  println(`Email: ${toPrintableString(settings?.app_email)}`);
  println(`Address: ${toPrintableString(settings?.site_address)}`);
  printer.drawLine();
  printer.alignLeft();

  const isReceipt =
    Boolean(order?.ebm_meta) || data?.round?.origin === "RETAIL";
  if (data?.testMode || roundCategory === "TEST") {
    println("TEST PRINT");
    println(`Printer: ${toPrintableString(data?.printer, "Unknown")}`);
    println(`Interface: ${transport.uri}`);
    println(`Printed At: ${new Date().toLocaleString("en-US")}`);
  } else if (roundCategory === "ORDER") {
    println(
      `Order #: ${helper.generateVoucherNo(data?.round?.round_no)}(${toPrintableString(
        data?.round?.destination,
      )})`,
    );
  } else if (roundCategory === "INVOICE") {
    println(
      `${isReceipt ? "RECEIPT" : "INVOICE"} #: ${helper.generateVoucherNo(
        order?.id,
      )}`,
    );
  } else {
    println(
      `\x1B\x45\x01Round Slip #\x1B\x45\x00: ${helper.generateVoucherNo(
        data?.round?.round_no,
      )}`,
    );
  }
  println(`Customer: ${toPrintableString(order?.client, "Walk-In")}`);
  if (!isReceipt) {
    tableCustom([
      {
        text: `Served By: ${toPrintableString(order?.waiter)}`,
        align: "LEFT",
      },
      {
        text: `Table No: ${toPrintableString(order?.table_name)}`,
        align: "RIGHT",
      },
    ]);
  }

  tableCustom([
    {
      text: `Date: ${helper.formatDate(order?.system_date)}`,
      align: "LEFT",
    },
    {
      text: `Time: ${toPrintableString(order?.order_time)}`,
      align: "RIGHT",
    },
  ]);

  printer.drawLine();

  tableCustom([
    { text: "Item", align: "LEFT", width: 0.5, bold: true },
    { text: "Qty", align: "CENTER", width: 0.1, bold: true },
    { text: "Price", align: "CENTER", width: 0.18, bold: true },
    { text: "Total", align: "RIGHT", width: 0.22, bold: true },
  ]);

  printer.drawLine();

  items.forEach((item = {}) => {
    tableCustom([
      { text: item?.name, align: "LEFT", width: 0.5 },
      { text: item?.quantity, align: "CENTER", width: 0.1 },
      {
        text: helper.formatMoney(item?.price),
        align: "CENTER",
        width: 0.18,
      },
      {
        text: helper.formatMoney(item?.amount),
        align: "RIGHT",
        width: 0.22,
      },
    ]);
    if (toPrintableString(item?.comment).trim()) {
      if (roundCategory === "ORDER") {
        printer.setTextNormal();
        printer.setTypeFontA();
      } else {
        printer.setTypeFontB();
      }
      printer.bold(true);
      tableCustom([
        {
          text: `Notes: ${toPrintableString(item?.comment)}`,
          align: "LEFT",
          width: 1,
        },
      ]);
      printer.bold(false);
      printer.setTextNormal();
      printer.setTypeFontA();
    }
  });

  printer.drawLine();

  if (roundCategory === "INVOICE") {
    if (order?.ebm_meta) {
      const totals = [
        ["Total Rwf", `${order?.grand_total}`],
        ["Total A-EX Rwf", `0.00`],
        ["Total B-18% Rwf", `${order?.total_taxes}`],
        ["Total D", `0.00`],
        ["Total Tax Rwf", `${order?.total_taxes}`],
      ];

      totals.forEach((item) => {
        tableCustom([
          { text: item[0], align: "LEFT" },
          { text: item[1], align: "RIGHT" },
        ]);
      });

      printer.drawLine();
      const invoiceMeta = order?.ebm_meta;
      printer.newLine();
      printer.bold(true);
      print("SDC INFORMATION");
      printer.bold(false);
      printer.newLine();
      printer.setTextNormal();
      printer.drawLine();
      println(`Date: ${helper.formateEbmDate(invoiceMeta.vsdcRcptPbctDate)}`);
      println(`SDC ID: ${toPrintableString(invoiceMeta.sdcId)}`);
      println(`Internal Data: ${toPrintableString(invoiceMeta.intrlData)}`);
      println(`Receipt Signature: ${toPrintableString(invoiceMeta.rcptSign)}`);
      println(`MRC: ${toPrintableString(invoiceMeta.mrcNo)}`);
      printer.newLine();
      if (supportsQr && toPrintableString(invoiceMeta.rcptSign).trim()) {
        printer.alignCenter();
        printer.printQR(
          `https://myrra.rra.gov.rw/common/link/ebm/receipt/indexEbmReceiptData?Data=${invoiceMeta.rcptSign}`,
          {
            cellSize: 3,
            correction: "Q",
          },
        );
      } else {
        println(`QR: ${toPrintableString(invoiceMeta.rcptSign)}`);
      }
      println(`Powered by EBM v2.1`);
    } else {
      printer.alignRight();
      printer.setTextDoubleWidth();
      println(`Total: ${helper.formatMoney(order?.grand_total)}`);
      printer.setTextNormal();
      printer.drawLine();
      printer.alignCenter();
      print(`Dial `);
      printer.bold(true);
      printer.setTextQuadArea();
      printer.setTypeFontB();
      print(settings?.momo_code);
      printer.bold(false);
      printer.setTextNormal();
      printer.setTypeFontA();
      print(` to pay with MOMO`);
      printer.newLine();
      println(`This is not a legal receipt. Please ask your legal receipt.`);
      println(`Thank you!`);
    }
  } else if (roundCategory === "ROUND_SLIP") {
    const total = items.reduce((a, b) => a + Number(b?.amount || 0), 0);
    printer.alignRight();
    printer.setTextDoubleWidth();
    println(`Total: ${helper.formatMoney(total)}`);
    printer.setTextNormal();
    printer.drawLine();
    printer.alignCenter();
    println(
      "This is neither a legal receipt or final invoice. It is just a round total slip.",
    );
  }

  if (supportsCut) {
    printer.cut();
  }

  if (supportsBeep) {
    printer.beep();
  }

  await withTimeout(
    printer.execute(),
    PRINT_EXECUTION_TIMEOUT_MS,
    "Printer execution",
  );
}

let mainWindow;
let tray = null;
let isQuiting = false;

app.setName("Printing Service");
app.setAppUserModelId("com.tame.printingservice");

function getIconPath() {
  if (process.platform === "win32") {
    return path.join(__dirname, "assets", "app-icon", "win", "icon.ico");
  }
  if (process.platform === "darwin") {
    return path.join(__dirname, "assets", "app-icon", "mac", "icon.icns");
  }
  return path.join(__dirname, "assets", "app-icon", "png", "512x512.png");
}

app.setLoginItemSettings(
  {
    openAtLogin: true,
    openAsHidden: true,
    name: "Printing Service",
    path: process.execPath,
    args: ["--hidden"],
  },
  "user",
);

function createMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Settings",
          accelerator: "CmdOrCtrl+,",
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send("open-settings");
            }
          },
        },
        { type: "separator" },
        {
          label: "Exit",
          accelerator: process.platform === "darwin" ? "Cmd+Q" : "Ctrl+Q",
          click: () => {
            app.quit();
          },
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "close" }],
    },
  ];

  if (process.platform === "darwin") {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createTray() {
  const iconPath =
    process.platform === "win32"
      ? path.join(__dirname, "assets", "app-icon", "win", "icon.ico")
      : path.join(__dirname, "assets", "app-icon", "png", "32x32.png");
  const trayIcon = nativeImage.createFromPath(iconPath);

  if (process.platform === "darwin") {
    trayIcon.setTemplateImage(true);
  } else {
    const resizedIcon = trayIcon.resize({ width: 16, height: 16 });
    tray = new Tray(resizedIcon);
  }

  if (process.platform === "darwin") {
    tray = new Tray(trayIcon);
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Printing Service",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: "Hide Printing Service",
      click: () => {
        if (mainWindow) {
          mainWindow.hide();
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuiting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip("Printing Service - Click to show/hide");

  tray.on("click", () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

const helper = {
  timeZone: "Africa/Kigali",
  formatNumber: (number) => {
    if (!number || isNaN(number)) {
      return "0";
    }
    let str = String(number);
    const decimalIndex = str.indexOf(".");
    const decimalPlaces = 3;
    if (decimalIndex !== -1) {
      const limitedDecimal = str.substr(decimalIndex + 1, decimalPlaces);
      str = str.substr(0, decimalIndex + 1) + limitedDecimal;
    }
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  },

  empty(mixedVar) {
    if (mixedVar === null || mixedVar === undefined) return true;
    if (typeof mixedVar === "string" && mixedVar.trim() === "") return true;
    if (typeof mixedVar === "number" && isNaN(mixedVar)) return true;
    if (Array.isArray(mixedVar) && mixedVar.length === 0) return true;
    if (typeof mixedVar === "object" && Object.keys(mixedVar).length === 0)
      return true;
    return false;
  },

  formatDate(str) {
    try {
      if (!str) return "N/A";
      let today = new Date(str);
      if (isNaN(today.getTime())) return "Invalid Date";
      return today.toLocaleDateString("en-GB");
    } catch (error) {
      console.error("Date formatting error:", error);
      return "Invalid Date";
    }
  },

  formatTime(str) {
    try {
      if (!str) return "N/A";
      const date = new Date(str);
      if (isNaN(date.getTime())) return "Invalid Time";
      return date.toLocaleTimeString("en-US", {
        timeZone: this.timeZone,
      });
    } catch (error) {
      console.error("Time formatting error:", error);
      return "Invalid Time";
    }
  },

  formatOrderTime(str) {
    try {
      if (!str) return "N/A";
      const date = new Date(str);
      if (isNaN(date.getTime())) return "Invalid Time";
      return date
        .toTimeString("en-US", { timeZone: this.timeZone })
        .slice(0, 5);
    } catch (error) {
      console.error("Order time formatting error:", error);
      return "Invalid Time";
    }
  },

  generateVoucherNo(no) {
    if (!no) return "0000";
    const stringNo = String(no);
    let len = stringNo.length;
    if (len >= 4) return stringNo;
    if (len == 1) return `000${no}`;
    if (len == 2) return `00${no}`;
    if (len == 3) return `0${no}`;
    return stringNo;
  },

  padNumber(number, targetedLength = 5) {
    if (!number || isNaN(number)) return "0".repeat(targetedLength);
    let strNumber = String(number);
    if (strNumber.length < targetedLength) {
      let padding = "0".repeat(targetedLength - strNumber.length);
      return padding + strNumber;
    }
    return strNumber;
  },

  formatMoney(num) {
    if (!num || isNaN(num)) return "0";
    return `${this.formatNumber(num)}`;
  },

  generateFormData(obj) {
    try {
      const formData = new FormData();
      for (let key in obj) {
        if (obj[key] !== null && typeof obj[key] !== "undefined") {
          if (typeof obj[key] === "object")
            formData.append(key, JSON.stringify(obj[key]));
          else formData.append(key, obj[key]);
        }
      }
      return formData;
    } catch (error) {
      console.error("Form data generation error:", error);
      return new FormData();
    }
  },

  formateEbmDate(timestamp) {
    try {
      if (
        !timestamp ||
        typeof timestamp !== "string" ||
        timestamp.length < 14
      ) {
        return "Invalid Date";
      }
      const year = timestamp.substring(0, 4);
      const month = timestamp.substring(4, 6);
      const day = timestamp.substring(6, 8);
      const hour = timestamp.substring(8, 10);
      const minute = timestamp.substring(10, 12);
      const second = timestamp.substring(12, 14);
      const formattedDate = `${day}/${month}/${year} ${hour}:${minute}:${second}`;
      return formattedDate;
    } catch (error) {
      console.error("EBM date formatting error:", error);
      return "Invalid Date";
    }
  },
};

function createWindow() {
  const iconPath = getIconPath();

  mainWindow = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 560,
    minHeight: 420,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      enableBlinkFeatures: "",
      disableBlinkFeatures: "",
    },
    icon: iconPath,
    show: false,
    titleBarStyle: "default",
    frame: true,
    resizable: true,
    maximizable: true,
    minimizable: true,
    closable: true,
    center: true,
  });

  // Reinforce runtime window icon where supported.
  if (process.platform === "win32" || process.platform === "linux") {
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      mainWindow.setIcon(icon);
    }
  }

  mainWindow.setTitle(`Printing Service v${app.getVersion()}`);

  mainWindow.loadFile("index.html");

  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self' 'unsafe-inline' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss: https: http:;",
          ],
        },
      });
    },
  );

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on("close", (event) => {
    if (!isQuiting) {
      event.preventDefault();
      mainWindow.hide();
      return false;
    }
    return true;
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.on("maximize", () => {
    mainWindow.webContents.send("window-maximized");
  });

  mainWindow.on("unmaximize", () => {
    mainWindow.webContents.send("window-unmaximized");
  });

  mainWindow.webContents.on("did-finish-load", async () => {
    try {
      const printers = await mainWindow.webContents.getPrintersAsync();
      lastKnownSystemPrinters = printers;
      invalidateStartupChecksCache();
      mainWindow.webContents.send("printersList", printers);
      sendDashboardUpdate();
    } catch (error) {
      console.error("Failed to get printers:", error);
      mainWindow.webContents.send("printers-error", {
        message: "Failed to get system printers",
      });
    }
  });

  mainWindow.on("unresponsive", () => {
    console.log("Window became unresponsive");
  });

  mainWindow.on("responsive", () => {
    console.log("Window became responsive again");
  });
}

app.on("ready", () => {
  try {
    const iconPath = getIconPath();
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) {
      app.dock?.setIcon?.(icon);
    }

    initializeDatabase();
    createWindow();
    createMenu();
    createTray();

    const shouldShowWindow = !process.argv.includes("--hidden");

    if (!shouldShowWindow) {
      mainWindow.hide();
    }
  } catch (error) {
    console.error("Error during app initialization:", error);
    app.quit();
  }
});

app.on("window-all-closed", function () {
  // Don't quit when all windows are closed - keep running in tray
  // Only quit if explicitly requested
  if (isQuiting) {
    app.quit();
  }
});

app.on("activate", function () {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", async (event) => {
  if (!isQuiting) {
    event.preventDefault();
    isQuiting = true;
    app.quit();
    return;
  }

  try {
    Array.from(printQueueTimers.keys()).forEach((printerKey) => {
      clearPrintQueueTimer(printerKey);
    });

    if (db) {
      db.close();
      console.log("Database connection closed");
    }
  } catch (error) {
    console.error("Error closing database:", error);
  }
});

// Handle app events - moved to single instance lock section

// Prevent multiple instances - improved for Electron 38.x
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  // Handle second instance
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// IPC Handlers

// Updated IPC handler for Electron 38.x
ipcMain.on("authenticated", async (event) => {
  try {
    const settings = db.prepare("SELECT * FROM settings LIMIT 1").get();
    const printers = db.prepare("SELECT * FROM printers").all();
    event.sender.send("availableSettings", { settings, printers }); // settings now always includes outlet_code
    scheduleAllPrintQueues();
    sendDashboardUpdate();
  } catch (error) {
    console.error("Authentication error:", error);
    event.sender.send("auth-error", { message: "Failed to load settings" });
  }
});

ipcMain.handle("get-settings", async (event) => {
  try {
    const settings = db.prepare("SELECT * FROM settings LIMIT 1").get();
    const printers = db.prepare("SELECT * FROM printers").all();
    return { success: true, settings, printers }; // settings includes outlet_code
  } catch (error) {
    console.error("Get settings error:", error);
    return { success: false, message: "Failed to load settings" };
  }
});

ipcMain.handle("get-system-info", async (event) => {
  try {
    const os = require("os");
    const systemInfo = {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      electronVersion: process.versions.electron,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cpuCount: os.cpus().length,
      hostname: os.hostname(),
      uptime: os.uptime(),
      userInfo: os.userInfo(),
    };

    const recommendations = [];

    // Add recommendations based on system info
    if (systemInfo.totalMemory < 4 * 1024 * 1024 * 1024) {
      // Less than 4GB
      recommendations.push(
        "Consider upgrading to at least 4GB RAM for better performance",
      );
    }

    if (systemInfo.cpuCount < 2) {
      recommendations.push("Consider using a system with at least 2 CPU cores");
    }

    if (systemInfo.freeMemory < 1024 * 1024 * 1024) {
      // Less than 1GB free
      recommendations.push(
        "Low available memory. Consider closing other applications",
      );
    }

    return {
      success: true,
      systemInfo,
      recommendations,
    };
  } catch (error) {
    console.error("Get system info error:", error);
    return {
      success: false,
      message: "Failed to load system information",
      systemInfo: null,
      recommendations: [],
    };
  }
});

ipcMain.handle("print-content", async (event, data) => {
  try {
    if (!data?.round?.id) {
      throw new Error("Missing round id for print job");
    }

    return enqueuePrintJob(data);
  } catch (error) {
    console.error("Failed to queue print job:", error);
    mainWindow?.webContents.send("print-error", {
      message: error.message || "Failed to queue print job",
    });
    throw error;
  }
});

ipcMain.handle("get-dashboard-data", async () => {
  try {
    return {
      success: true,
      dashboard: await getDashboardData(),
    };
  } catch (error) {
    console.error("Get dashboard data error:", error);
    return {
      success: false,
      message: "Failed to load dashboard data",
    };
  }
});

ipcMain.handle("sync-remote-print-state", async (event, data) => {
  try {
    return syncRemotePrintState(data);
  } catch (error) {
    console.error("Sync remote print state error:", error);
    return {
      success: false,
      message: error.message || "Failed to synchronize remote print state",
    };
  }
});

ipcMain.handle("toggle-printer-pause", async (event, data) => {
  try {
    const printerId = Number(data?.printerId);
    if (!printerId) {
      throw new Error("Printer id is required");
    }

    const paused = boolToInt(Boolean(data?.paused), 0);
    db.prepare("UPDATE printers SET paused = ? WHERE id = ?").run(
      paused,
      printerId,
    );
    invalidateStartupChecksCache();

    const printer = getPrinterRecordById(printerId);
    if (!printer) {
      throw new Error("Printer not found");
    }

    if (!paused) {
      schedulePrintQueue(`printer:${printerId}`, 0);
    }

    insertPrintLog({
      printer_id: printerId,
      printer_key: `printer:${printerId}`,
      event_type: "pause-toggle",
      status: paused ? "warning" : "success",
      message: paused
        ? `${printer.name} was paused`
        : `${printer.name} resumed`,
    });

    sendDashboardUpdate();

    return { success: true, printer: mapPrinterForUi(printer) };
  } catch (error) {
    console.error("Toggle printer pause error:", error);
    return {
      success: false,
      message: error.message || "Failed to update printer pause state",
    };
  }
});

ipcMain.handle("retry-print-job", async (event, jobId) => {
  try {
    const id = Number(jobId);
    if (!id) {
      throw new Error("Job id is required");
    }

    const job = db.prepare("SELECT * FROM print_jobs WHERE id = ?").get(id);
    if (!job) {
      throw new Error("Print job not found");
    }
    if (job.status === PRINT_JOB_STATUS.PROCESSING) {
      throw new Error("This print job is already processing");
    }

    const now = nowIsoString();
    db.prepare(
      `
        UPDATE print_jobs
        SET status = ?, next_retry_at = ?, updated_at = ?, locked_at = NULL
        WHERE id = ?
      `,
    ).run(PRINT_JOB_STATUS.PENDING, now, now, id);

    insertPrintLog({
      printer_id: job.printer_id,
      printer_key: job.printer_key,
      round_id: job.round_id,
      job_id: job.id,
      event_type: "manual-retry",
      status: "info",
      message: `Manual retry requested for job ${job.id}`,
    });

    schedulePrintQueue(job.printer_key, 0);
    sendDashboardUpdate();

    return { success: true };
  } catch (error) {
    console.error("Retry print job error:", error);
    return {
      success: false,
      message: error.message || "Failed to retry print job",
    };
  }
});

ipcMain.handle("clear-print-job", async (event, jobId) => {
  try {
    const id = Number(jobId);
    if (!id) {
      throw new Error("Job id is required");
    }

    const job = db.prepare("SELECT * FROM print_jobs WHERE id = ?").get(id);
    if (!job) {
      throw new Error("Print job not found");
    }
    if (job.status === PRINT_JOB_STATUS.PROCESSING) {
      throw new Error(
        "Wait for the current print attempt to finish before clearing this job",
      );
    }

    db.prepare("DELETE FROM print_jobs WHERE id = ?").run(id);

    insertPrintLog({
      printer_id: job.printer_id,
      printer_key: job.printer_key,
      round_id: job.round_id,
      job_id: job.id,
      event_type: "manual-clear",
      status: "warning",
      message: `Job ${job.id} was cleared manually`,
    });

    schedulePrintQueue(job.printer_key, 0);
    sendDashboardUpdate();

    return { success: true };
  } catch (error) {
    console.error("Clear print job error:", error);
    return {
      success: false,
      message: error.message || "Failed to clear print job",
    };
  }
});

ipcMain.handle("run-test-print", async (event, printerId) => {
  try {
    const id = Number(printerId);
    if (!id) {
      throw new Error("Printer id is required");
    }

    const printer = getPrinterRecordById(id);
    if (!printer) {
      throw new Error("Printer not found");
    }
    if (printer.paused) {
      throw new Error("Resume the printer before running a test print");
    }

    const payload = buildTestPrintPayload({
      printerId: printer.id,
      printer: printer.name,
      type: printer.type,
      interface: printer.interface,
      port: printer.port,
      ip: printer.ip,
      supportsCut: Boolean(printer.supports_cut),
      supportsBeep: Boolean(printer.supports_beep),
      supportsQr: Boolean(printer.supports_qr),
      printLogo: Boolean(printer.print_logo ?? 1),
      characterSet: printer.character_set,
    });

    const result = enqueuePrintJob(payload);
    sendDashboardUpdate();

    return { success: true, result };
  } catch (error) {
    console.error("Run test print error:", error);
    return {
      success: false,
      message: error.message || "Failed to queue test print",
    };
  }
});

ipcMain.handle("add-printer", async (event, printer) => {
  try {
    if (!printer || !printer.type || !printer.interface) {
      throw new Error("Invalid printer data");
    }

    const settings = db.prepare("SELECT * FROM settings LIMIT 1").get();
    const { id, url, outlet_code } = printer;
    let result;

    if (settings) {
      db.prepare(
        "UPDATE settings SET base_url = ?, outlet_code = ? WHERE id = ?",
      ).run(url, outlet_code, settings.id);
    } else {
      db.prepare(
        "INSERT INTO settings (base_url, outlet_code) VALUES (?, ?)",
      ).run(url, outlet_code);
    }

    delete printer.url;

    if (id) {
      const stmt = db.prepare(`
        UPDATE printers 
        SET name = ?, type = ?, ip = ?, port = ?, interface = ?, content = ?, paused = ?, supports_cut = ?, supports_beep = ?, supports_qr = ?, print_logo = ?, character_set = ?
        WHERE id = ?
      `);
      stmt.run(
        printer.name,
        printer.type,
        printer.ip,
        printer.port,
        printer.interface,
        printer.content,
        boolToInt(printer.paused, 0),
        boolToInt(printer.supports_cut, 1),
        boolToInt(printer.supports_beep, 1),
        boolToInt(printer.supports_qr, 1),
        boolToInt(printer.print_logo, 1),
        printer.character_set || DEFAULT_PRINTER_CHARACTER_SET,
        id,
      );
      result = db.prepare("SELECT * FROM printers WHERE id = ?").get(id);
    } else {
      const stmt = db.prepare(`
        INSERT INTO printers (name, type, ip, port, interface, content, paused, supports_cut, supports_beep, supports_qr, print_logo, character_set)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(
        printer.name,
        printer.type,
        printer.ip,
        printer.port,
        printer.interface,
        printer.content,
        boolToInt(printer.paused, 0),
        boolToInt(printer.supports_cut, 1),
        boolToInt(printer.supports_beep, 1),
        boolToInt(printer.supports_qr, 1),
        boolToInt(printer.print_logo, 1),
        printer.character_set || DEFAULT_PRINTER_CHARACTER_SET,
      );
      result = db
        .prepare("SELECT * FROM printers WHERE id = ?")
        .get(info.lastInsertRowid);
    }

    if (result) {
      invalidateStartupChecksCache();
      mainWindow?.webContents.send("recordSaved", { type: "printer", result });
      scheduleAllPrintQueues();
      sendDashboardUpdate();
      return { success: true, result };
    }
    return { success: false, message: "Failed to save printer" };
  } catch (error) {
    console.error("Add printer error:", error);
    return {
      success: false,
      message: `Failed to save printer: ${error.message}`,
    };
  }
});

ipcMain.handle("delete-printer", async (event, printerId) => {
  try {
    if (!printerId) {
      throw new Error("Invalid printer ID");
    }

    db.prepare("DELETE FROM printers WHERE id = ?").run(printerId);
    invalidateStartupChecksCache();

    mainWindow?.webContents.send("recordSaved", {
      type: "printer-deleted",
      result: printerId,
    });
    sendDashboardUpdate();

    return { success: true, id: printerId };
  } catch (error) {
    console.error("Delete printer error:", error);
    return {
      success: false,
      message: `Failed to delete printer: ${error.message}`,
    };
  }
});

ipcMain.handle("login-action", async (event, password) => {
  try {
    if (!password) {
      return { success: false, message: "Password is required" };
    }

    const user = db.prepare("SELECT * FROM users LIMIT 1").get();

    if (!user) {
      return { success: false, message: "No user found" };
    }

    const response = user.password === password;

    if (response) {
      mainWindow?.webContents.send("authResponse", {
        success: true,
        user: user,
      });
      return { success: true, message: "Authentication successful" };
    } else {
      return { success: false, message: "Invalid password" };
    }
  } catch (error) {
    console.error("Login error:", error);
    return {
      success: false,
      message: `Authentication failed: ${error.message}`,
    };
  }
});
