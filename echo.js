import Echo from "laravel-echo";
import Pusher from "pusher-js";

// For Electron, we need to handle window object carefully
if (typeof window !== "undefined") {
  window.Pusher = Pusher;
} else {
  global.Pusher = Pusher;
}

// Electron-specific configuration
const isElectron = typeof window !== "undefined" && window.electronAPI;

// Get environment variables - Use the new getBroadcastConfig method
const config = isElectron
  ? window.electronAPI.getBroadcastConfig()
  : {
      VITE_REVERB_HOST: import.meta.env.VITE_REVERB_HOST || "localhost",
      VITE_REVERB_PORT: import.meta.env.VITE_REVERB_PORT || "8080",
      VITE_REVERB_APP_KEY: import.meta.env.VITE_REVERB_APP_KEY,
      VITE_REVERB_SCHEME: import.meta.env.VITE_REVERB_SCHEME || "http",
      VITE_APP_ENV: import.meta.env.VITE_APP_ENV || "development",
      VITE_AUTH_ENDPOINT: import.meta.env.VITE_AUTH_ENDPOINT,
    };

const wsHost = config.VITE_REVERB_HOST;
const isProd = config.VITE_APP_ENV === "production";
const forceTLS = config.VITE_REVERB_SCHEME === "https";
const wsPort = isProd ? "" : config.VITE_REVERB_PORT;

export const echo = new Echo({
  broadcaster: "pusher",
  key: config.VITE_REVERB_APP_KEY,
  wsHost,
  wsPort,
  wssPort: forceTLS ? 443 : wsPort,
  forceTLS,
  enabledTransports: forceTLS ? ["wss"] : ["ws"],
  cluster: "mt1",
  disableStats: true,
  authorizer: (channel, options) => {
    return {
      authorize: (socketId, callback) => {
        const authEndpoint =
          config.VITE_AUTH_ENDPOINT ||
          `${forceTLS ? "https" : "http"}://${wsHost}/broadcasting/auth`;

        fetch(authEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            socket_id: socketId,
            channel_name: channel.name,
          }),
        })
          .then((response) => response.json())
          .then((data) => callback(null, data))
          .catch((error) => callback(error));
      },
    };
  },
});

export function listenTenantChannel(tenantId, channel, eventName, callback) {
  return echo
    .channel(`tenant.${tenantId}.${channel}`)
    .listen(eventName.startsWith(".") ? eventName : `.${eventName}`, callback);
}

// Optional: Add cleanup for Electron
if (isElectron) {
  window.addEventListener("beforeunload", () => {
    echo.disconnect();
  });
}
