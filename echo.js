import Echo from "laravel-echo";
import Pusher from "pusher-js";

if (typeof window !== "undefined") {
  window.Pusher = Pusher;
} else {
  global.Pusher = Pusher;
}

const isElectron = typeof window !== "undefined" && window.electronAPI;

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

const listeners = new Map();

function normalizeEvent(eventName) {
  return eventName.startsWith(".") ? eventName : `.${eventName}`;
}

function tenantChannelName(tenantId, channel) {
  return `tenant.${tenantId}.${channel}`;
}

export function listenTenantChannel(tenantId, channel, eventName, callback) {
  const channelName = tenantChannelName(tenantId, channel);
  const event = normalizeEvent(eventName);
  const key = `${channelName}:${event}`;

  if (listeners.has(key)) return;

  const echoChannel = echo.channel(channelName);
  echoChannel.listen(event, callback);

  listeners.set(key, {
    channelName,
    event,
    callback,
  });
}

export function stopListeningTenantEvent(tenantId, channel, eventName) {
  const channelName = tenantChannelName(tenantId, channel);
  const event = normalizeEvent(eventName);
  const key = `${channelName}:${event}`;

  const entry = listeners.get(key);
  if (!entry) return;

  echo.channel(channelName).stopListening(event, entry.callback);
  listeners.delete(key);
}

export function stopListeningTenantChannel(tenantId, channel) {
  const channelName = tenantChannelName(tenantId, channel);

  for (const [key, entry] of listeners.entries()) {
    if (entry.channelName === channelName) {
      echo.channel(channelName).stopListening(entry.event, entry.callback);
      listeners.delete(key);
    }
  }
}

export function leaveTenantChannel(tenantId, channel) {
  stopListeningTenantChannel(tenantId, channel);
  echo.leave(tenantChannelName(tenantId, channel));
}
