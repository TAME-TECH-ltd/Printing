const electron = require("electron");
const path = require("path");
const fs = require("fs");
const helper = require("./helper");
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = electron;
const {
  ThermalPrinter,
  PrinterTypes,
  CharacterSet,
  BreakLine,
} = require("node-thermal-printer");
const { PrismaClient } = require("@prisma/client");
const userDataPath = app.getPath("userData");
const dbFilePath = path.join(userDataPath, "printing.sqlite");
let requireInitialization = false;
if (!fs.existsSync(dbFilePath)) {
  fs.writeFileSync(dbFilePath, "", "utf8");
  requireInitialization = true;
}

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: `file:${dbFilePath}`,
    },
  },
});

let mainWindow;
let tray;
app.setName("Printing Service");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 650,
    height: 500,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      enableRemoteModule: false,
      nodeIntegration: true,
      contextIsolation: true,
    },
    icon: path.join(__dirname, "/assets/icons/logo.png"),
    acceptFirstMouse: true,
  });

  mainWindow.setTitle("Printing Service");
  mainWindow.loadURL("file://" + __dirname + "/index.html");

  mainWindow.on("close", (event) => {
    // mainWindow = null;
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  const iconPath = path.join(__dirname, "assets", "icons", "logo.png");
  tray = new Tray(nativeImage.createFromPath(iconPath));
  const trayMenu = Menu.buildFromTemplate([
    {
      label: "Show App",
      click: () => {
        mainWindow.show();
      },
    },
    {
      label: "Exit",
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip("Printing Service");
  tray.setContextMenu(trayMenu);

  // Handle tray icon click to show the app
  tray.on("click", () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.on("did-finish-load", async () => {
    if (requireInitialization) {
      try {
        await prisma.$connect();
        const createPrinterTable = `
          CREATE TABLE IF NOT EXISTS printers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            type TEXT NOT NULL,
            ip TEXT,
            port TEXT,
            interface TEXT NOT NULL,
            content TEXT
          );
        `;
        const createUserTable = `
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL
          );
        `;
        const createSettingTable = `
          CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            branch_id INTEGER NOT NULL,
            branch_name TEXT NOT NULL,
            base_url TEXT NOT NULL
          );
        `;
        await prisma.$executeRawUnsafe(createPrinterTable);
        await prisma.$executeRawUnsafe(createUserTable);
        await prisma.$executeRawUnsafe(createSettingTable);
        await prisma.user.create({
          data: {
            name: "Super Admin",
            email: "webmaster@gmail.com",
            password: "tame123",
          },
        });
      } catch (error) {
        await prisma.$disconnect();
      } finally {
        await prisma.$disconnect();
      }
    }
    mainWindow.webContents.getPrintersAsync().then((printers) => {
      mainWindow.webContents.send("printersList", printers);
    });
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit(); // Quit if another instance is already running
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    // Handle second instance by focusing or restoring the main window
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    } else {
      createWindow();
    }
    app.quit();
  });
}

/* app.on("ready", () => {
  createWindow();
}); */

app.whenReady().then(() => {
  createWindow();
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath("exe"),
    args: [],
  });
});

app.on("window-all-closed", function () {
  if (process.platform !== "darwin") {
    //app.quit();
    app.dock.hide();
  }
});

app.on("activate", function () {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", async () => {
  await prisma.$disconnect();
});

ipcMain.on("request-settings", async (event) => {
  const settings = await prisma.setting.findFirst();
  const printers = await prisma.printer.findMany();
  event.reply("availableSettings", { settings, printers });
});

ipcMain.handle("print-content", async (event, data) => {
  const options = {
    type: PrinterTypes[data.type], // or PrinterTypes.STAR
    characterSet: CharacterSet.PC852_LATIN2,
    removeSpecialCharacters: false,
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

  try {
    await printer.isPrinterConnected();
    printer.alignCenter();
    printer.setTypeFontA();
    printer.setTextDoubleHeight();
    printer.setTextDoubleWidth();
    printer.println(data?.settings?.site_name);
    printer.setTextNormal();
    printer.println(`TIN: ${data?.settings?.app_tin}`);
    printer.println(`Tel: ${data?.settings?.app_phone}`);
    printer.println(`Email: ${data?.settings?.app_email}`);
    printer.println(`Address: ${data?.settings?.site_address}`);
    printer.drawLine();
    printer.alignLeft();

    const isReceipt = data?.order?.ebm_meta || data?.round?.origin === "RETAIL";
    if (data?.round?.category === "ORDER") {
      printer.println(
        `Order #: ${helper.generateVoucherNo(data?.round?.round_no)}(${
          data?.round?.destination
        })`
      );
    } else if (data?.round?.category === "INVOICE") {
      printer.println(
        `${isReceipt ? "RECEIPT" : "INVOICE"} #: ${helper.generateVoucherNo(
          data?.order?.id
        )}`
      );
    } else {
      // printer.print(`\x1B\x45\x01${data?.settings?.momo_code}\x1B\x45\x00`);
      printer.println(
        `\x1B\x45\x01Round Slip #\x1B\x45\x00: ${helper.generateVoucherNo(
          data?.round?.round_no
        )}`
      );
    }
    printer.println(`Customer: ${data?.order?.client || "Walk-In"}`);
    if (!isReceipt) {
      printer.tableCustom([
        {
          text: `Served By: ${data?.order?.waiter}`,
          align: "LEFT",
        },
        { text: `Table No: ${data?.order?.table_name}`, align: "RIGHT" },
      ]);
    }

    printer.tableCustom([
      {
        text: `Date: ${helper.formatDate(data?.order?.system_date)}`,
        align: "LEFT",
      },
      {
        text: `Time: ${helper.formatTime(data?.order?.order_time)}`,
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
      if (data?.order?.ebm_meta) {
        const totals = [
          ["Total Rwf", `${data?.order?.grand_total}`],
          ["Total A-EX Rwf", `0.00`],
          ["Total B-18% Rwf", `${data?.order?.total_taxes}`],
          ["Total D", `0.00`],
          ["Total Tax Rwf", `${data?.order?.total_taxes}`],
        ];

        totals.forEach((item) => {
          printer.tableCustom([
            { text: item[0], align: "LEFT" },
            { text: item[1], align: "RIGHT" },
          ]);
        });

        printer.drawLine();
        const invoiceMeta = data?.order?.ebm_meta;
        printer.newLine();
        printer.bold(true);
        printer.print("SDC INFORMATION");
        printer.bold(false);
        printer.newLine();
        printer.setTextNormal();
        printer.drawLine();
        printer.println(
          `Date: ${helper.formateEbmDate(invoiceMeta.vsdcRcptPbctDate)}`
        );
        printer.println(`SDC ID: ${invoiceMeta.sdcId}`);
        printer.println(`Internal Data: ${invoiceMeta.intrlData}`);
        printer.println(`Receipt Signature: ${invoiceMeta.rcptSign}`);
        printer.println(`MRC: ${invoiceMeta.mrcNo}`);
        printer.newLine();
        printer.alignCenter();
        printer.printQR(
          `https://myrra.rra.gov.rw/common/link/ebm/receipt/indexEbmReceiptData?Data=${invoiceMeta.rcptSign}`,
          {
            cellSize: 3,
            correction: "Q",
          }
        );
        printer.println(`Powered by EBM v2.1`);
      } else {
        printer.alignRight();
        printer.setTextDoubleWidth();
        printer.println(
          `Total: ${helper.formatMoney(data?.order?.grand_total)}`
        );
        printer.setTextNormal();
        printer.drawLine();
        printer.alignCenter();
        printer.print(`Dial `);
        printer.bold(true);
        //printer.print(`\x1B\x45\x01${data?.settings?.momo_code}\x1B\x45\x00`);
        printer.setTextQuadArea();
        printer.setTypeFontB();
        printer.print(`${data?.settings?.momo_code}`);
        printer.bold(false);
        printer.setTextNormal();
        printer.setTypeFontA();
        printer.print(` to pay with MOMO`);
        printer.newLine();
        printer.println(
          `This is not a legal receipt. Please ask your legal receipt.`
        );
        printer.println(`Thank you!`);
      }
    } else if (data?.round?.category === "ROUND_SLIP") {
      const total = data?.items?.reduce((a, b) => a + Number(b.amount), 0);
      printer.alignRight();
      printer.setTextDoubleWidth();
      printer.println(`Total: ${helper.formatMoney(total)}`);
      printer.setTextNormal();
      printer.drawLine();
      printer.alignCenter();
      printer.println(
        "This is neither a legal receipt or final invoice. It is just a round total slip."
      );
    }
    printer.cut();
    printer.beep();
    await printer.execute();
    mainWindow?.webContents.send("printedContent", {
      latest: data?.round?.id,
      ...(data?.content ? { content: data.content } : {}),
    });
  } catch (error) {
    mainWindow?.webContents.send("retryPrinting", data);
    //console.error("Print failed:", error);
  }
});

ipcMain.handle("add-printer", async (event, printer) => {
  const { id } = printer;
  let result;
  if (id) {
    result = await prisma.printer.update({
      data: printer,
      where: { id },
    });
  } else {
    result = await prisma.printer.create({
      data: printer,
    });
  }
  if (result) {
    mainWindow?.webContents.send("recordSaved", { type: "printer", result });
  }
});

ipcMain.handle("delete-printer", async (event, printerId) => {
  await prisma.printer.delete({ where: { id: printerId } });
  mainWindow?.webContents.send("recordSaved", {
    type: "printer-deleted",
    result: printerId,
  });
});

ipcMain.handle("save-settings", async (event, settings) => {
  const row = await prisma.setting.findFirst();
  let result;
  if (row) {
    result = await prisma.setting.update({
      data: settings,
      where: { id: row.id },
    });
  } else {
    result = await prisma.setting.create({
      data: settings,
    });
  }
  if (result) {
    mainWindow?.webContents.send("recordSaved", { type: "settings", result });
  }
});

ipcMain.handle("login-action", async (event, password) => {
  const user = await prisma.user.findFirst();
  const response = user.password === password;
  mainWindow?.webContents.send("authResponse", response);
});

ipcMain.handle("reset-action", async (event, form) => {
  const user = await prisma.user.findFirst();
  const response = user.password === form.current_password;
  if (response) {
    await prisma.user.updateMany({ data: { password: form.new_password } });
    mainWindow?.webContents.send("resetResponse", "password-changed");
  } else {
    mainWindow?.webContents.send("resetResponse", "password-mismatch");
  }
});
