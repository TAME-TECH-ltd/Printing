const {
  createApp,
  ref,
  computed,
  onBeforeMount,
  onMounted,
  onUnmounted,
  watch,
} = Vue;

const encodeQuery = (url, data) => {
  let query = "";
  for (let d in data) {
    if (data[d] && url.indexOf(`?${d}`) < 0 && url.indexOf(`&${d}`) < 0)
      query += encodeURIComponent(d) + "=" + encodeURIComponent(data[d]) + "&";
  }
  return url.indexOf("?") > -1
    ? `${url}&${query.slice(0, -1)}`
    : `${url}?${query.slice(0, -1)}`;
};

function addBkendIfProduction(baseUrl, path) {
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname.endsWith(".localhost")
    ) {
      return `${baseUrl}${path}`;
    }
  } catch {
    if (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1")) {
      return `${baseUrl}${path}`;
    }
  }
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  let insertPath = cleanPath.startsWith("/bkend/")
    ? cleanPath
    : `/bkend${cleanPath}`;
  return `${baseUrl}${insertPath}`;
}

const DISPLAY_MODES = {
  PRINTERS_VIEW: "PRINTERS_VIEW",
  FORM_VIEW: "FORM_VIEW",
};

const PRINTER_TYPES = {
  EPSON: "EPSON",
};

const PRINTER_INTERFACES = {
  TCP: "TCP",
};

const CONTENT_TYPES = {
  K: "Kitchen Orders",
  B: "Bard Orders",
  I: "Invoices",
  KB: "Kitchen & Bar Orders",
  BK: "Kitchen & Bar Orders",
  KI: "Kitchen Orders & Invoices",
  IK: "Kitchen Orders & Invoices",
  BI: "BAR & Invoices",
  IB: "BAR & Invoices",
};

const useApiClient = () => {
  const isLoading = ref(false);
  const isFetching = ref(false);

  const setupInterceptors = () => {
    const requestInterceptor = axios.interceptors.request.use(
      (config) => {
        isLoading.value = true;
        return config;
      },
      (error) => {
        isLoading.value = false;
        return Promise.reject(error);
      },
    );

    const responseInterceptor = axios.interceptors.response.use(
      (response) => {
        isLoading.value = false;
        return response;
      },
      (error) => {
        isLoading.value = false;
        return Promise.reject(error);
      },
    );

    return () => {
      axios.interceptors.request.eject(requestInterceptor);
      axios.interceptors.response.eject(responseInterceptor);
    };
  };

  return {
    isLoading,
    isFetching,
    setupInterceptors,
  };
};

