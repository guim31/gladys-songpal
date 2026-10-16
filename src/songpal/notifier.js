// -----------------------------------------------------------------------------
// Real-time notifications of one device, over WebSocket.
//
// The device pushes its changes (power, volume, settings, source) on a
// WebSocket per service (`ws://<ip>:10000/sony/<service>`) once
// `switchNotifications` enabled them on that socket. The connection is
// outgoing (container → device), so it crosses the bridge network like the
// HTTP calls. Which notifications each service sends comes from
// `getSupportedApiInfo` (src/songpal/client.js).
//
// A socket that closes, never opens or refuses the subscription is opened
// again later (10 s, doubled up to 5 min); meanwhile the hub keeps reading the
// device on its timer, the notifications only make the changes immediate.
// Node's built-in WebSocket client (Node 22+): no dependency.
// -----------------------------------------------------------------------------

// The notifications the hub uses; any other one is not enabled.
export const HANDLED_NOTIFICATIONS = new Set([
  'notifyPowerStatus',
  'notifyVolumeInformation',
  'notifySettingsUpdate',
  'notifyPlayingContentInfo',
  'notifyExternalTerminalStatus',
]);

export const NOTIFIER_TIMINGS = {
  connectTimeoutMs: 5_000,
  firstRetryMs: 10_000,
  maxRetryMs: 5 * 60_000,
};

const SUBSCRIBE_ID = 1;

/**
 * The services worth a socket: they list notifications this integration
 * handles, `switchNotifications`, and (when they say) the WebSocket protocol.
 * @param {object} services parsed `getSupportedApiInfo`
 * @returns {Array<{ service: string, notifications: Array<{ name, version }> }>}
 */
export function subscriptionsOf(services = {}) {
  const subscriptions = [];
  for (const [service, info] of Object.entries(services)) {
    const notifications = (info.notifications ?? []).filter((notification) =>
      HANDLED_NOTIFICATIONS.has(notification.name),
    );
    const protocols = info.protocols ?? [];
    if (
      notifications.length === 0 ||
      !info.apis?.switchNotifications ||
      (protocols.length > 0 && !protocols.includes('websocket:jsonizer'))
    ) {
      continue;
    }
    subscriptions.push({ service, notifications });
  }
  return subscriptions;
}

export class Notifier {
  /**
   * @param {object} options
   * @param {string} options.endpoint `http://host:10000/sony`
   * @param {Array} options.subscriptions from subscriptionsOf()
   * @param {(name: string, params: object, service: string) => void} options.onEvent
   * @param {(connected: boolean) => void} [options.onStatus] all sockets subscribed, or not
   * @param {typeof WebSocket} [options.WebSocketImpl]
   * @param {object} [options.timings] NOTIFIER_TIMINGS overrides
   */
  constructor({ endpoint, subscriptions, onEvent, onStatus, WebSocketImpl, timings }) {
    this.base = endpoint.replace(/^http:/, 'ws:').replace(/\/+$/, '');
    this.subscriptions = subscriptions;
    this.onEvent = onEvent;
    this.onStatus = onStatus ?? (() => {});
    this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket;
    this.timings = { ...NOTIFIER_TIMINGS, ...timings };
    this.sockets = new Map();
    this.stopped = true;
    this.lastStatus = false;
  }

  /** Every socket is open and subscribed. */
  get connected() {
    return this.sockets.size > 0 && [...this.sockets.values()].every((socket) => socket.subscribed);
  }

  start() {
    if (!this.stopped || typeof this.WebSocketImpl !== 'function') {
      return;
    }
    this.stopped = false;
    for (const subscription of this.subscriptions) {
      const socket = {
        ...subscription,
        ws: null,
        subscribed: false,
        delay: this.timings.firstRetryMs,
        timer: null,
      };
      this.sockets.set(subscription.service, socket);
      this.open(socket);
    }
  }

  stop() {
    this.stopped = true;
    for (const socket of this.sockets.values()) {
      clearTimeout(socket.timer);
      socket.timer = null;
      this.close(socket);
    }
    this.sockets.clear();
    this.report();
  }

  /**
   * The device answers again (a read succeeded): open now the sockets that
   * wait for their next try, instead of up to 5 minutes later.
   */
  reconnectNow() {
    if (this.stopped) {
      return;
    }
    for (const socket of this.sockets.values()) {
      if (!socket.subscribed && !socket.ws && socket.timer) {
        clearTimeout(socket.timer);
        socket.timer = null;
        socket.delay = this.timings.firstRetryMs;
        this.open(socket);
      }
    }
  }

  report() {
    const connected = this.connected;
    if (connected !== this.lastStatus) {
      this.lastStatus = connected;
      this.onStatus(connected);
    }
  }

  close(socket) {
    const ws = socket.ws;
    socket.ws = null;
    socket.subscribed = false;
    if (ws) {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
  }

  retry(socket) {
    this.close(socket);
    this.report();
    if (this.stopped || socket.timer) {
      return;
    }
    const delay = socket.delay;
    socket.delay = Math.min(socket.delay * 2, this.timings.maxRetryMs);
    socket.timer = setTimeout(() => {
      socket.timer = null;
      this.open(socket);
    }, delay);
    socket.timer.unref?.();
  }

  open(socket) {
    if (this.stopped) {
      return;
    }
    let ws;
    try {
      ws = new this.WebSocketImpl(`${this.base}/${socket.service}`);
    } catch {
      this.retry(socket);
      return;
    }
    socket.ws = ws;
    const current = () => socket.ws === ws && !this.stopped;
    const opening = setTimeout(() => {
      if (current() && !socket.subscribed) {
        this.retry(socket);
      }
    }, this.timings.connectTimeoutMs);
    opening.unref?.();

    ws.addEventListener('open', () => {
      if (!current()) {
        return;
      }
      ws.send(
        JSON.stringify({
          method: 'switchNotifications',
          id: SUBSCRIBE_ID,
          params: [{ enabled: socket.notifications }],
          version: '1.0',
        }),
      );
    });
    ws.addEventListener('message', (event) => {
      if (!current()) {
        return;
      }
      let message;
      try {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message?.id === SUBSCRIBE_ID && !message.method) {
        clearTimeout(opening);
        if (Array.isArray(message.result)) {
          socket.subscribed = true;
          socket.delay = this.timings.firstRetryMs;
          this.report();
        } else {
          // Subscription refused: try again later, at the slowest pace.
          socket.delay = this.timings.maxRetryMs;
          this.retry(socket);
        }
        return;
      }
      if (typeof message?.method === 'string' && HANDLED_NOTIFICATIONS.has(message.method)) {
        const params = Array.isArray(message.params) ? message.params[0] : message.params;
        this.onEvent(
          message.method,
          params && typeof params === 'object' ? params : {},
          socket.service,
        );
      }
    });
    const lost = () => {
      clearTimeout(opening);
      if (current()) {
        this.retry(socket);
      }
    };
    ws.addEventListener('close', lost);
    ws.addEventListener('error', lost);
  }
}
