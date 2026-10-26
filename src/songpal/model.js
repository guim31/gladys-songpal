// -----------------------------------------------------------------------------
// What the answers of the Audio Control API mean, as plain objects: identity,
// power, volume, inputs, sound settings and what plays. Pure functions, no
// network: test/model.test.js feeds them the fixtures.
// -----------------------------------------------------------------------------

/** A MAC address as 12 lowercase hex digits, or null. */
export function normalizeMac(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || /^0+$/.test(hex) || /^f+$/.test(hex)) {
    return null;
  }
  return hex;
}

/** `aa:bb:cc:dd:ee:ff` for display. */
export const formatMac = (hex) => hex.match(/../g).join(':');

/**
 * The identity of a device out of `getSystemInformation`: every hardware
 * address it gives, and the one its Gladys ids are built on (the wired MAC,
 * else the Wi-Fi one, else the serial number) — never an IP address.
 * @returns {{ platformId: string, macs: string[], serial: string|null, firmware: string|null }|null}
 */
export function parseIdentity(sysinfo = {}) {
  const wired = normalizeMac(sysinfo.macAddr);
  const wireless = normalizeMac(sysinfo.wirelessMacAddr);
  const serial =
    typeof sysinfo.serialNumber === 'string' && /^[\w-]{4,40}$/.test(sysinfo.serialNumber.trim())
      ? sysinfo.serialNumber.trim()
      : null;
  const macs = [wired, wireless].filter(Boolean);
  const platformId = wired
    ? `mac-${wired}`
    : wireless
      ? `mac-${wireless}`
      : serial
        ? `sn-${serial.toLowerCase()}`
        : null;
  if (!platformId) {
    return null;
  }
  return {
    platformId,
    macs,
    serial,
    firmware: typeof sysinfo.version === 'string' ? sysinfo.version.slice(0, 40) : null,
  };
}

/** Do two identities describe the same hardware (a MAC or the serial in common)? */
export function sameHardware(a, b) {
  if (!a || !b) {
    return false;
  }
  if (a.platformId === b.platformId) {
    return true;
  }
  if ((a.macs ?? []).some((mac) => (b.macs ?? []).includes(mac))) {
    return true;
  }
  return Boolean(a.serial && a.serial === b.serial);
}

/** Model and product kind out of `getInterfaceInformation`. */
export function parseInterface(info = {}) {
  const clean = (value) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : null;
  return {
    model: clean(info.modelName),
    product: clean(info.productName),
    category: clean(info.productCategory),
  };
}

/** `'active'` (on), `'standby'`, `'off'`… as the device says. */
export function parsePower(power = {}) {
  return typeof power.status === 'string' ? power.status : null;
}

export const isOn = (power) => power === 'active';

const toNumber = (value) => {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
};

/**
 * The volume of the main output: the entry without output (sound bars,
 * speakers) or the main zone of a receiver, else the first one.
 * @returns {{ output: string, volume: number, mute: boolean, min: number, max: number, step: number }|null}
 */
export function parseVolume(list = []) {
  const entries = list.filter((entry) => toNumber(entry.volume) !== null);
  const main =
    entries.find((entry) => !entry.output) ??
    entries.find((entry) => /zone=1$/.test(entry.output)) ??
    entries[0];
  if (!main) {
    return null;
  }
  const min = toNumber(main.minVolume) ?? 0;
  const max = toNumber(main.maxVolume) ?? 100;
  return {
    output: typeof main.output === 'string' ? main.output : '',
    volume: Math.round(toNumber(main.volume)),
    mute: main.mute === 'on' || main.mute === true,
    min: Math.round(min),
    max: Math.round(max > min ? max : min + 1),
    step: Math.max(1, Math.round(toNumber(main.step) ?? 1)),
  };
}

/**
 * The inputs of the device, in its order: HDMI, TV (eARC/ARC), optical,
 * analog, Bluetooth… The output zones of receivers and the hidden entries
 * (no title) are left out. The name is the label set on the device, else its
 * title.
 * @returns {Array<{ uri: string, name: string, connection: string|null, active: boolean }>}
 */
export function parseSources(terminals = []) {
  const sources = [];
  for (const terminal of terminals) {
    const meta = typeof terminal.meta === 'string' ? terminal.meta : '';
    const uri = typeof terminal.uri === 'string' ? terminal.uri.trim() : '';
    const title = typeof terminal.title === 'string' ? terminal.title.trim() : '';
    const label = typeof terminal.label === 'string' ? terminal.label.trim() : '';
    if (!uri || !title || meta.includes('meta:zone:output') || uri.startsWith('extOutput:')) {
      continue;
    }
    if (sources.some((source) => source.uri === uri)) {
      continue;
    }
    sources.push({
      uri,
      name: (label || title).slice(0, 40),
      connection: typeof terminal.connection === 'string' ? terminal.connection : null,
      active: terminal.active === 'active',
    });
  }
  return sources;
}

/**
 * What plays on the main output. Titles, times and artwork only exist for a
 * network, USB or Bluetooth source (an input such as HDMI or TV has none);
 * the times are in ms (`durationMsec`, `positionMsec`), some firmwares give
 * seconds (`durationSec`, `positionSec`). The artwork is `content.thumbnailUrl`
 * (Cast, Spotify, radio), rarely given.
 * @returns {{ uri: string|null, kind: string|null, state: string|null, title: string|null,
 *   artist: string|null, album: string|null, durationMs: number|null, positionMs: number|null,
 *   artworkUrl: string|null }|null}
 */