const useFetchingService = (url, activePrinters, appSettings, outletCode) => {
  const BASE_DELAY = 2000;
  const INITIAL_RETRY_DELAY = 3000;
  const MAX_RETRY_DELAY = 20000;
  const isFetching = ref(false);
  const workerStates = ref({});

  const normalizePrinterContent = (rawContent) => {
    if (!rawContent) return "";
    if (Array.isArray(rawContent)) return rawContent.join("");
    if (typeof rawContent === "string") {
      try {
        const parsed = JSON.parse(rawContent);
        return Array.isArray(parsed) ? parsed.join("") : String(parsed || "");
      } catch {
        return rawContent;
      }
    }
    return String(rawContent);
  };

  const getPrinterWorkerKey = (printer) => {
    if (!printer) return "";
    if (printer.id) return `printer:${printer.id}`;

    return [
      printer.name || "",
      printer.interface || "",
      printer.ip || "",
      printer.port || "",
      printer.content || "",
    ].join("|");
  };

  const getPrinterByKey = (printerKey) => {
    return activePrinters.value.find(
      (printer) => getPrinterWorkerKey(printer) === printerKey,
    );
  };

  const getPrinterKeyFromMeta = (meta = null) => {
    if (meta?.printerId) {
      return `printer:${meta.printerId}`;
    }
    return meta?.printerKey || "";
  };

  const ensureWorkerState = (printerKey) => {
    if (!printerKey) return null;
    if (!workerStates.value[printerKey]) {
      workerStates.value[printerKey] = {
        isActive: false,
        isFetching: false,
        retryDelay: INITIAL_RETRY_DELAY,
        timer: null,
      };
    }
    return workerStates.value[printerKey];
  };

  const updateFetchingState = () => {
    isFetching.value = Object.values(workerStates.value).some(
      (state) => state.isFetching,
    );
  };

  const buildFetchMeta = (printer, meta = null) => {
    const printerContent = normalizePrinterContent(printer?.content);
    return {
      ...(meta || {}),
      ...(printer?.id ? { printerId: printer.id } : {}),
      ...(getPrinterWorkerKey(printer)
        ? { printerKey: getPrinterWorkerKey(printer) }
        : {}),
      ...(printerContent ? { content: printerContent } : {}),
    };
  };

  const resetRetryDelay = (printerKey) => {
    const state = ensureWorkerState(printerKey);
    if (state) {
      state.retryDelay = INITIAL_RETRY_DELAY;
    }
  };

  const increaseRetryDelay = (printerKey) => {
    const state = ensureWorkerState(printerKey);
    if (!state) return INITIAL_RETRY_DELAY;

    state.retryDelay = Math.min(
      Math.round(state.retryDelay * 1.8),
      MAX_RETRY_DELAY,
    );

    return state.retryDelay;
  };

  const getRateLimitDelay = (error) => {
    const status = error?.response?.status;
    if (status !== 429) return null;

    const retryAfter =
      error?.response?.headers?.["retry-after"] ||
      error?.response?.headers?.RetryAfter;

    const retryAfterSeconds = Number(retryAfter);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return Math.min(retryAfterSeconds * 1000, MAX_RETRY_DELAY);
    }

    return Math.min(Math.max(INITIAL_RETRY_DELAY, BASE_DELAY * 2), MAX_RETRY_DELAY);
  };

  const removeLatestFromMeta = (meta = null) => {
    if (!meta) return null;
    const next = { ...meta };
    delete next.latest;
    return Object.keys(next).length ? next : null;
  };

  const clearWorkerTimer = (printerKey) => {
    const state = ensureWorkerState(printerKey);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  };

  const scheduleNextFetch = (printerKey, meta = null, delay = BASE_DELAY) => {
    const state = ensureWorkerState(printerKey);
    if (!state) return;

    clearWorkerTimer(printerKey);
    state.timer = setTimeout(() => {
      const latestPrinter = getPrinterByKey(printerKey);
      if (state.isActive && latestPrinter) {
        startFetching(printerKey, meta);
      }
    }, delay);
  };

  const startFetching = async (printerKey, meta = null) => {
    const state = ensureWorkerState(printerKey);
    const printer = getPrinterByKey(printerKey);
    if (!state || !state.isActive || state.isFetching || !printer) return;

    const roundsUrl = url.value ? "next-printable-round" : null;
    if (!roundsUrl) {
      scheduleNextFetch(printerKey, buildFetchMeta(printer, meta), 3000);
      return;
    }

    const requestMeta = buildFetchMeta(printer, meta);
    let _url = outletCode.value
      ? addBkendIfProduction(url.value, `/api/${roundsUrl}/${outletCode.value}`)
      : addBkendIfProduction(url.value, `/api/${roundsUrl}`);

    const filters = {};
    if (requestMeta.latest) filters.latest = requestMeta.latest;
    if (requestMeta.content) filters.content = requestMeta.content;
    if (Object.keys(filters).length > 0) {
      _url = encodeQuery(_url, filters);
    }

    state.isFetching = true;
    updateFetchingState();

    try {
      const response = await axios.get(_url);
      const { status, order, items } = response.data || {};
      resetRetryDelay(printerKey);
      const nextMeta = removeLatestFromMeta(requestMeta);

      if (!status) {
        scheduleNextFetch(printerKey, nextMeta, BASE_DELAY);
        return;
      }

      const round = response.data.round;

      const printData = {
        printerId: printer.id,
        printer: printer.name,
        type: printer.type,
        interface: printer.interface,
        port: printer.port,
        ip: printer.ip,
        round,
        items,
        order,
        settings: { ...appSettings.value },
        content: normalizePrinterContent(printer.content),
      };

      try {
        await window.electronAPI.invoke("print-content", printData);
      } catch (printError) {
        console.error("Print error:", printError);
        scheduleNextFetch(printerKey, nextMeta, INITIAL_RETRY_DELAY);
      }
    } catch (error) {
      console.error("Fetch error:", error);
      const rateLimitDelay = getRateLimitDelay(error);
      if (rateLimitDelay !== null) {
        scheduleNextFetch(printerKey, requestMeta, rateLimitDelay);
      } else {
        scheduleNextFetch(
          printerKey,
          requestMeta,
          increaseRetryDelay(printerKey),
        );
      }
    } finally {
      state.isFetching = false;
      updateFetchingState();
    }
  };

  const stopFetching = (printerKey = null) => {
    if (printerKey) {
      const state = ensureWorkerState(printerKey);
      if (!state) return;
      state.isActive = false;
      clearWorkerTimer(printerKey);
      state.isFetching = false;
      updateFetchingState();
      return;
    }

    Object.keys(workerStates.value).forEach((key) => {
      stopFetching(key);
    });
  };

  const pruneWorkerStates = () => {
    const activeKeys = new Set(activePrinters.value.map(getPrinterWorkerKey));

    Object.keys(workerStates.value).forEach((printerKey) => {
      if (!activeKeys.has(printerKey)) {
        stopFetching(printerKey);
        delete workerStates.value[printerKey];
      }
    });

    activePrinters.value.forEach((printer) => {
      ensureWorkerState(getPrinterWorkerKey(printer));
    });

    updateFetchingState();
  };

  const resumeFetching = (meta = null) => {
    pruneWorkerStates();

    const targetedPrinterKey = getPrinterKeyFromMeta(meta);
    if (targetedPrinterKey) {
      const latestPrinter = getPrinterByKey(targetedPrinterKey);
      if (!latestPrinter) return;

      const state = ensureWorkerState(targetedPrinterKey);
      state.isActive = true;
      startFetching(targetedPrinterKey, meta);
      return;
    }

    activePrinters.value.forEach((printer) => {
      const printerKey = getPrinterWorkerKey(printer);
      const state = ensureWorkerState(printerKey);
      state.isActive = true;
      startFetching(printerKey, buildFetchMeta(printer, meta));
    });
  };

  const isPrinterFetching = (printer) => {
    const printerKey = getPrinterWorkerKey(printer);
    return Boolean(workerStates.value[printerKey]?.isFetching);
  };

  return {
    isFetching,
    isPrinterFetching,
    startFetching,
    stopFetching,
    resumeFetching,
    pruneWorkerStates,
  };
};

