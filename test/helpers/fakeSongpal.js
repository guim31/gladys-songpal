// -----------------------------------------------------------------------------
// An in-memory Sony audio device behind the `request` seam of the client
// (src/songpal/http.js) and a fake WebSocket, built from the answers of the
// fixtures (test/fixtures/songpal/), with the behaviors that matter: standby
// (the reads beyond the power answer error 7), a device whose network sleeps
// (no answer at all), the commands changing its state, and the notifications
// a real device pushes after a change, on the sockets subscribed to them.
//
// The same class serves the end-to-end test over real HTTP and WebSocket
// (songpalServer.js).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/songpal/${name}.json`, import.meta.url), 'utf8'));

const clone = (value) => structuredClone(value);
const json = (body, status = 200) => ({
  status,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const ILLEGAL_STATE = [7, 'Illegal State'];
const NO_SUCH_METHOD = [12, 'No Such Method'];

/** The methods that answer in standby (the others: error 7). */
const STANDBY_METHODS = new Set([
  'guide.getSupportedApiInfo',
  'system.getPowerStatus',
  'system.setPowerStatus',
  'system.getSystemInformation',
  'system.getInterfaceInformation',
]);

export class FakeSongpal {
  /**
   * @param {string} name fixture name (ht-zf9, ht-st5000, srs-x77, str-dn1080, bravia-tv)
   * @param {object} [options]
   * @param {'active'|'standby'} [options.power]
   * @param {string} [options.address] another IP address than the fixture's
   */
  constructor(name = 'ht-zf9', { power = 'active', address } = {}) {
    const profile = fixture(name);
    this.name = name;
    this.address = address ?? profile.address;
    this.location = profile.location.replace(profile.address, this.address);
    this.descriptionXml = profile.description.replaceAll(profile.address, this.address);
    this.responses = clone(profile.responses);
    this.online = true;
    this.power = power;
    const first = (key) => this.responses[key]?.result?.[0];
    this.volumes = clone(first('audio.getVolumeInformation') ?? []);
    this.soundSettings = clone(first('audio.getSoundSettings') ?? []);
    this.speakerSettings = clone(first('audio.getSpeakerSettings') ?? []);
    this.terminals = clone(first('avContent.getCurrentExternalTerminalsStatus') ?? []);
    this.playing = clone(first('avContent.getPlayingContentInfo') ?? []);
    /** Every JSON-RPC call received: `{ service, method, params, version }`. */
    this.calls = [];
    /** Methods made to fail: `service.method` → `[code, message]`. */
    this.failures = new Map();
    /** Open sockets subscribed to notifications. */
    this.sockets = new Set();
    /** Turning on takes this many power reads before `active` (0: at once). */
    this.bootReads = 0;
  }

  get services() {
    return this.responses['guide.getSupportedApiInfo'].result[0];
  }

  commands() {
    return this.calls.filter((call) => /^(set|pause)/.test(call.method));
  }

  // --- State helpers of the tests ----------------------------------------------

  /** The main volume entry. */
  get mainVolume() {
    return this.volumes.find((entry) => !entry.output) ?? this.volumes[0];
  }

  setting(target) {
    return [...this.soundSettings, ...this.speakerSettings].find((item) => item.target === target);
  }

  /** What the remote would do: switch the input, notified. */
  play(uri, state = 'PLAYING') {
    const main = this.playing[0] ?? {};
    const kind = uri.startsWith('extInput:') ? 'input' : 'service';
    this.playing = [
      {
        ...main,
        uri,
        source: uri.split('?')[0],
        contentKind: kind,
        stateInfo: { state },
      },
    ];
    for (const terminal of this.terminals) {
      if (!terminal.meta?.includes('zone')) {
        terminal.active = terminal.uri === uri ? 'active' : 'inactive';
      }
    }
    this.notify('notifyPlayingContentInfo', this.playing[0]);
  }

  /** What plays becomes `entry` (a real notification), notified as it is. */
  setPlaying(entry, notification = entry) {
    this.playing = [clone(entry)];
    this.notify('notifyPlayingContentInfo', clone(notification));
  }

  /** The remote changes the volume, notified. */
  changeVolume(volume, mute) {
    const main = this.mainVolume;
    main.volume = volume;
    if (mute !== undefined) {
      main.mute = mute ? 'on' : 'off';
    }
    this.notify('notifyVolumeInformation', {
      output: main.output,
      volume: main.volume,
      mute: main.mute,
    });
  }

  /** The remote changes a setting, notified. */
  changeSetting(target, value) {
    const setting = this.setting(target);
    setting.currentValue = String(value);
    this.notify('notifySettingsUpdate', {
      titleTextID: '',
      guideTextID: '',
      isAvailable: true,
      type: setting.type,
      title: setting.title,
      apiMappingUpdate: {
        service: 'audio',
        target,
        currentValue: String(value),
        targetSuppl: '',
      },
    });
  }

  /** The power button, notified. */
  pressPower(status) {
    this.power = status;
    this.notify('notifyPowerStatus', { status });
  }

  // --- Notifications ---------------------------------------------------------------

  /** A socket of a service (fake or real) opens: it gets the notifications it enables. */
  attach(service, sink) {
    const socket = { service, sink, enabled: new Set() };
    this.sockets.add(socket);
    return {
      receive: (text) => this.onSocketMessage(socket, text),
      close: () => this.sockets.delete(socket),
    };
  }

  onSocketMessage(socket, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.method !== 'switchNotifications') {
      socket.sink(JSON.stringify({ id: message.id, error: NO_SUCH_METHOD }));
      return;
    }
    const offered = (
      this.services.find((entry) => entry.service === socket.service)?.notifications ?? []
    ).map((item) => item.name);
    const wanted = message.params?.[0]?.enabled ?? [];
    for (const item of wanted) {
      if (offered.includes(item.name)) {
        socket.enabled.add(item.name);
      }
    }
    const all = (names) => names.map((name) => ({ name, version: '1.0' }));
    socket.sink(
      JSON.stringify({
        id: message.id,
        result: [
          {
            enabled: all([...socket.enabled]),
            disabled: all(offered.filter((name) => !socket.enabled.has(name))),
          },
        ],
      }),
    );
  }

  notify(name, params) {
    if (!this.online) {
      return;
    }
    for (const socket of this.sockets) {
      if (socket.enabled.has(name)) {
        socket.sink(JSON.stringify({ method: name, params: [params], version: '1.0' }));
      }
    }
  }

  /** Close every socket, as a device unplugged would. */
  dropSockets() {
    for (const socket of [...this.sockets]) {
      socket.sink(null);
    }
    this.sockets.clear();
  }

  // --- HTTP ------------------------------------------------------------------------

  /**
   * @param {{ url: string, method: string, body?: string }} request
   */
  handle({ url, method, body }) {
    const target = new URL(url);
    if (method === 'GET') {
      if (target.pathname === new URL(this.location).pathname) {
        return { status: 200, headers: { 'content-type': 'text/xml' }, body: this.descriptionXml };
      }
      return { status: 404, headers: {}, body: 'Not Found' };
    }
    const service = target.pathname.replace(/^\/sony\//, '');
    let request;
    try {
      request = JSON.parse(body ?? '');
    } catch {
      return { status: 400, headers: {}, body: 'Bad Request' };
    }
    const key = `${service}.${request.method}`;
    this.calls.push({
      service,
      method: request.method,
      params: request.params,
      version: request.version,
    });
    const id = request.id;
    if (this.failures.has(key)) {
      return json({ id, error: this.failures.get(key) });
    }
    const listed = this.services.find((entry) => entry.service === service);
    if (!listed) {
      return { status: 404, headers: {}, body: 'Not Found' };
    }
    const api = listed.apis.find((item) => item.name === request.method);
    if (!api) {
      return json({ id, error: NO_SUCH_METHOD });
    }
    if (!api.versions.some((item) => item.version === request.version)) {
      return json({ id, error: [14, 'Unsupported Version'] });
    }
    if (this.power !== 'active' && !STANDBY_METHODS.has(key)) {
      return json({ id, error: ILLEGAL_STATE });
    }
    const result = this.answer(key, request.params?.[0] ?? {});
    if (result && result.error) {
      return json({ id, error: result.error });
    }
    return json({ id, result });
  }

  answer(key, params) {
    switch (key) {
      case 'system.getPowerStatus':
        if (this.power === 'booting') {
          this.bootReads -= 1;
          if (this.bootReads <= 0) {
            this.power = 'active';
          }
          return [{ status: 'standby' }];
        }
        return [{ status: this.power }];
      case 'system.setPowerStatus': {
        const status = params.status === 'active' ? 'active' : 'standby';
        if ((status === 'active') === (this.power === 'active')) {
          return { error: [40000, 'Request retry'] };
        }
        if (status === 'active' && this.bootReads > 0) {
          this.power = 'booting';
          return [];
        }
        this.pressPower(status);
        return [];
      }
      case 'audio.getVolumeInformation':
        return [clone(this.volumes)];
      case 'audio.setAudioVolume': {
        const entry =
          this.volumes.find((item) => item.output === (params.output ?? '')) ?? this.mainVolume;
        const volume = Number(params.volume);
        if (!Number.isInteger(volume) || volume < entry.minVolume || volume > entry.maxVolume) {
          return { error: [3, 'Illegal Argument'] };
        }
        entry.volume = volume;
        this.notify('notifyVolumeInformation', {
          output: entry.output,
          volume: entry.volume,
          mute: entry.mute,
        });
        return [];
      }
      case 'audio.setAudioMute': {
        const entry =
          this.volumes.find((item) => item.output === (params.output ?? '')) ?? this.mainVolume;
        entry.mute = params.mute === 'on' ? 'on' : 'off';
        this.notify('notifyVolumeInformation', {
          output: entry.output,
          volume: entry.volume,
          mute: entry.mute,
        });
        return [];
      }
      case 'audio.getSoundSettings':
        return [clone(this.soundSettings)];
      case 'audio.getSpeakerSettings':
        return [clone(this.speakerSettings)];
      case 'audio.setSoundSettings':
      case 'audio.setSpeakerSettings': {
        const list = key === 'audio.setSoundSettings' ? this.soundSettings : this.speakerSettings;
        for (const { target, value } of params.settings ?? []) {
          const setting = list.find((item) => item.target === target);
          if (!setting) {
            return { error: [3, 'Illegal Argument'] };
          }
          const range = setting.candidate[0];
          const valid =
            setting.type === 'integerTarget' || setting.type === 'doubleNumberTarget'
              ? Number(value) >= range.min && Number(value) <= range.max
              : setting.candidate.some((candidate) => candidate.value === value);
          if (!valid) {
            return { error: [3, 'Illegal Argument'] };
          }
          this.changeSetting(target, value);
        }
        return [];
      }
      case 'avContent.getCurrentExternalTerminalsStatus':
        return [clone(this.terminals)];
      case 'avContent.getPlayingContentInfo':
        return [clone(this.playing)];
      case 'avContent.setPlayContent': {
        const main = this.playing[0];
        if (params.positionMsec !== undefined && main?.uri === params.uri) {
          // A USB track played again from a position (the seek).
          this.setPlaying({ ...main, positionMsec: params.positionMsec });
          return [];
        }
        if (!this.terminals.some((terminal) => terminal.uri === params.uri)) {
          return { error: [3, 'Illegal Argument'] };
        }
        this.play(params.uri);
        return [];
      }
      case 'avContent.pausePlayingContent': {
        const main = this.playing[0];
        if (!main || main.contentKind === 'input') {
          return { error: ILLEGAL_STATE };
        }
        const state = main.stateInfo?.state === 'PLAYING' ? 'PAUSED' : 'PLAYING';
        this.play(main.uri, state);
        return [];
      }
      case 'avContent.stopPlayingContent': {
        const main = this.playing[0];
        if (!main || main.contentKind === 'input') {
          return { error: ILLEGAL_STATE };
        }
        this.setPlaying({ ...main, stateInfo: { state: 'STOPPED' } });
        return [];
      }
      case 'avContent.setPlayNextContent':
      case 'avContent.setPlayPreviousContent':
        return [];
      default:
        return this.responses[key]?.result ?? [];
    }
  }
}

/**
 * Fake devices on a fake network: the `request` seam of the integration, and
 * a WebSocket class that reaches the same devices.
 * @param {FakeSongpal[]} devices
 */
export function createNetwork(devices) {
  const byAddress = new Map(devices.map((device) => [device.address, device]));
  const unreachable = (url) => {
    const error = new Error(`connect EHOSTUNREACH ${new URL(url).hostname}`);
    error.code = 'EHOSTUNREACH';
    return error;
  };

  const request = async (url, options = {}) => {
    const device = byAddress.get(new URL(url).hostname);
    if (!device || !device.online) {
      throw unreachable(url);
    }
    return device.handle({ url, method: options.method ?? 'POST', body: options.body });
  };

  /** Enough of the WebSocket API for src/songpal/notifier.js. */
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = { open: [], message: [], close: [], error: [] };
      this.closed = false;
      const target = new URL(url);
      const device = byAddress.get(target.hostname);
      queueMicrotask(() => {
        if (!device || !device.online) {
          this.emit('error', {});
          this.emit('close', {});
          return;
        }
        const service = target.pathname.replace(/^\/sony\//, '');
        this.link = device.attach(service, (text) => {
          if (this.closed) {
            return;
          }
          if (text === null) {
            this.closed = true;
            this.emit('close', {});
            return;
          }
          queueMicrotask(() => !this.closed && this.emit('message', { data: text }));
        });
        this.emit('open', {});
      });
      FakeWebSocket.opened.push(this);
    }

    addEventListener(type, listener) {
      this.listeners[type]?.push(listener);
    }

    emit(type, event) {
      for (const listener of this.listeners[type] ?? []) {
        listener(event);
      }
    }

    send(text) {
      if (!this.closed) {
        this.link?.receive(text);
      }
    }

    close() {
      if (!this.closed) {
        this.closed = true;
        this.link?.close();
        this.emit('close', {});
      }
    }
  }
  FakeWebSocket.opened = [];

  return { devices: byAddress, request, WebSocket: FakeWebSocket };
}
