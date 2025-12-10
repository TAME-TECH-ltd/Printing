import Echo from "laravel-echo";
import Pusher from "pusher-js";

window.Pusher = Pusher;

const wsHost = import.meta.env.VITE_REVERB_HOST || window.location.hostname;
const isProd = import.meta.env.PROD;
const forceTLS = (import.meta.env.VITE_REVERB_SCHEME || "http") === "https";
const wsPort = isProd ? "" : import.meta.env.VITE_REVERB_PORT;
export const echo = new Echo({
  broadcaster: "pusher",
  key: import.meta.env.VITE_REVERB_APP_KEY,
  wsHost,
  wsPort,
  wssPort: forceTLS ? 443 : wsPort,
  forceTLS,
  enabledTransports: forceTLS ? ["wss"] : ["ws"],
  cluster: "mt1",
  disableStats: true,
  withCredentials: true,
});

export function listenTenantChannel(tenantId, channel, eventName, callback) {
  return echo
    .channel(`tenant.${tenantId}.${channel}`)
    .listen(eventName.startsWith(".") ? eventName : `.${eventName}`, callback);
}