const useFlashMessage = () => {
  const hasFlashMessage = ref(false);
  const message = ref(null);
  const messageTimeout = ref(null);

  const toggleFlashMessage = (msg) => {
    if (messageTimeout.value) {
      clearTimeout(messageTimeout.value);
    }

    hasFlashMessage.value = true;
    message.value = msg;

    messageTimeout.value = setTimeout(() => {
      hasFlashMessage.value = false;
      message.value = null;
    }, 3000);
  };

  const clearMessage = () => {
    if (messageTimeout.value) {
      clearTimeout(messageTimeout.value);
      messageTimeout.value = null;
    }
    hasFlashMessage.value = false;
    message.value = null;
  };

  return {
    hasFlashMessage,
    message,
    toggleFlashMessage,
    clearMessage,
  };
};

const App = {
  setup() {
    const displayMode = ref(DISPLAY_MODES.PRINTERS_VIEW);
    const appSettings = ref({});
    const printers = ref([]);
    const activePrinters = ref([]);
    const url = ref("");
    const outletCode = ref(""); // New outlet code variable
    const password = ref("");
    const invalidPassword = ref(false);
    const isAuthenticating = ref(false);
    const isAuthenticated = ref(false);
    const showApiConfig = ref(false);
    const isSavingPrinter = ref(false);
    const isDeletingPrinter = ref(false);
    const systemInfo = ref(null);
    const showSystemInfo = ref(false);

    const selectedPrinter = ref("");
    const selectedPrinterId = ref(null);
    const printerIpAddress = ref("");
    const printerPort = ref("");
    const printerType = ref(PRINTER_TYPES.EPSON);
    const printerInterface = ref(PRINTER_INTERFACES.TCP);
    const content = ref([]);

    const printerForm = ref({
      ipAddress: "",
      port: "",
      type: PRINTER_TYPES.EPSON,
      interface: PRINTER_INTERFACES.TCP,
      name: "",
      id: null,
      content: [],
    });

    const { isLoading, setupInterceptors } = useApiClient();
    const { hasFlashMessage, message, toggleFlashMessage, clearMessage } =
      useFlashMessage();
    const {
      isFetching,
      isPrinterFetching,
      startFetching,
      stopFetching,
      resumeFetching,
      pruneWorkerStates,
    } = useFetchingService(url, activePrinters, appSettings, outletCode);

    const roundsUrl = computed(() => {
      return url.value ? "next-printable-round" : null;
    });

    const eventHandlers = {
      printersList: (_printers) => {
        printers.value = _printers;
      },

      printedContent: (meta) => {
        setTimeout(() => {
          resumeFetching(meta);
        }, 50);
      },

      retryPrinting: () => {
        toggleFlashMessage({
          type: "warning",
          text: "Printer is unavailable. The app will keep retrying automatically.",
        });
      },

      recordSaved: (data) => {
        const { type, result } = data;
        switch (type) {
          case "printer":
            if (selectedPrinterId.value || printerForm.value.id) {
              const printerId = selectedPrinterId.value || printerForm.value.id;
              const index = activePrinters.value.findIndex(
                (printer) => printer.id == printerId,
              );
              if (index !== -1) {
                activePrinters.value[index] = result;
              }
            } else {
              activePrinters.value.push(result);
            }
            displayMode.value = DISPLAY_MODES.PRINTERS_VIEW;
            resetForm();
            break;
          case "printer-deleted":
            const index = activePrinters.value.findIndex(
              (printer) => printer.id == result,
            );
            if (index !== -1) {
              activePrinters.value.splice(index, 1);
            }
            break;
          default:
            break;
        }
        toggleFlashMessage({
          type: "success",
          text: "Database updated successfully",
        });
        resumeFetching();
      },

      availableSettings: (data) => {
        const { settings, printers } = data;
        activePrinters.value = printers;
        if (settings && Object.keys(settings).length > 0) {
          url.value = settings.base_url;
          outletCode.value = settings.outlet_code || "";
          axios
            .get(
              addBkendIfProduction(
                settings.base_url,
                outletCode.value
                  ? `/api/frontend/preloaders/${outletCode.value}`
                  : "/api/frontend/preloaders",
              ),
            )
            .then((response) => {
              appSettings.value = response?.data?.company;
              if (activePrinters.value.length) {
                resumeFetching();
              }
            })
            .catch((error) => {
              console.error("Failed to load settings:", error);
              toggleFlashMessage({
                type: "error",
                text: "Failed to load application settings",
              });
            });
        }
      },

      "print-error": (errorInfo) => {
        console.error("Print error:", errorInfo);
        const details = errorInfo?.error ? ` ${errorInfo.error}` : "";
        toggleFlashMessage({
          type: "error",
          text: `Printing failed: ${errorInfo.message}.${details}`,
        });
      },
    };

    const setupEventListeners = () => {
      Object.entries(eventHandlers).forEach(([event, handler]) => {
        window.electronAPI.on(event, handler);
      });
    };

    const cleanupEventListeners = () => {
      Object.keys(eventHandlers).forEach((event) => {
        window.electronAPI.removeAllListeners(event);
      });
    };

    onBeforeMount(() => {
      setupInterceptors();
      setupEventListeners();
    });

    watch(
      activePrinters,
      () => {
        pruneWorkerStates();
      },
      { deep: true },
    );

    onMounted(() => {
      isAuthenticated.value = false; // Always skip login for now
      console.log(
        "Printing Service loaded. Login skipped for development mode.",
      );
      window.electronAPI.send("authenticated");

      loadSystemInfo();
    });

    onUnmounted(() => {
      stopFetching();
      cleanupEventListeners();
      clearMessage();
    });

    const loadSystemInfo = async () => {
      try {
        const response = await window.electronAPI.invoke("get-system-info");
        if (response.success) {
          systemInfo.value = response.systemInfo;
          console.log("System Info:", response.systemInfo);
          console.log("Recommendations:", response.recommendations);
        }
      } catch (error) {
        console.error("Failed to load system info:", error);
      }
    };

    const resetForm = () => {
      selectedPrinterId.value = null;
      selectedPrinter.value = "";
      printerIpAddress.value = "";
      printerPort.value = "";
      printerType.value = PRINTER_TYPES.EPSON;
      printerInterface.value = PRINTER_INTERFACES.TCP;
      content.value = [];

      printerForm.value = {
        ipAddress: "",
        port: "",
        type: PRINTER_TYPES.EPSON,
        interface: PRINTER_INTERFACES.TCP,
        name: "",
        id: null,
        content: [],
      };
    };

    const setPrinter = () => {
      isSavingPrinter.value = true;
      const printer = {
        url: url.value,
        outlet_code: outletCode.value || null, // pass to backend
        name: selectedPrinter.value || printerForm.value.name,
        type: printerType.value || printerForm.value.type,
        ip: printerIpAddress.value || printerForm.value.ipAddress,
        port: printerPort.value || printerForm.value.port,
        interface: printerInterface.value || printerForm.value.interface,
        content: JSON.stringify(
          content.value.length ? content.value : printerForm.value.content,
        ),
      };
      if (selectedPrinterId.value || printerForm.value.id) {
        printer.id = selectedPrinterId.value || printerForm.value.id;
      }
      window.electronAPI
        .invoke("add-printer", printer)
        .catch((error) => {
          console.error("Failed to save printer:", error);
          toggleFlashMessage({
            type: "error",
            text: "Failed to save printer configuration",
          });
        })
        .finally(() => {
          isSavingPrinter.value = false;
        });
    };

    const showPrinterForm = (printer = null) => {
      if (printer) {
        selectedPrinterId.value = printer.id;
        selectedPrinter.value = printer.name;
        printerType.value = printer.type;
        printerIpAddress.value = printer.ip;
        printerPort.value = printer.port;
        printerInterface.value = printer.interface;
        content.value = JSON.parse(printer.content);

        printerForm.value = {
          id: printer.id,
          name: printer.name,
          type: printer.type,
          ipAddress: printer.ip,
          port: printer.port,
          interface: printer.interface,
          content: JSON.parse(printer.content),
        };
      } else {
        resetForm();
      }
      displayMode.value = DISPLAY_MODES.FORM_VIEW;
    };

    const handleCancel = () => {
      resetForm();
      displayMode.value = DISPLAY_MODES.PRINTERS_VIEW;
    };

    const deletePrinter = (printer) => {
      if (
        confirm(`Are you sure you want to remove printer ${printer?.name}?`)
      ) {
        isDeletingPrinter.value = true;
        window.electronAPI
          .invoke("delete-printer", printer.id)
          .catch((error) => {
            console.error("Failed to delete printer:", error);
            toggleFlashMessage({
              type: "error",
              text: "Failed to delete printer",
            });
          })
          .finally(() => {
            isDeletingPrinter.value = false;
          });
      }
    };

    const handleLogin = () => {
      if (!password.value) {
        toggleFlashMessage({
          type: "warning",
          text: "Please enter a password",
        });
        return;
      }

      isAuthenticating.value = true;
      invalidPassword.value = false;

      window.electronAPI
        .invoke("login-action", password.value)
        .then((response) => {
          if (response && response.success) {
            isAuthenticated.value = true;
            password.value = "";
            toggleFlashMessage({
              type: "success",
              text: "Login successful!",
            });
            window.electronAPI.send("authenticated");
          } else {
            toggleFlashMessage({
              type: "error",
              text: response?.message || "Invalid password. Please try again.",
            });
          }
        })
        .catch((error) => {
          console.error("Login error:", error);
          toggleFlashMessage({
            type: "error",
            text: "Login failed. Please try again.",
          });
        })
        .finally(() => {
          isAuthenticating.value = false;
        });
    };

    const handleLogout = () => {
      isAuthenticated.value = false;
      password.value = "";
      invalidPassword.value = false;
      toggleFlashMessage({
        type: "info",
        text: "You have been logged out successfully.",
      });
    };

    const toggleApiConfig = () => {
      showApiConfig.value = !showApiConfig.value;
    };

    const testConnection = () => {
      if (!url.value) {
        toggleFlashMessage({
          type: "warning",
          text: "Please enter a URL first",
        });
        return;
      }

      axios
        .get(
          addBkendIfProduction(
            url.value,
            outletCode.value
              ? `/api/frontend/preloaders/${outletCode.value}`
              : "/api/frontend/preloaders",
          ),
        )
        .then((response) => {
          if (response.data && response.data.company) {
            toggleFlashMessage({
              type: "success",
              text: "Connection successful! API endpoint is working.",
            });
            appSettings.value = response.data.company;
          } else {
            toggleFlashMessage({
              type: "warning",
              text: "Connection successful but no company data found.",
            });
          }
        })
        .catch((error) => {
          console.error("Connection test failed:", error);
          toggleFlashMessage({
            type: "error",
            text: `Connection failed: ${error.message || "Unknown error"}`,
          });
        });
    };

    const showPrinterContent = (content) => {
      const abbr = JSON.parse(content).join("");
      const len = String(abbr).length;

      if (len === 1) {
        return CONTENT_TYPES[abbr] || "Unknown";
      } else if (len === 2) {
        return CONTENT_TYPES[abbr] || "Unknown";
      } else {
        return "All Orders and Invoices";
      }
    };

    const toggleSystemInfo = () => {
      showSystemInfo.value = !showSystemInfo.value;
    };

    const buildUrlWithOutlet = (base, path) => {
      if (outletCode.value) {
        path = path.endsWith("/") ? path.slice(0, -1) : path;
        return `${base}${path}/${outletCode.value}`;
      }
      return `${base}${path}`;
    };

    return {
      displayMode,
      appSettings,
      printers,
      activePrinters,
      url,
      password,
      invalidPassword,
      isAuthenticating,
      isAuthenticated,
      showApiConfig,
      isSavingPrinter,
      isDeletingPrinter,
      systemInfo,
      showSystemInfo,
      outletCode,

      selectedPrinter,
      selectedPrinterId,
      printerIpAddress,
      printerPort,
      printerType,
      printerInterface,
      content,

      printerForm,

      roundsUrl,

      isLoading,
      isFetching,
      isPrinterFetching,

      hasFlashMessage,
      message,

      DISPLAY_MODES,
      PRINTER_TYPES,
      PRINTER_INTERFACES,

      resetForm,
      setPrinter,
      showPrinterForm,
      showPrinterContent,
      handleCancel,
      deletePrinter,
      handleLogin,
      handleLogout,
      testConnection,
      toggleApiConfig,
      toggleSystemInfo,
      loadSystemInfo,
      startFetching,
      stopFetching,
      resumeFetching,
      toggleFlashMessage,
      buildUrlWithOutlet,
    };
  },
};

(function () {
  document.body.classList.remove("dark-mode");
})();

createApp(App).mount("#app");
