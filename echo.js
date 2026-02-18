import Echo from "./node_modules/laravel-echo/dist/echo.js";

let echoInstance = null;
const listeners = new Map();

function normalizeEvent(eventName) {
  return eventName.startsWith(".") ? eventName : `.${eventName}`;
}

function tenantChannelName(tenantId, channel) {
  return `tenant.${tenantId}.${channel}`;
}

function parseBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl);
  } catch {
    return null;
  }
}

function resolveEchoConfig(options = {}) {
  const parsedUrl = parseBaseUrl(options.baseUrl || "");
  const scheme =
    options.scheme || parsedUrl?.protocol?.replace(":", "") || "http";
  const forceTLS = scheme === "https";
  const wsHost = options.wsHost || parsedUrl?.hostname || "localhost";
  const wsPort = Number(options.wsPort || (forceTLS ? 443 : 6001));

  return {
    broadcaster: options.broadcaster || "reverb",
    key: options.key,
    wsHost,
    wsPort,
    wssPort: forceTLS ? 443 : wsPort,
    forceTLS,
    authEndpoint:
      options.authEndpoint ||
      `${forceTLS ? "https" : "http"}://${wsHost}/broadcasting/auth`,
  };
}

export function disconnectEcho() {
  if (echoInstance) {
    try {
      echoInstance.disconnect();
    } catch (error) {
      console.error("Echo disconnect failed:", error);
    }
  }

  listeners.clear();
  echoInstance = null;
}

export function configureEcho(options = {}) {
  const config = resolveEchoConfig(options);

  if (!config.key) {
    console.error("Missing websocket key. Echo will not be configured.");
    return null;
  }

  if (typeof window === "undefined" || !window.Pusher) {
    console.error("Pusher is not available on window. Echo cannot connect.");
    return null;
  }

  disconnectEcho();

  echoInstance = new Echo({
    broadcaster: config.broadcaster,
    key: config.key,
    wsHost: config.wsHost,
    wsPort: config.wsPort,
    wssPort: config.wssPort,
    forceTLS: config.forceTLS,
    enabledTransports: config.forceTLS ? ["wss"] : ["ws"],
    cluster: "mt1",
    disableStats: true,
    Pusher: window.Pusher,
    authorizer: (channel) => {
      return {
        authorize: (socketId, callback) => {
          fetch(config.authEndpoint, {
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

  return echoInstance;
}

export function listenTenantChannel(tenantId, channel, eventName, callback) {
  if (!echoInstance || !tenantId) return;

  const channelName = tenantChannelName(tenantId, channel);
  const event = normalizeEvent(eventName);
  const key = `${channelName}:${event}`;

  if (listeners.has(key)) return;

  const echoChannel = echoInstance.channel(channelName);
  echoChannel.listen(event, callback);

  listeners.set(key, {
    channelName,
    event,
    callback,
  });
}

export function stopListeningTenantEvent(tenantId, channel, eventName) {
  if (!echoInstance || !tenantId) return;

  const channelName = tenantChannelName(tenantId, channel);
  const event = normalizeEvent(eventName);
  const key = `${channelName}:${event}`;

  const entry = listeners.get(key);
  if (!entry) return;

  echoInstance.channel(channelName).stopListening(event, entry.callback);
  listeners.delete(key);
}

export function stopListeningTenantChannel(tenantId, channel) {
  if (!echoInstance || !tenantId) return;

  const channelName = tenantChannelName(tenantId, channel);

  for (const [key, entry] of listeners.entries()) {
    if (entry.channelName === channelName) {
      echoInstance
        .channel(channelName)
        .stopListening(entry.event, entry.callback);
      listeners.delete(key);
    }
  }
}

export function leaveTenantChannel(tenantId, channel) {
  if (!echoInstance || !tenantId) return;

  stopListeningTenantChannel(tenantId, channel);
  echoInstance.leave(tenantChannelName(tenantId, channel));
}
