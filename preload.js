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

  // Send messages (for backward compatibility) with enhanced security for Electron 38.x
  send: (channel, data) => {
    const validChannels = ["authenticated"];

    try {
      validateChannel(channel, validChannels);
      ipcRenderer.send(channel, data);
    } catch (error) {
      console.error("IPC send error:", error);
    }
  },

  // Get app version
  getAppVersion: () => process.versions.app,

  // Get platform
  getPlatform: () => process.platform,

  // Check if running in development
  isDev: () => process.env.NODE_ENV === "development",

  // Get Electron version
  getElectronVersion: () => process.versions.electron,

  // Get Node version
  getNodeVersion: () => process.versions.node,

  // Get Chrome version
  getChromeVersion: () => process.versions.chrome,

  // Check if running on Windows
  isWindows: () => process.platform === "win32",

  // Check if running on macOS
  isMacOS: () => process.platform === "darwin",

  // Check if running on Linux
  isLinux: () => process.platform === "linux",

  // Get system information (safe wrapper)
  getSystemInfo: async () => {
    try {
      return await ipcRenderer.invoke("get-system-info");
    } catch (error) {
      console.error("Failed to get system info:", error);
      return { success: false, message: "Failed to get system information" };
    }
  },

  // Utility functions for Electron 38.x
  utils: {
    // Format memory size
    formatMemory: (bytes) => {
      if (bytes === 0) return "0 Bytes";
      const k = 1024;
      const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    },

    // Format uptime
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

    // Check if system meets minimum requirements
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
          "Low CPU cores: Consider using a system with more CPU cores"
        );
      }

      if (!requirements.supportedPlatforms.includes(systemInfo.platform)) {
        issues.push(
          "Unsupported platform: This app may not work properly on this platform"
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
