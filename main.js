const electron = require("electron");
const path = require("path");
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage } = electron;
const {
  ThermalPrinter,
  PrinterTypes,
  CharacterSet,
  BreakLine,
} = require("node-thermal-printer");
const Database = require("better-sqlite3");

const userDataPath = app.getPath("userData");
const dbFilePath = path.join(userDataPath, "printing.sqlite");
console.log("Database path:", dbFilePath);

let db;

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
    let str = number.toString();
    const decimalIndex = str.indexOf(".");
    const decimalPlaces = 3;
    if (decimalIndex !== -1) {
      const limitedDecimal = str.substr(decimalIndex + 1, decimalPlaces);
      str = str.substr(0, decimalIndex + 1) + limitedDecimal;
    }
    return str.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
      let options = {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: this.timeZone,
      };
      let today = new Date(str);
      if (isNaN(today.getTime())) return "Invalid Date";
      return today.toLocaleDateString("en-US", options);
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
    let len = no.toString().length;
    if (len >= 4) return no.toString();
    if (len == 1) return `000${no}`;
    if (len == 2) return `00${no}`;
    if (len == 3) return `0${no}`;
    return no.toString();
  },

  padNumber(number, targetedLength = 5) {
    if (!number || isNaN(number)) return "0".repeat(targetedLength);
    let strNumber = number.toString();
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
    width: 700,
    height: 500,
    minWidth: 500,
    minHeight: 350,
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

  mainWindow.setTitle("Printing Service v1.2.2");

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
      mainWindow.webContents.send("printersList", printers);
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
  const options = {
    type: PrinterTypes[data.type],
    characterSet: CharacterSet.PC852_LATIN2,
    removeSpecialCharacters: false,
    lineCharacter: ".",
    breakLine: BreakLine.WORD,
    options: {
      timeout: 5000,
    },
  };
  if (data.ip) {
    options.interface = `tcp://${data.ip}`;
  } else {
    options.interface = `//localhost/${data.port}`;
  }
  const printer = new ThermalPrinter(options);
  const orderDate = `${data?.order?.system_date} ${data?.order?.order_time}`;
  try {
    await printer.isPrinterConnected();
    printer.alignCenter();
    printer.setTypeFontA();
    printer.setTextDoubleHeight();
    printer.setTextDoubleWidth();
    printer.println(data?.settings?.name);
    printer.setTextNormal();
    printer.println(`TIN: ${data?.settings?.tin_number}`);
    printer.println(`Tel: ${data?.settings?.phone}`);
    printer.println(`Email: ${data?.settings?.email}`);
    printer.println(`Address: ${data?.settings?.address_line}`);
    if (data?.round?.category === "INVOICE") {
      printer.print(`MOMO Code: `);
      printer.bold(true);
      printer.print(`${data?.settings?.momo_code}`);
      printer.bold(false);
      printer.setTextNormal();
      printer.newLine();
    }
    printer.drawLine();

    printer.alignLeft();
    if (data?.round?.category === "ORDER") {
      printer.println(
        `Order #: ${helper.generateVoucherNo(data?.round?.round_no)}(${
          data?.round?.destination_name
        })`,
      );
    } else if (data?.round?.category === "INVOICE") {
      printer.println(
        `Invoice #: ${helper.generateVoucherNo(data?.order?.id)}`,
      );
    }
    printer.println(`Customer: ${data?.order?.client || "Walk-In"}`);
    printer.tableCustom([
      {
        text: `Served By: ${data?.order?.waiter}`,
        align: "LEFT",
      },
      { text: `Table No: ${data?.order?.table_name}`, align: "RIGHT" },
    ]);

    printer.tableCustom([
      {
        text: `Date: ${helper.formatDate(orderDate)}`,
        align: "LEFT",
      },
      {
        text: `Time: ${helper.formatTime(orderDate)}`,
        align: "RIGHT",
      },
    ]);

    printer.drawLine();

    printer.tableCustom([
      { text: "Item", align: "LEFT", width: 0.5, bold: true },
      { text: "Qty", align: "CENTER", width: 0.1, bold: true },
      { text: "Price", align: "CENTER", width: 0.18, bold: true },
      { text: "Total", align: "RIGHT", width: 0.22, bold: true },
    ]);

    printer.drawLine();

    data?.items.forEach((item) => {
      printer.tableCustom([
        { text: item.name, align: "LEFT", width: 0.5 },
        { text: item.quantity, align: "CENTER", width: 0.1 },
        { text: helper.formatMoney(item.price), align: "CENTER", width: 0.18 },
        { text: helper.formatMoney(item.amount), align: "RIGHT", width: 0.22 },
      ]);
      if (item?.comment && data?.round?.category === "ORDER") {
        printer.setTypeFontB();
        printer.tableCustom([
          {
            text: `\x1B\x45\x01Notes: \x1B\x45\x00${item.comment}`,
            align: "LEFT",
            width: 1,
          },
        ]);
        printer.setTypeFontA();
      }
    });

    printer.drawLine();
    if (data?.round?.category === "INVOICE") {
      printer.alignRight();
      printer.newLine();
      printer.println(
        `Tax(VAT - 18%): RWF ${
          helper.formatMoney(Number(data?.order?.total_taxes)).split(".")[0]
        }`,
      );
      printer.newLine();
      printer.setTextDoubleWidth();
      printer.println(
        `Total: RWF ${helper.formatMoney(Number(data?.order?.grand_total))}`,
      );
      printer.setTextNormal();
      printer.drawLine();
      printer.alignCenter();
      printer.newLine();
      printer.println(`Notes: This is not a legal receipt.`);
      printer.newLine();
      printer.setTypeFontB();
      printer.println(`THANKS FOR VISITING!!`);
      printer.setTextNormal();
      printer.newLine();
      printer.printQR("https://tameapp.cloud", {
        cellSize: 6,
        correction: "H",
      });
      if (data?.order?.ebm_meta) {
        const invoiceMeta = data?.order?.ebm_meta;
        printer.newLine();
        printer.bold(true);
        printer.print("SDC INFORMATION");
        printer.bold(false);
        printer.setTextNormal();
        printer.drawLine();
        printer.println(
          `Date: ${helper.formateEbmDate(invoiceMeta.vsdcRcptPbctDate)}`,
        );
        printer.println(`SDC ID: ${invoiceMeta.sdcId}`);
        printer.println(`Internal Data: ${invoiceMeta.intrlData}`);
        printer.println(`Receipt Signature: ${invoiceMeta.rcptSign}`);
        printer.println(`MRC: ${invoiceMeta.mrcNo}`);
      }
    }
    printer.cut();
    printer.beep();
    await printer.execute();
    mainWindow?.webContents.send("printedContent", {
      latest: data?.round?.id,
      content: data?.content,
    });
  } catch (error) {
    mainWindow?.webContents.send("retryPrinting", data);
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
        SET name = ?, type = ?, ip = ?, port = ?, interface = ?, content = ?
        WHERE id = ?
      `);
      stmt.run(
        printer.name,
        printer.type,
        printer.ip,
        printer.port,
        printer.interface,
        printer.content,
        id,
      );
      result = db.prepare("SELECT * FROM printers WHERE id = ?").get(id);
    } else {
      const stmt = db.prepare(`
        INSERT INTO printers (name, type, ip, port, interface, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(
        printer.name,
        printer.type,
        printer.ip,
        printer.port,
        printer.interface,
        printer.content,
      );
      result = db
        .prepare("SELECT * FROM printers WHERE id = ?")
        .get(info.lastInsertRowid);
    }

    if (result) {
      mainWindow?.webContents.send("recordSaved", { type: "printer", result });
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

    mainWindow?.webContents.send("recordSaved", {
      type: "printer-deleted",
      result: printerId,
    });

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
