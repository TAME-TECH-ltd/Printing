const { contextBridge, ipcRenderer } = require("electron");

// Security: Validate all IPC channels before use
const validateChannel = (channel, validChannels) => {
  if (!channel || typeof channel !== "string") {
    throw new Error("Invalid channel: must be a non-empty string");
  }
  if (!validChannels.includes(channel)) {
    throw new Error(`Invalid channel: ${channel} is not allowed`);
  }
  return true;
};

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld("electronAPI", {
  // IPC communication with enhanced security for Electron 38.x
  invoke: (channel, data) => {
    // Whitelist channels for security
    const validChannels = [
      "print-content",
      "add-printer",
      "delete-printer",
      "login-action",
      "get-settings",
      "get-system-info",
      "get-dashboard-data",
      "toggle-printer-pause",
      "retry-print-job",
      "clear-print-job",
      "run-test-print",
      "sync-remote-print-state",
    ];

    try {
      validateChannel(channel, validChannels);
      return ipcRenderer.invoke(channel, data);
    } catch (error) {
      console.error("IPC invoke error:", error);
      return Promise.reject(error);
    }
  },

  // Event listeners with enhanced security for Electron 38.x
  on: (channel, func) => {
    // Whitelist channels for security
    const validChannels = [
      "printersList",
      "printedContent",
      "retryPrinting",
      "recordSaved",
      "authResponse",
      "availableSettings",
      "print-error",
      "dashboard-updated",
      "queue-reset",
      "print-success",
      "printer-saved",
      "printer-deleted",
      "printer-error",
      "auth-error",
      "auth-success",
      "db-error",
      "printers-error",
      "open-settings",
      "window-maximized",
      "window-unmaximized",
    ];

    try {
      validateChannel(channel, validChannels);
      if (typeof func !== "function") {
        throw new Error("Callback must be a function");
      }
      ipcRenderer.on(channel, (event, ...args) => func(...args));
    } catch (error) {
      console.error("IPC event listener error:", error);
    }
  },

  // Remove event listeners with enhanced security for Electron 38.x
  removeAllListeners: (channel) => {
    const validChannels = [
      "printersList",
      "printedContent",
      "retryPrinting",
      "recordSaved",
      "authResponse",
      "availableSettings",
      "print-error",
      "dashboard-updated",
      "queue-reset",
      "print-success",
      "printer-saved",
      "printer-deleted",
      "printer-error",
      "auth-error",
      "auth-success",
      "db-error",
      "printers-error",
      "open-settings",
      "window-maximized",
      "window-unmaximized",
    ];

    try {
      validateChannel(channel, validChannels);
      ipcRenderer.removeAllListeners(channel);
    } catch (error) {
      console.error("IPC remove listeners error:", error);
    }
  },

  send: (channel, data) => {
    const validChannels = ["authenticated"];

    try {
      validateChannel(channel, validChannels);
      ipcRenderer.send(channel, data);
    } catch (error) {
      console.error("IPC send error:", error);
    }
  },

  getAppVersion: () => process.versions.app,

  getPlatform: () => process.platform,

  isDev: () => process.env.NODE_ENV === "development",

  getElectronVersion: () => process.versions.electron,

  getNodeVersion: () => process.versions.node,

  getChromeVersion: () => process.versions.chrome,

  isWindows: () => process.platform === "win32",

  isMacOS: () => process.platform === "darwin",

  isLinux: () => process.platform === "linux",

  getSystemInfo: async () => {
    try {
      return await ipcRenderer.invoke("get-system-info");
    } catch (error) {
      console.error("Failed to get system info:", error);
      return { success: false, message: "Failed to get system information" };
    }
  },

  utils: {
    formatMemory: (bytes) => {
      if (bytes === 0) return "0 Bytes";
      const k = 1024;
      const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    },

    formatUptime: (seconds) => {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);

      if (days > 0) return `${days}d ${hours}h ${minutes}m ${secs}s`;
      if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
      if (minutes > 0) return `${minutes}m ${secs}s`;
      return `${secs}s`;
    },

    checkSystemRequirements: (systemInfo) => {
      const requirements = {
        minMemory: 2 * 1024 * 1024 * 1024, // 2GB
        minCpuCores: 1,
        supportedPlatforms: ["win32", "darwin", "linux"],
      };

      const issues = [];

      if (systemInfo.totalMemory < requirements.minMemory) {
        issues.push("Low memory: Consider upgrading to at least 2GB RAM");
      }

      if (systemInfo.cpuCount < requirements.minCpuCores) {
        issues.push(
          "Low CPU cores: Consider using a system with more CPU cores",
        );
      }

      if (!requirements.supportedPlatforms.includes(systemInfo.platform)) {
        issues.push(
          "Unsupported platform: This app may not work properly on this platform",
        );
      }

      return {
        meetsRequirements: issues.length === 0,
        issues: issues,
        recommendations:
          issues.length > 0
            ? ["Consider upgrading your system for better performance"]
            : [],
      };
    },
  },
});
