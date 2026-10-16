// -----------------------------------------------------------------------------
// Client of the Sony Audio Control API ("Songpal") of one device: JSON-RPC
// over HTTP, `POST http://<ip>:10000/sony/<service>` with the body
// `{ method, id, params: [...], version }`, the answer being
// `{ id, result: [...] }` or `{ id, error: [code, message] }` (HTTP 200 both).
// No authentication: the API is open to the local network.
//
// The `guide` service describes the device (`getSupportedApiInfo`): its
// services, the versions of each method and the notifications it can send.
// The client reads it first and calls each method in the newest version it
// knows among those the device lists, so one code serves the sound bars, the
// receivers and the speakers of several generations.
//
// Every failure is a SongpalError with a `kind` (ERROR_KINDS): the hub decides
// what each one means for the user.
// (Protocol: Sony Audio Control API reference, developer.sony.com; read in
// python-songpal, GPL-3.0, github.com/rytilahti/python-songpal, for its use —
// this is an independent implementation.)
// -----------------------------------------------------------------------------

import { httpRequest } from './http.js';

export const ERROR_KINDS = Object.freeze({
  // No answer: the device is off with its network asleep, or not there.
  UNREACHABLE: 'unreachable',
  // Something answers, but not the Audio Control API.
  NOT_SONGPAL: 'not_songpal',
  // The device cannot do it now (error 7: in standby, another source…).
  ILLEGAL_STATE: 'illegal_state',
  // The device does not have this method or version (errors 12, 14, 15).
  UNSUPPORTED: 'unsupported',
  // Any other error of the API, its code in `code`.
  API: 'api',
});

// Error codes of the Audio Control API (Sony reference, "Error codes").
export const ERROR_CODES = Object.freeze({
  ANY: 1,
  TIMEOUT: 2,
  ILLEGAL_ARGUMENT: 3,
  ILLEGAL_REQUEST: 5,
  ILLEGAL_STATE: 7,
  NO_SUCH_METHOD: 12,
  UNSUPPORTED_VERSION: 14,
  UNSUPPORTED_OPERATION: 15,
  // Answered by setPowerStatus when the device is already in that state.
  REQUEST_RETRY: 40000,
});

export class SongpalError extends Error {
  /**
   * @param {string} kind ERROR_KINDS
   * @param {string} message
   * @param {number|null} [code] error code of the API
   */
  constructor(kind, message, code = null) {
    super(message);
    this.name = 'SongpalError';
    this.kind = kind;
    this.code = code;
  }
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
]);

// The services this integration uses.
export const SERVICES = ['guide', 'system', 'audio', 'avContent'];

// The versions this client knows for each method, newest first.
const VERSIONS = {
  'guide.getSupportedApiInfo': ['1.0'],
  'system.getPowerStatus': ['1.1', '1.0'],
  'system.setPowerStatus': ['1.1', '1.0'],
  'system.getSystemInformation': ['1.4', '1.3', '1.2', '1.1', '1.0'],
  'system.getInterfaceInformation': ['1.0'],
  'audio.getVolumeInformation': ['1.1', '1.0'],
  'audio.setAudioVolume': ['1.1', '1.0'],
  'audio.setAudioMute': ['1.1', '1.0'],
  'audio.getSoundSettings': ['1.1', '1.0'],
  'audio.setSoundSettings': ['1.1', '1.0'],
  'audio.getSpeakerSettings': ['1.0'],
  'audio.setSpeakerSettings': ['1.0'],
  'avContent.getCurrentExternalTerminalsStatus': ['1.0', '1.2'],
  'avContent.getPlayingContentInfo': ['1.2', '1.0'],
  'avContent.setPlayContent': ['1.2', '1.0'],
  'avContent.pausePlayingContent': ['1.1', '1.0'],
  'avContent.setPlayNextContent': ['1.0'],
  'avContent.setPlayPreviousContent': ['1.0'],
};

/** The first object of a `result` (`[{…}]`). */
const firstOf = (result) =>
  Array.isArray(result) && result[0] && typeof result[0] === 'object' && !Array.isArray(result[0])
    ? result[0]
    : {};

/** The list of a `result`: `[[{…}, {…}]]` (most methods) or `[{…}, {…}]`. */
const listOf = (result) => {
  if (!Array.isArray(result)) {
    return [];
  }
  const list = Array.isArray(result[0]) ? result[0] : result;
  return list.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
};

/**
 * The services, method versions and notifications of `getSupportedApiInfo`.
 * @returns {Record<string, { apis: Record<string, string[]>, notifications: Array<{ name: string, version: string }>, protocols: string[] }>}
 */