export function parsePlaying(list = []) {
  const main = list.find((entry) => !entry.output) ?? list[0];
  if (!main) {
    return null;
  }
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const ms = (msec, sec) => {
    const value = toNumber(msec) ?? (toNumber(sec) === null ? null : toNumber(sec) * 1000);
    return value === null || value < 0 ? null : Math.round(value);
  };
  const artwork = text(main.content?.thumbnailUrl);
  return {
    uri: text(main.uri),
    kind: text(main.contentKind) ?? text(main.kind),
    state: text(main.stateInfo?.state),
    title: text(main.title),
    artist: text(main.artist),
    album: text(main.albumName),
    durationMs: ms(main.durationMsec, main.durationSec),
    positionMs: ms(main.positionMsec, main.positionSec),
    artworkUrl: artwork && /^https?:\/\//i.test(artwork) ? artwork : null,
  };
}

/**
 * The input in use: the one that plays, else the one the device marks
 * active. Null on a network source (Spotify, Chromecast, USB…).
 */
export function currentSourceUri(playing, sources = []) {
  if (playing?.uri) {
    const exact = sources.find((source) => source.uri === playing.uri);
    if (exact) {
      return exact.uri;
    }
    if (!playing.uri.startsWith('extInput:')) {
      return null;
    }
  }
  return sources.find((source) => source.active)?.uri ?? null;
}

// --- Sound settings ------------------------------------------------------------

const parseCandidate = (candidate = {}) => ({
  value: typeof candidate.value === 'string' ? candidate.value : null,
  title: typeof candidate.title === 'string' ? candidate.title.trim().slice(0, 40) : '',
  available: candidate.isAvailable !== false,
  min: toNumber(candidate.min),
  max: toNumber(candidate.max),
  step: toNumber(candidate.step),
});

/**
 * Settings by target (`soundField`, `nightMode`, `voice`, `subwooferLevel`…),
 * from `getSoundSettings` or `getSpeakerSettings`.
 * @param {Array} list
 * @param {'sound'|'speaker'} api where the setting lives, for its setter
 */
export function parseSettings(list = [], api = 'sound') {
  const settings = {};
  for (const entry of list) {
    if (typeof entry?.target !== 'string' || entry.type === 'directory') {
      continue;
    }
    settings[entry.target] = {
      target: entry.target,
      api,
      type: typeof entry.type === 'string' ? entry.type : null,
      title: typeof entry.title === 'string' ? entry.title.trim().slice(0, 40) : '',
      value:
        typeof entry.currentValue === 'string' || typeof entry.currentValue === 'number'
          ? String(entry.currentValue)
          : null,
      available: entry.isAvailable !== false,
      candidates: (Array.isArray(entry.candidate) ? entry.candidate : []).map(parseCandidate),
    };
  }
  return settings;
}

const ON_OFF = new Set(['on', 'off']);

/** A setting with exactly the values on and off. */
export function isOnOff(setting) {
  if (!setting) {
    return false;
  }
  const values = setting.candidates.map((candidate) => candidate.value?.toLowerCase());
  if (values.length === 0) {
    return setting.type === 'booleanTarget';
  }
  return values.length === 2 && values.every((value) => ON_OFF.has(value));
}

/**
 * The choices of an enum setting: `[{ value, label }]`. Those the device
 * marks unavailable now are kept: availability follows the input (no
 * surround on Bluetooth), and the list of a Gladys select should not flicker.
 */
export function choicesOf(setting) {
  if (!setting) {
    return [];
  }
  const choices = [];
  for (const candidate of setting.candidates) {
    if (!candidate.value || choices.some((c) => c.value === candidate.value)) {
      continue;
    }
    choices.push({ value: candidate.value, label: candidate.title || candidate.value });
  }
  return choices;
}

/** Bounds of a numeric setting (`integerTarget`, `doubleNumberTarget`). */
export function rangeOf(setting) {
  const candidate = setting?.candidates.find(
    (item) => item.min !== null && item.max !== null && item.max > item.min,
  );
  if (!candidate) {
    return null;
  }
  return {
    min: Math.floor(candidate.min),
    max: Math.ceil(candidate.max),
    step: candidate.step && candidate.step > 0 ? candidate.step : 1,
  };
}

/** Normalize a typed name for comparison: case, accents, spaces, punctuation. */
export const simplify = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * An item of a list by what a user typed: its value (uri) or its name, case,
 * accents and spaces ignored; else a name that starts with it.
 */
export function findByName(
  items,
  typed,
  nameOf = (item) => item.name,
  valueOf = (item) => item.uri,
) {
  const wanted = simplify(typed);
  if (!wanted) {
    return null;
  }
  return (
    items.find((item) => valueOf(item) === String(typed).trim()) ??
    items.find((item) => simplify(nameOf(item)) === wanted) ??
    items.find((item) => simplify(valueOf(item)) === wanted) ??
    items.find((item) => simplify(nameOf(item)).startsWith(wanted)) ??
    null
  );
}
