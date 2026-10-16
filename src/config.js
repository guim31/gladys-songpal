// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// Most devices are found by the search of the Discovery tab (SSDP through the
// core). The `hosts` field only lists the devices the search cannot see (an
// other subnet, a router that drops multicast): their addresses, separated by
// commas. The address only says where to reach a device: its identity is the
// MAC address it gives (src/devices.js).
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Refresh intervals offered in the configuration, in seconds. While a device
// sends its notifications (WebSocket), it is read far less often (src/hub.js).
export const POLL_INTERVALS = ['10', '30', '60', '300'];

// Steps of the volume buttons of the widget, in volume units of the device.
export const VOLUME_STEPS = ['1', '2', '5'];

export const DEFAULT_CONFIG = {
  hosts: '',
  poll_interval: '30',
  volume_step: '2',
  language: 'fr',
};

// The Audio Control API listens on this port, under /sony.
export const DEFAULT_PORT = 10000;
export const MAX_HOSTS = 10;

/**
 * Parse one address typed by the user into the base URL of the API: a bare
 * host or IP (`192.0.2.10`, `192.0.2.10:10000`) or a URL
 * (`http://192.0.2.10:10000/sony`). Port 10000 and path /sony by default.
 * @param {unknown} raw
 * @returns {string|null} `http://host:port/sony`, null when unusable
 */
export function parseEndpoint(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text);
  let url;
  try {
    url = new URL(hasScheme ? text : `http://${text}`);
  } catch {
    return null;
  }
  // The API is plain HTTP; credentials in the address would end up in the
  // logs and the device params.
  if (url.protocol !== 'http:' || !url.hostname || url.username || url.password) {
    return null;
  }
  const port = url.port || String(DEFAULT_PORT);
  const path = url.pathname.replace(/\/+$/, '') || '/sony';
  return `http://${url.hostname}:${port}${path}`;
}

/** The host part of an endpoint, as shown to the user (`192.0.2.10`). */
export function hostOf(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return String(endpoint);
  }
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const pick = (key, list) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return list.includes(value) ? value : DEFAULT_CONFIG[key];
  };

  const hosts = [];
  const invalidHosts = [];
  const typed = typeof source.hosts === 'string' ? source.hosts : '';
  for (const entry of typed.split(/[\s,;]+/)) {
    if (!entry) {
      continue;
    }
    const endpoint = parseEndpoint(entry);
    if (!endpoint) {
      invalidHosts.push(entry.slice(0, 60));
    } else if (!hosts.includes(endpoint) && hosts.length < MAX_HOSTS) {
      hosts.push(endpoint);
    }
  }

  return {
    hosts,
    invalidHosts,
    pollIntervalMs: Number(pick('poll_interval', POLL_INTERVALS)) * 1000,
    volumeStep: Number(pick('volume_step', VOLUME_STEPS)),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