export function parseApiInfo(result) {
  const services = {};
  for (const entry of listOf(result)) {
    if (typeof entry.service !== 'string') {
      continue;
    }
    const apis = {};
    for (const api of Array.isArray(entry.apis) ? entry.apis : []) {
      if (typeof api?.name === 'string') {
        apis[api.name] = (Array.isArray(api.versions) ? api.versions : [])
          .map((version) => version?.version)
          .filter((version) => typeof version === 'string');
      }
    }
    const notifications = [];
    for (const notification of Array.isArray(entry.notifications) ? entry.notifications : []) {
      const versions = (Array.isArray(notification?.versions) ? notification.versions : [])
        .map((version) => version?.version)
        .filter((version) => typeof version === 'string')
        .sort(compareVersions);
      if (typeof notification?.name === 'string' && versions.length > 0) {
        notifications.push({ name: notification.name, version: versions.at(-1) });
      }
    }
    services[entry.service] = {
      apis,
      notifications,
      protocols: (Array.isArray(entry.protocols) ? entry.protocols : []).filter(
        (protocol) => typeof protocol === 'string',
      ),
    };
  }
  return services;
}

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export class SongpalClient {
  /**
   * @param {object} options
   * @param {string} options.endpoint `http://host:10000/sony`
   * @param {Function} [options.request] HTTP seam (src/songpal/http.js)
   * @param {number} [options.timeoutMs]
   */
  constructor({ endpoint, request = httpRequest, timeoutMs = 5_000 }) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    /** What `getSupportedApiInfo` said, null until read. */
    this.services = null;
  }

  /**
   * One JSON-RPC call.
   * @returns {Promise<Array>} the `result` array
   */
  async call(service, method, params = [], version = '1.0') {
    const id = this.nextId;
    this.nextId = (this.nextId % 1_000_000) + 1;
    const label = `${service}.${method}`;
    let response;
    try {
      response = await this.request(`${this.endpoint}/${service}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, id, params, version }),
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      // Whatever the network error (refused, timed out, reset), nothing
      // usable answers at this address now.
      const reason = NETWORK_CODES.has(err.code) ? err.code : 'network error';
      throw new SongpalError(ERROR_KINDS.UNREACHABLE, `${label}: no answer (${reason})`);
    }
    let body = null;
    try {
      body = JSON.parse(response.body);
    } catch {
      // Not JSON: handled below.
    }
    if (body && Array.isArray(body.error)) {
      const [code, text] = body.error;
      const message = `${label}: error ${code ?? '?'} (${typeof text === 'string' ? text.slice(0, 80) : '?'})`;
      if (code === ERROR_CODES.ILLEGAL_STATE) {
        throw new SongpalError(ERROR_KINDS.ILLEGAL_STATE, message, code);
      }
      if (
        [
          ERROR_CODES.NO_SUCH_METHOD,
          ERROR_CODES.UNSUPPORTED_VERSION,
          ERROR_CODES.UNSUPPORTED_OPERATION,
        ].includes(code)
      ) {
        throw new SongpalError(ERROR_KINDS.UNSUPPORTED, message, code);
      }
      throw new SongpalError(ERROR_KINDS.API, message, typeof code === 'number' ? code : null);
    }
    if (!body || !Array.isArray(body.result)) {
      throw new SongpalError(
        ERROR_KINDS.NOT_SONGPAL,
        `${label}: not an Audio Control API answer (HTTP ${response.status})`,
      );
    }
    return body.result;
  }

  // --- Description of the device ---------------------------------------------

  /** Read (again) the services, versions and notifications of the device. */
  async readApiInfo() {
    const result = await this.call('guide', 'getSupportedApiInfo', [{}], '1.0');
    const services = parseApiInfo(result);
    if (!services.system) {
      throw new SongpalError(ERROR_KINDS.NOT_SONGPAL, 'guide: no system service listed');
    }
    this.services = services;
    return services;
  }

  /** Does the device list this method (true while the list is unknown)? */
  supports(service, method) {
    if (!this.services) {
      return true;
    }
    return Boolean(this.services[service]?.apis?.[method]);
  }

  /**
   * The version to call: the newest one this client knows among those the
   * device lists, else the newest the device lists (the params of the newest
   * known version are sent). Null when the device does not have the method.
   */
  versionOf(service, method) {
    const known = VERSIONS[`${service}.${method}`] ?? ['1.0'];
    if (!this.services) {
      return known[0];
    }
    const listed = this.services[service]?.apis?.[method];
    if (!listed) {
      return null;
    }
    return (
      known.find((version) => listed.includes(version)) ??
      [...listed].sort(compareVersions).at(-1) ??
      known[0]
    );
  }

  /** Call a method in its best version, with the params of that version. */
  async invoke(service, method, paramsOf) {
    const version = this.versionOf(service, method);
    if (!version) {
      throw new SongpalError(ERROR_KINDS.UNSUPPORTED, `${service}.${method}: not on this device`);
    }
    return this.call(service, method, paramsOf(version), version);
  }

  // --- Reads -------------------------------------------------------------------

  /** `{ status: 'active' | 'standby' | 'off' | …, standbyDetail? }` */
  async getPowerStatus() {
    return firstOf(await this.invoke('system', 'getPowerStatus', () => []));
  }

  /** MAC addresses, serial number, firmware version. */
  async getSystemInformation() {
    return firstOf(await this.invoke('system', 'getSystemInformation', () => []));
  }

  /** `{ productName, modelName, productCategory, interfaceVersion }` */
  async getInterfaceInformation() {
    return firstOf(await this.invoke('system', 'getInterfaceInformation', () => []));
  }

  /** One entry per output (zone): `{ output, volume, mute, minVolume, maxVolume, step }`. */
  async getVolumeInformation() {
    return listOf(
      await this.invoke('audio', 'getVolumeInformation', (v) =>
        v === '1.0' ? [] : [{ output: '' }],
      ),
    );
  }

  /** Every sound setting of the device (`target: ''`), with its candidates. */
  async getSoundSettings() {
    return listOf(await this.invoke('audio', 'getSoundSettings', () => [{ target: '' }]));
  }

  /** The speaker settings (receivers): the subwoofer level lives there. */
  async getSpeakerSettings() {
    return listOf(await this.invoke('audio', 'getSpeakerSettings', () => [{ target: '' }]));
  }

  /** The inputs (and the output zones) of the device. */
  async getExternalTerminals() {
    return listOf(
      await this.invoke('avContent', 'getCurrentExternalTerminalsStatus', (v) =>
        v === '1.0' ? [] : [{}],
      ),
    );
  }

  /** What plays, one entry per output: `{ uri, source, contentKind, stateInfo, … }`. */
  async getPlayingContentInfo() {
    return listOf(
      await this.invoke('avContent', 'getPlayingContentInfo', (v) =>
        v === '1.0' ? [] : [{ output: '' }],
      ),
    );
  }

  // --- Commands ----------------------------------------------------------------

  /** Turn on (`active`) or to standby (`off`); "already so" is a success. */
  async setPower(on) {
    try {
      await this.invoke('system', 'setPowerStatus', () => [{ status: on ? 'active' : 'off' }]);
    } catch (err) {
      if (err.code !== ERROR_CODES.REQUEST_RETRY) {
        throw err;
      }
    }
  }

  async setVolume(output, volume) {
    await this.invoke('audio', 'setAudioVolume', (v) =>
      v === '1.0'
        ? [{ target: output ?? '', volume: String(volume) }]
        : [{ output: output ?? '', volume: String(volume) }],
    );
  }

  async setMute(output, mute) {
    await this.invoke('audio', 'setAudioMute', (v) =>
      v === '1.0'
        ? [{ status: Boolean(mute) }]
        : [{ output: output ?? '', mute: mute ? 'on' : 'off' }],
    );
  }

  /** A sound setting (`getSoundSettings`) or a speaker setting (`getSpeakerSettings`). */
  async setSetting(api, target, value) {
    const method = api === 'speaker' ? 'setSpeakerSettings' : 'setSoundSettings';
    await this.invoke('audio', method, () => [{ settings: [{ target, value: String(value) }] }]);
  }

  async setPlayContent(uri) {
    await this.invoke('avContent', 'setPlayContent', (v) =>
      v === '1.0' ? [{ uri }] : [{ output: '', uri }],
    );
  }

  /** Pause, or resume what is paused (the device toggles). */
  async pausePlayingContent() {
    await this.invoke('avContent', 'pausePlayingContent', (v) =>
      v === '1.0' ? [] : [{ output: '' }],
    );
  }

  async playNext() {
    await this.invoke('avContent', 'setPlayNextContent', () => [{ output: '' }]);
  }

  async playPrevious() {
    await this.invoke('avContent', 'setPlayPreviousContent', () => [{ output: '' }]);
  }
}
