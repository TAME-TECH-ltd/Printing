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
  const isFetching = ref(false);
  const fetchInterval = ref(null);
  const isActive = ref(false);

  const startFetching = (meta = null) => {
    if (!isActive.value) return;

    const roundsUrl = url.value ? "next-printable-round" : null;
    if (!roundsUrl || !activePrinters.value.length) return;

    let _url = url.value
      ? outletCode.value
        ? addBkendIfProduction(
            url.value,
            `/api/${roundsUrl}/${outletCode.value}`,
          )
        : addBkendIfProduction(url.value, `/api/${roundsUrl}`)
      : null;
    if (meta) {
      const filters = {};
      if (meta.latest) filters.latest = meta.latest;
      if (meta.content) filters.content = meta.content;
      _url = encodeQuery(_url, filters);
    }

    isFetching.value = true;

    axios
      .get(_url)
      .then((response) => {
        const { status, round, order, items } = response.data;
        if (status) {
          const printer = activePrinters.value[0];
          if (printer) {
            const _content = JSON.parse(printer.content);
            const data = {
              printer: printer.name,
              type: printer.type,
              interface: printer.interface,
              port: printer.port,
              ip: printer.ip,
              round: round,
              items: items,
              order: order,
              settings: { ...appSettings.value },
              content: _content.join(""),
            };
            window.electronAPI.invoke("print-content", data).catch((error) => {
              console.error("Print error:", error);
            });
          }
        } else {
          if (round) {
            axios.get(
              `${url.value}/bkend/api/update-printed-round/${round.id}`,
            );
          }
          scheduleNextFetch(meta);
        }
      })
      .catch(() => {
        isFetching.value = false;
        scheduleNextFetch(meta, 3000);
      })
      .finally(() => {
        isFetching.value = false;
      });
  };

  const scheduleNextFetch = (meta = null, delay = 2000) => {
    if (fetchInterval.value) {
      clearTimeout(fetchInterval.value);
    }
    fetchInterval.value = setTimeout(() => {
      if (isActive.value) {
        startFetching(meta);
      }
    }, delay);
  };

  const stopFetching = () => {
    isActive.value = false;
    if (fetchInterval.value) {
      clearTimeout(fetchInterval.value);
      fetchInterval.value = null;
    }
  };

  const resumeFetching = (meta = null) => {
    isActive.value = true;
    startFetching(meta);
  };

  return {
    isFetching,
    startFetching,
    stopFetching,
    resumeFetching,
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
    const { isFetching, startFetching, stopFetching, resumeFetching } =
      useFetchingService(url, activePrinters, appSettings, outletCode);

    const roundsUrl = computed(() => {
      return url.value ? "next-printable-round" : null;
    });

    const eventHandlers = {
      printersList: (_printers) => {
        printers.value = _printers;
      },

      printedContent: (meta) => {
        setTimeout(() => resumeFetching(meta), 3000);
      },

      retryPrinting: (data) => {
        window.electronAPI.invoke("print-content", data).catch((error) => {
          console.error("Print retry failed:", error);
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
        toggleFlashMessage({
          type: "error",
          text: `Printing failed: ${errorInfo.message}. Check system compatibility.`,
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

    onMounted(() => {
      isAuthenticated.value = false; // Always skip login for now
      console.log(
        "Tame Print Service loaded. Login skipped for development mode.",
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
