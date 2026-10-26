// -----------------------------------------------------------------------------
// The Songpal hub: one record per Sony device the integration knows (found by
// the search of the Discovery tab, typed in the configuration, or created in
// Gladys), its states published to Gladys when they change, the "source
// changed" scene event fired on transitions, and every command (features,
// widget buttons, scene actions).
//
// Freshness, for the devices created in Gladys and those typed in the
// configuration ("monitored"):
//   - notifications: a WebSocket per service of the device (src/songpal/
//     notifier.js) pushes power, volume, settings and source changes, applied
//     at once;
//   - reads on the container's own timer: every interval of the
//     configuration while the notifications are down, every 5 minutes while
//     they work (they can be lost silently). Gladys never polls these devices
//     (should_poll: false, and GladysAssistant/Gladys#3198); its onPoll only
//     triggers the same read.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { hostOf } from './config.js';
import {
  FEATURE_KEYS,
  MUSIC_KEYS,
  OTHER_SOURCE,
  PLAYBACK_STATE,
  SETTING_TARGETS,
  buildDevice,
  deviceIds,
  deviceName,
  emptyCapabilities,
  featureValues,
  platformIdOf,
} from './devices.js';
import { createIssueLog } from './issues.js';
import { countPosition, isInput, nowPlayingOf, playbackStateOf } from './music.js';
import { ERROR_KINDS, SongpalClient, SongpalError } from './songpal/client.js';
import {
  SCAN_TIMEOUT_SECONDS,
  endpointOf,
  fetchDescription,
  isTelevision,
  ssdpCandidates,
} from './songpal/discovery.js';
import { httpRequest } from './songpal/http.js';
import {
  choicesOf,
  currentSourceUri,
  findByName,
  isOn,
  isOnOff,
  parseIdentity,
  parseInterface,
  parsePlaying,
  parsePower,
  parseSettings,
  parseSources,
  parseVolume,
  rangeOf,
  sameHardware,
} from './songpal/model.js';
import { Notifier, subscriptionsOf } from './songpal/notifier.js';
import {
  CONNECTION_TEXT,
  ERROR_TEXT,
  REPORT_TEXT,
  deviceFailure,
  failure,
  fill,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'songpal-hub' });

// Widget keys (manifest `widgets`): permanent once published.
export const WIDGET_KEYS = Object.freeze({
  REMOTE: 'remote',
  SOURCES: 'sources',
});

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  SOURCE_CHANGED: 'source_changed',
});

export const HUB_TIMINGS = {
  // The identity and the API description are read again daily (and at each
  // start): another device behind the same address becomes another device.
  identityMs: 24 * 60 * 60_000,
  // Reads while the notifications work: they can be lost without a word.
  notifyingPollMs: 5 * 60_000,
  // An unchanged value is published again this often (the core shows "no
  // recent value" past 48 h).
  heartbeatMs: 6 * 60 * 60_000,
  // Read again this long after a command, to show its effect.
  afterCommandMs: [1_500],
  // After a power on: read at these delays (a sound bar takes a few seconds).
  afterPowerOnMs: [2_000, 6_000],
  // A notification that changes what derives from several reads (power, what
  // plays, the inputs): read the device again this long after it.
  afterNotificationMs: 1_000,
  // A command that needs the device on waits this long for it.
  powerOnWaitMs: 15_000,
  powerOnCheckMs: 1_000,
  // A feature command still running after this is acknowledged to Gladys
  // (the core waits 5 s for the acknowledgement of a device command).
  featureAckMs: 4_000,
};

const DESCRIPTION_CONCURRENCY = 4;

const emptySnapshot = () => ({
  reachable: null,
  power: null,
  volume: null,
  sources: null,
  sourceUri: null,
  sourceKnown: false,
  playing: null,
  settings: {},
});

// Play, pause, next and previous only mean something on a network or USB
// source: an input (HDMI, TV, optical) plays whatever its device sends.
const canPause = (record) =>
  record.snapshot.playing?.kind !== 'input' &&
  !/^extInput:/.test(record.snapshot.playing?.uri ?? '');

const isActive = (record) => record.snapshot.reachable !== false && isOn(record.snapshot.power);

export class SongpalHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/songpal/http.js)
   * @param {typeof WebSocket|null} [options.WebSocketImpl] null: no notifications
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {object} [options.notifierTimings] NOTIFIER_TIMINGS overrides
   * @param {() => number} [options.now]
   * @param {(ms: number) => Promise<void>} [options.sleep]
   */
  constructor({
    gladys,
    store,
    request = httpRequest,
    WebSocketImpl,
    timers = true,
    timings,
    notifierTimings,
    now,
    sleep,
  }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.WebSocketImpl = WebSocketImpl === undefined ? globalThis.WebSocket : WebSocketImpl;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.notifierTimings = notifierTimings;
    this.now = now ?? (() => Date.now());
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.config = null;
    /** @type {Map<string, object>} device records, by platform id */
    this.records = new Map();
    /** @type {Map<string, object>} addresses not identified yet, by endpoint */
    this.pending = new Map();
    this.transports = new Map();
    this.connection = null;
    this.devicesKey = null;
    this.pollTimer = null;
    this.stopped = false;
    this.issues = createIssueLog(logger);
  }

  get language() {
    return this.config?.language ?? 'fr';
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    const devices = saved.devices && typeof saved.devices === 'object' ? saved.devices : {};
    for (const [platformId, entry] of Object.entries(devices)) {
      const record = this.recordFromSaved(platformId, entry);
      if (record) {
        this.records.set(platformId, record);
      }
    }
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.transports.clear();
    this.connection = null;
    this.devicesKey = null;
    this.gladys.forgetPublishedStates?.();
    for (const record of this.records.values()) {
      record.widgetKey = null;
    }
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    this.config = config;
    for (const record of this.records.values()) {
      record.manual = !record.moved && config.hosts.includes(record.endpoint);
    }
    this.refreshPending();
    // The language of the option labels may have changed.
    this.devicesKey = null;
    await this.identifyPending();
    await this.publishDevices();
    this.updateNotifiers();
    await this.pollAll({ force: true });
    this.schedulePoll();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    for (const record of this.records.values()) {
      this.stopRecord(record);
    }
    await this.store.flush();
  }

  stopRecord(record) {
    for (const timer of record.timers) {
      clearTimeout(timer);
    }
    record.timers.clear();
    record.notifier?.stop();
    record.notifier = null;
    record.notifying = false;
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      try {
        await this.identifyPending();
        await this.pollAll();
      } catch (err) {
        logger.error(`Read cycle failed (${err.message})`);
      } finally {
        this.schedulePoll();
      }
    }, this.config.pollIntervalMs);
  }

  /** Read one device again after these delays (a command's effect, a power on). */
  readLater(record, delays) {
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    for (const delay of delays) {
      const timer = setTimeout(() => {
        record.timers.delete(timer);
        this.poll(record, { force: true }).catch(() => {});
      }, delay);
      timer.unref?.();
      record.timers.add(timer);
    }
  }

  // --- Records -----------------------------------------------------------------

  newRecord({ identity, endpoint, info = {}, friendlyName = null, caps }) {
    return {
      platformId: identity.platformId,
      identity,
      endpoint,
      info,
      friendlyName,
      caps: { ...emptyCapabilities(), ...caps },
      manual: false,
      moved: false,
      client: new SongpalClient({ endpoint, request: this.request }),
      notifier: null,
      notifying: false,
      snapshot: emptySnapshot(),
      lastSourceUri: undefined,
      identityAt: 0,
      lastPollAt: -Infinity,
      polling: null,
      commandSeq: 0,
      widgetKey: null,
      timers: new Set(),
    };
  }

  recordFromSaved(platformId, entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.endpoint !== 'string') {
      return null;
    }
    const identity = {
      platformId,
      macs: Array.isArray(entry.macs) ? entry.macs.filter((mac) => typeof mac === 'string') : [],
      serial: typeof entry.serial === 'string' ? entry.serial : null,
      firmware: typeof entry.firmware === 'string' ? entry.firmware : null,
    };
    const caps = { ...emptyCapabilities(), ...(entry.caps ?? {}) };
    const record = this.newRecord({
      identity,
      endpoint: entry.endpoint,
      info: entry.info ?? {},
      friendlyName: typeof entry.friendlyName === 'string' ? entry.friendlyName : null,
      caps,
    });
    if (entry.services && typeof entry.services === 'object') {
      // The API description of the last start: notifications at once.
      record.client.services = entry.services;
    }
    return record;
  }

  save() {
    const devices = {};
    for (const record of this.records.values()) {
      devices[record.platformId] = {
        endpoint: record.endpoint,
        macs: record.identity.macs,
        serial: record.identity.serial,
        firmware: record.identity.firmware,
        info: record.info,
        friendlyName: record.friendlyName,
        caps: record.caps,
        services: record.client.services,
      };
    }
    return this.store.save({ devices });
  }

  /** The external id of a record's device. */
  deviceId(record) {
    return deviceIds(this.gladys, record.platformId).device;
  }

  /** Devices the user added to Gladys, by platform id. */
  createdPlatformIds() {
    const ids = new Set();
    for (const device of this.gladys.devices ?? []) {
      const platformId = platformIdOf(this.gladys, device.external_id);
      if (platformId) {
        ids.add(platformId);
      }
    }
    return ids;
  }

  isCreated(record) {
    return this.createdPlatformIds().has(record.platformId);
  }

  /** Read and kept up to date: created in Gladys, or typed in the configuration. */
  isMonitored(record) {
    return record.manual || this.isCreated(record);
  }

  monitored() {
    return [...this.records.values()].filter((record) => this.isMonitored(record));
  }

  /**
   * Addresses to identify: those typed in the configuration that no known
   * device has, and the devices created in Gladys the store forgot (their
   * address is in their params).
   */
  refreshPending() {
    const wanted = new Map();
    const known = new Set(
      [...this.records.values()].filter((record) => !record.moved).map((record) => record.endpoint),
    );
    for (const endpoint of this.config.hosts) {
      if (!known.has(endpoint)) {
        wanted.set(endpoint, { manual: true });
      }
    }
    for (const device of this.gladys.devices ?? []) {
      const platformId = platformIdOf(this.gladys, device.external_id);
      if (!platformId || this.records.has(platformId)) {
        continue;
      }
      const param = (device.params ?? []).find((item) => item.name === 'SONGPAL_ENDPOINT');
      if (typeof param?.value === 'string' && !known.has(param.value) && !wanted.has(param.value)) {
        wanted.set(param.value, { manual: false });
      }
    }
    for (const endpoint of [...this.pending.keys()]) {
      if (!wanted.has(endpoint)) {
        this.pending.delete(endpoint);
        this.issues.forget(`device:${endpoint}`);
      }
    }
    for (const [endpoint, entry] of wanted) {
      const current = this.pending.get(endpoint);
      if (current) {
        current.manual = entry.manual;
      } else {
        this.pending.set(endpoint, { endpoint, manual: entry.manual, error: null });
      }
    }
  }

  /** Try once to identify every pending address. */
  async identifyPending() {
    let changed = false;
    for (const entry of [...this.pending.values()]) {
      try {
        const record = await this.identify(entry.endpoint);
        this.pending.delete(entry.endpoint);
        record.manual = record.manual || entry.manual;
        this.issues.ok(`device:${entry.endpoint}`, `${hostOf(entry.endpoint)}: answers now`);
        changed = true;
      } catch (err) {
        entry.error = err.kind ?? ERROR_KINDS.API;
        this.issues.fail(
          `device:${entry.endpoint}`,
          `${hostOf(entry.endpoint)}: ${pick(ERROR_TEXT[entry.error] ?? ERROR_TEXT.api, 'en')} (${err.message})`,
        );
      }
    }
    if (changed) {
      this.devicesKey = null;
      await this.publishDevices();
      this.updateNotifiers();
    }
  }

  /**
   * Identify the device behind an address: its API description, identity and
   * model. Matches a known record by its hardware (the address may have
   * changed), else creates one.
   * @param {string} endpoint
   * @param {{ friendlyName?: string|null }} [hints] from the UPnP description
   * @returns {Promise<object>} the record
   */
  async identify(endpoint, hints = {}) {
    const client = new SongpalClient({ endpoint, request: this.request });
    const services = await client.readApiInfo();
    if (services.videoScreen) {
      throw new SongpalError(ERROR_KINDS.NOT_SONGPAL, 'a TV (videoScreen service)');
    }
    const info = parseInterface(await client.getInterfaceInformation().catch(() => ({})));
    if (info.category === 'tv') {
      throw new SongpalError(ERROR_KINDS.NOT_SONGPAL, 'a TV (product category)');
    }
    const identity = parseIdentity(await client.getSystemInformation());
    if (!identity) {
      throw new SongpalError(ERROR_KINDS.API, pick(ERROR_TEXT.noIdentity, 'en'));
    }
    for (const other of this.records.values()) {
      // A device that answered at this address before is not there any more.
      if (other.endpoint === endpoint && !sameHardware(other.identity, identity)) {
        other.moved = true;
      }
    }
    let record =
      this.records.get(identity.platformId) ??
      [...this.records.values()].find((candidate) => sameHardware(candidate.identity, identity));
    if (record) {
      record.moved = false;
      if (record.endpoint !== endpoint) {
        logger.info(`${deviceName(record)}: now at ${hostOf(endpoint)}`);
        this.moveRecord(record, endpoint);
      }
      // Ids stay those of the first identity; the addresses are completed.
      record.identity = {
        ...record.identity,
        macs: [...new Set([...record.identity.macs, ...identity.macs])],
        serial: record.identity.serial ?? identity.serial,
        firmware: identity.firmware ?? record.identity.firmware,
      };
    } else {
      record = this.newRecord({ identity, endpoint });
      this.records.set(identity.platformId, record);
      logger.info(`${info.model ?? identity.platformId} found at ${hostOf(endpoint)}`);
    }
    record.client.services = services;
    record.info = {
      ...record.info,
      ...Object.fromEntries(Object.entries(info).filter(([, v]) => v)),
    };
    if (hints.friendlyName) {
      record.friendlyName = hints.friendlyName;
    }
    record.identityAt = this.now();
    record.manual = record.manual || this.config.hosts.includes(endpoint);
    this.save();
    return record;
  }

  moveRecord(record, endpoint) {
    record.notifier?.stop();
    record.notifier = null;
    record.notifying = false;
    const services = record.client.services;
    record.endpoint = endpoint;
    record.moved = false;
    record.client = new SongpalClient({ endpoint, request: this.request });
    record.client.services = services;
    this.devicesKey = null;
  }

  /** Re-read the identity of a known device (daily): the same hardware? */
  async refreshIdentity(record) {
    const services = await record.client.readApiInfo();
    const identity = parseIdentity(await record.client.getSystemInformation());
    if (identity && !sameHardware(record.identity, identity)) {
      // Another device answers at this address: identify it on its own, this
      // record waits for its device to be found elsewhere.
      // Its own device keeps its record: a search finds it at its new address.
      logger.info(`${hostOf(record.endpoint)}: another device answers there now`);
      record.moved = true;
      await this.identify(record.endpoint);
      throw new SongpalError(ERROR_KINDS.UNREACHABLE, 'another device answers at its address');
    }
    record.client.services = services;
    record.identityAt = this.now();
    this.save();
  }

  // --- Devices -----------------------------------------------------------------

  /** Publish every known device, only when something changed. */
  async publishDevices() {
    const devices = [...this.records.values()].map((record) =>
      buildDevice(this.gladys, record, this.language),
    );
    const key = JSON.stringify(devices);
    if (key === this.devicesKey) {
      return;
    }
    try {
      // Even an empty list: the Discovery tab then shows no stale device.
      await this.gladys.publishDiscoveredDevices(devices);
      this.devicesKey = key;
      this.issues.ok('devices', 'Devices: published again');
    } catch (err) {
      this.issues.fail('devices', `Devices refused by Gladys: ${err.message}`);
    }
  }

  /** Start the notifications of the monitored devices, stop the others'. */
  updateNotifiers() {
    for (const record of this.records.values()) {
      const wanted =
        !this.stopped && this.WebSocketImpl && this.isMonitored(record) && record.client.services;
      if (wanted && !record.notifier) {
        const subscriptions = subscriptionsOf(record.client.services);
        if (subscriptions.length === 0) {
          continue;
        }
        record.notifier = new Notifier({
          endpoint: record.endpoint,
          subscriptions,
          WebSocketImpl: this.WebSocketImpl,
          timings: this.notifierTimings,
          onEvent: (name, params) => this.onNotification(record, name, params),
          onStatus: (connected) => {
            record.notifying = connected;
            logger.debug(`${deviceName(record)}: notifications ${connected ? 'on' : 'off'}`);
          },
        });
        record.notifier.start();
      } else if (!wanted && record.notifier) {
        record.notifier.stop();
        record.notifier = null;
        record.notifying = false;
      }
    }
  }

  /** "Search" in the Discovery tab: SSDP through the core, then publish. */
  async rediscover() {
    let results = [];
    try {
      results = await this.gladys.scanNetwork('ssdp', { timeoutSeconds: SCAN_TIMEOUT_SECONDS });
      this.issues.ok('scan', 'Network search: working again');
    } catch (err) {
      this.issues.fail('scan', `Network search unavailable (${err.message})`);
    }
    const candidates = ssdpCandidates(results);
    const found = new Set();
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        const candidate = candidates[next];
        next += 1;
        let description = null;
        if (candidate.location) {
          description = await fetchDescription(this.request, candidate.location).catch(() => null);
        }
        if (description && isTelevision(description)) {
          logger.debug(`${candidate.address}: a TV, left to the Bravia integration`);
          continue;
        }
        const endpoint = endpointOf(candidate, description);
        if (!endpoint) {
          continue;
        }
        try {
          const record = await this.identify(endpoint, {
            friendlyName: description?.friendlyName ?? null,
          });
          found.add(record.platformId);
        } catch (err) {
          logger.debug(`${candidate.address}: not used (${err.message})`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(DESCRIPTION_CONCURRENCY, candidates.length) }, worker),
    );
    // The pending addresses are tried again too (a device just plugged in).
    await this.identifyPending();
    // Forget what is neither created, typed, nor found now: the Discovery tab
    // shows what is there.
    const created = this.createdPlatformIds();
    for (const record of [...this.records.values()]) {
      if (!record.manual && !created.has(record.platformId) && !found.has(record.platformId)) {
        this.stopRecord(record);
        this.records.delete(record.platformId);
      }
    }
    this.save();
    this.devicesKey = null;
    await Promise.all(
      [...this.records.values()].map((record) =>
        this.poll(record, { force: true }).catch(() => {}),
      ),
    );
    await this.publishDevices();
    this.updateNotifiers();
    await this.updateConnection();
    logger.info(`Search: ${found.size} device(s) found, ${this.records.size} known`);
  }

  /** The user added a device in Gladys: monitor it and send all its states. */
  async onDeviceCreated(device) {
    const platformId = platformIdOf(this.gladys, device?.external_id);
    const record = platformId ? this.records.get(platformId) : null;
    if (!record) {
      this.refreshPending();
      await this.identifyPending();
      return;
    }
    record.widgetKey = null;
    this.gladys.forgetPublishedStates?.(this.deviceId(record));
    this.updateNotifiers();
    await this.poll(record, { force: true }).catch(() => {});
    await this.updateConnection();
    this.refreshWidgets();
  }

  /** The user deleted a device: stop monitoring it (unless typed in the configuration). */
  async onDeviceDeleted() {
    this.updateNotifiers();
    await this.updateConnection();
  }

  // --- Reads -------------------------------------------------------------------

  /** Read every monitored device that is due (or all of them, forced). */
  async pollAll({ force = false } = {}) {
    if (this.gladys.connected === false) {
      logger.debug('Gladys unreachable: read skipped');
      return;
    }
    await Promise.all(
      this.monitored().map((record) => this.poll(record, { force }).catch(() => {})),
    );
    await this.updateConnection();
  }

  /** Is a device due for a read: its interval, longer while notifications work. */
  isDue(record) {
    const interval = record.notifying
      ? Math.max(this.config.pollIntervalMs, this.timings.notifyingPollMs)
      : this.config.pollIntervalMs;
    // A little slack: the timer and the reads do not align to the millisecond.
    return this.now() - record.lastPollAt >= interval * 0.9;
  }

  /**
   * Read one device and publish what changed. A read already running is
   * shared. Resolves true when the device answered.
   */
  async poll(record, { force = false } = {}) {
    if (record.polling) {
      return record.polling;
    }
    if (!force && !this.isDue(record)) {
      return record.snapshot.reachable !== false;
    }
    record.lastPollAt = this.now();
    record.polling = (async () => {
      const seq = record.commandSeq;
      let reading;
      try {
        reading = await this.read(record);
      } catch (err) {
        this.markUnreachable(record, err);
        await this.publishRecord(record);
        return false;
      }
      if (seq !== record.commandSeq) {
        // A command ran meanwhile: this reading may predate it.
        this.readLater(record, this.timings.afterCommandMs);
        return true;
      }
      this.issues.ok(`device:${record.platformId}`, `${deviceName(record)}: answers again`);
      if (record.notifier && !record.notifying) {
        record.notifier.reconnectNow();
      }
      await this.applyReading(record, reading);
      return true;
    })();
    try {
      return await record.polling;
    } finally {
      record.polling = null;
    }
  }

  /** The reads of one device (the network part, no state change). */
  async read(record) {
    const { client } = record;
    if (record.moved) {
      throw new SongpalError(ERROR_KINDS.UNREACHABLE, 'another device answers at its address');
    }
    if (!client.services || this.now() - record.identityAt >= this.timings.identityMs) {
      await this.refreshIdentity(record);
    }
    const power = parsePower(await client.getPowerStatus());
    const reading = { power };
    // In standby the lists mean nothing to the states, but a device never
    // seen on has no features yet: some models answer them in standby.
    const probe = !isOn(power) && !record.caps.volume && record.caps.sources.length === 0;
    if (!isOn(power) && !probe) {
      return reading;
    }
    reading.probe = probe;
    // Each read may fail alone (a method a model lacks, a source that refuses
    // it): the others still count.
    const optional = async (service, method, run) => {
      if (!client.supports(service, method)) {
        return null;
      }
      try {
        return await run();
      } catch (err) {
        if (err.kind === ERROR_KINDS.UNREACHABLE && !probe) {
          throw err;
        }
        logger.debug(`${deviceName(record)}: ${err.message}`);
        return null;
      }
    };
    const [volumes, terminals, playing, sound, speaker] = await Promise.all([
      optional('audio', 'getVolumeInformation', () => client.getVolumeInformation()),
      optional('avContent', 'getCurrentExternalTerminalsStatus', () =>
        client.getExternalTerminals(),
      ),
      optional('avContent', 'getPlayingContentInfo', () => client.getPlayingContentInfo()),
      optional('audio', 'getSoundSettings', () => client.getSoundSettings()),
      optional('audio', 'getSpeakerSettings', () => client.getSpeakerSettings()),
    ]);
    reading.volume = volumes ? parseVolume(volumes) : null;
    reading.sources = terminals ? parseSources(terminals) : null;
    reading.playing = playing ? parsePlaying(playing) : null;
    reading.playingRead = playing !== null;
    // Speaker settings first: a sound setting of the same target wins.
    reading.settings = {
      ...(speaker ? parseSettings(speaker, 'speaker') : {}),
      ...(sound ? parseSettings(sound, 'sound') : {}),
    };
    reading.settingsRead = Boolean(sound || speaker);
    return reading;
  }

  markUnreachable(record, err) {
    const wasReachable = record.snapshot.reachable;
    record.snapshot = { ...emptySnapshot(), reachable: false };
    const kind = err.kind ?? ERROR_KINDS.API;
    const explanation = pick(ERROR_TEXT[kind] ?? ERROR_TEXT.api, 'en');
    this.issues.fail(
      `device:${record.platformId}`,
      `${deviceName(record)} (${hostOf(record.endpoint)}) ${explanation}${wasReachable === true ? '' : ` (${err.message})`}`,
    );
  }

  /** Apply one full reading: capabilities, snapshot, states, scene event. */
  async applyReading(record, reading) {
    const snapshot = { ...record.snapshot, reachable: true, power: reading.power };
    if (reading.probe && this.learnCapabilities(record, reading)) {
      this.save();
      await this.publishDevices();
    }
    if (isOn(reading.power)) {
      snapshot.volume = reading.volume ?? snapshot.volume;
      if (reading.sources) {
        snapshot.sources = reading.sources;
      }
      if (reading.playingRead) {
        snapshot.playing = reading.playing;
      }
      if (reading.settingsRead) {
        snapshot.settings = reading.settings;
      }
      if (reading.sources || reading.playingRead) {
        snapshot.sourceUri = currentSourceUri(snapshot.playing, snapshot.sources ?? []);
        snapshot.sourceKnown = Boolean(snapshot.sources);
      }
      if (this.learnCapabilities(record, reading)) {
        this.save();
        await this.publishDevices();
      }
    }
    record.snapshot = snapshot;
    await this.afterChange(record);
  }

  /** Update what decides the features; true when it changed. */
  learnCapabilities(record, reading) {
    const caps = record.caps;
    const next = { ...caps };
    if (reading.volume) {
      next.volume = { min: reading.volume.min, max: reading.volume.max };
    }
    if (reading.sources && reading.sources.length > 0) {
      next.sources = reading.sources.map(({ uri, name }) => ({ uri, name }));
    }
    if (reading.settingsRead) {
      const settings = reading.settings;
      next.soundModes = choicesOf(settings[SETTING_TARGETS.SOUND_MODE]);
      next.nightMode = isOnOff(settings[SETTING_TARGETS.NIGHT_MODE]);
      const voice = settings[SETTING_TARGETS.VOICE];
      if (!voice) {
        next.voice = null;
        next.voiceChoices = [];
      } else if (isOnOff(voice)) {
        next.voice = 'binary';
        next.voiceChoices = [];
      } else {
        const choices = choicesOf(voice);
        next.voice = choices.length > 1 ? 'select' : null;
        next.voiceChoices = choices.length > 1 ? choices : [];
      }
      const subwoofer = settings[SETTING_TARGETS.SUBWOOFER];
      const range = rangeOf(subwoofer);
      next.subwoofer = range ? { api: subwoofer.api, ...range } : null;
    }
    next.playback = record.client.supports('avContent', 'pausePlayingContent');
    if (JSON.stringify(next) === JSON.stringify(caps)) {
      return false;
    }
    record.caps = next;
    return true;
  }

  /** After any change of a snapshot: states, scene event, widgets. */
  async afterChange(record) {
    await this.publishRecord(record);
    this.detectSourceChange(record);
    const key = JSON.stringify([
      record.snapshot.reachable,
      record.snapshot.power,
      record.snapshot.volume?.volume,
      record.snapshot.volume?.mute,
      record.snapshot.sourceUri,
      record.snapshot.settings?.[SETTING_TARGETS.SOUND_MODE]?.value,
    ]);
    if (key !== record.widgetKey) {
      record.widgetKey = key;
      this.refreshWidgets();
    }
  }

  /** The states of a created device, only the changed ones; and its transport. */
  async publishRecord(record) {
    if (!this.isCreated(record)) {
      return;
    }
    const states = featureValues(this.gladys, record).map(({ externalId, state, text }) => ({
      device_feature_external_id: externalId,
      ...(text !== undefined ? { text } : { state }),
    }));
    if (states.length > 0) {
      try {
        await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
        this.issues.ok('states', 'States: working again');
      } catch (err) {
        this.issues.fail('states', `States of ${deviceName(record)} refused: ${err.message}`);
      }
    }
    await this.publishMusic(record);
    const transport =
      record.snapshot.reachable === false
        ? DEVICE_TRANSPORTS.UNREACHABLE
        : record.snapshot.reachable
          ? DEVICE_TRANSPORTS.LOCAL
          : null;
    if (transport && this.transports.get(record.platformId) !== transport) {
      try {
        await this.gladys.publishTransports([{ external_id: this.deviceId(record), transport }]);
        this.transports.set(record.platformId, transport);
      } catch (err) {
        logger.debug(`Transport of ${deviceName(record)} refused: ${err.message}`);
      }
    }
  }

  /**
   * The Gladys 5.3 music player of a device that can pause: publishNowPlaying
   * diffs it (volume and mute included, one channel per feature). Published
   * even before the user clicks "Update" on a 1.0 device: Gladys ignores the
   * features it does not have yet, and the SDK publishes everything again
   * after the update.
   */
  async publishMusic(record) {
    if (!record.caps.playback) {
      return;
    }
    const counted = countPosition(record);
    const nowPlaying = nowPlayingOf(record, counted);
    if (!nowPlaying) {
      return;
    }
    const ids = deviceIds(this.gladys, record.platformId);
    // publishNowPlaying has no heartbeat: everything again every 6 hours.
    if (record.musicAt === undefined) {
      record.musicAt = this.now();
    } else if (this.now() - record.musicAt >= this.timings.heartbeatMs) {
      record.musicAt = this.now();
      this.gladys.forgetPublishedStates(ids.device);
    }
    const features = new Set(
      buildDevice(this.gladys, record, 'en').features.map((feature) => feature.external_id),
    );
    const featureExternalIds = {};
    for (const [type, key] of Object.entries(MUSIC_KEYS)) {
      if (features.has(ids.feature(key))) {
        featureExternalIds[type] = ids.feature(key);
      } else {
        delete nowPlaying[type === 'artwork' ? 'artwork_url' : type];
      }
    }
    try {
      await this.gladys.publishNowPlaying(ids.device, nowPlaying, { featureExternalIds });
      this.issues.ok('music', 'Music states: working again');
    } catch (err) {
      this.issues.fail('music', `Music states of ${deviceName(record)} refused: ${err.message}`);
    }
  }

  /** Fire `source_changed` when the input in use changes (turning on included). */
  detectSourceChange(record) {
    const { snapshot } = record;
    if (!isActive(record) || !snapshot.sourceKnown) {
      return;
    }
    const uri = snapshot.sourceUri;
    const previous = record.lastSourceUri;
    record.lastSourceUri = uri;
    if (previous === undefined || previous === uri || !this.isMonitored(record)) {
      return;
    }
    const nameOf = (value) =>
      value === null
        ? pick({ en: 'Other', fr: 'Autre', de: 'Andere', es: 'Otra' }, this.language)
        : (record.caps.sources.find((source) => source.uri === value)?.name ?? value);
    this.gladys
      .publishSceneEvent(TRIGGERS.SOURCE_CHANGED, {
        device: this.deviceId(record),
        device_name: deviceName(record),
        source: nameOf(uri),
        previous_source: nameOf(previous),
      })
      .then(() => this.issues.ok('event', 'Scene events: working again'))
      .catch((err) => this.issues.fail('event', `Scene event refused: ${err.message}`));
  }

  refreshWidgets() {
    for (const key of Object.values(WIDGET_KEYS)) {
      try {
        const sent = this.gladys.requestWidgetRefresh(key);
        sent?.catch?.(() => {});
      } catch {
        // Fire-and-forget: a lost nudge costs one content TTL at most.
      }
    }
  }

  /** The connection badge of the Configuration screen. */
  async updateConnection() {
    const monitored = this.monitored();
    let status;
    if (this.config.invalidHosts.length > 0) {
      status = { connected: false, message: CONNECTION_TEXT.invalidHosts };
    } else if (this.records.size === 0) {
      status = { connected: false, message: CONNECTION_TEXT.noDevice };
    } else if (
      monitored.length > 0 &&
      monitored.every((record) => record.snapshot.reachable === false)
    ) {
      status = { connected: false, message: CONNECTION_TEXT.noneAnswers };
    } else {
      status = { connected: true };
    }
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
    } catch (err) {
      logger.debug(`Connection status refused: ${err.message}`);
    }
  }

  // --- Notifications -------------------------------------------------------------

  onNotification(record, name, params) {
    if (this.stopped) {
      return;
    }
    logger.debug(`${deviceName(record)}: ${name}`);
    const snapshot = { ...record.snapshot };
    let readAgain = false;
    switch (name) {
      case 'notifyPowerStatus': {
        const power = parsePower(params);
        if (power) {
          snapshot.reachable = true;
          snapshot.power = power;
          readAgain = isOn(power);
        }
        break;
      }
      case 'notifyVolumeInformation': {
        const output = typeof params.output === 'string' ? params.output : '';
        const main = snapshot.volume?.output ?? '';
        if (snapshot.volume && (output === main || output === '')) {
          const volume = Number(params.volume);
          snapshot.volume = {
            ...snapshot.volume,
            ...(Number.isFinite(volume) ? { volume: Math.round(volume) } : {}),
            ...(params.mute !== undefined
              ? { mute: params.mute === 'on' || params.mute === true }
              : {}),
          };
        } else {
          readAgain = true;
        }
        break;
      }
      case 'notifySettingsUpdate': {
        const update = params.apiMappingUpdate;
        const target = update?.target;
        if (typeof target === 'string' && snapshot.settings?.[target]) {
          snapshot.settings = {
            ...snapshot.settings,
            [target]: { ...snapshot.settings[target], value: String(update.currentValue) },
          };
        } else {
          readAgain = true;
        }
        break;
      }
      case 'notifyPlayingContentInfo': {
        // The main output only: '' (sound bars, speakers) or zone 1 (receivers).
        // An entry without a state that is not an input (`kind: "directory"`
        // while a USB folder is browsed) says nothing about what plays: read
        // again only. An input comes without a state (HT-ZF9).
        const playing = parsePlaying([params]);
        if (
          (!params.output || /zone=1$/.test(params.output)) &&
          (playing.state || isInput(playing))
        ) {
          snapshot.playing = playing;
          if (snapshot.sources) {
            snapshot.sourceUri = currentSourceUri(snapshot.playing, snapshot.sources);
            snapshot.sourceKnown = true;
          }
        }
        readAgain = true;
        break;
      }
      default:
        // notifyExternalTerminalStatus: an input connected, renamed…
        readAgain = true;
    }
    record.snapshot = snapshot;
    this.afterChange(record).catch(() => {});
    if (readAgain) {
      this.readLater(record, [this.timings.afterNotificationMs]);
    }
  }

  // --- Commands --------------------------------------------------------------------

  /**
   * The record a widget, a scene action or a command acts on: the chosen
   * device, else the first monitored one.
   * @param {string|null|undefined} externalId
   */
  target(externalId) {
    if (externalId) {
      const platformId = platformIdOf(this.gladys, externalId);
      const record = platformId ? this.records.get(platformId) : null;
      if (!record) {
        throw failure(this.language, 'unknownDevice');
      }
      return record;
    }
    const record = this.monitored()[0] ?? [...this.records.values()][0];
    if (!record) {
      throw failure(this.language, 'noDevice');
    }
    return record;
  }

  /** The same, without throwing (widgets). */
  view(externalId) {
    try {
      return this.target(externalId);
    } catch {
      return null;
    }
  }

  /** Run a client call; a failure becomes a message for the user. */
  async run(record, fn) {
    record.commandSeq += 1;
    try {
      return await fn(record.client);
    } catch (err) {
      if (err.userFacing) {
        throw err;
      }
      logger.warn(`${deviceName(record)}: command failed (${err.message})`);
      throw deviceFailure(this.language, deviceName(record), err);
    }
  }

  /** Apply what a command changed, publish, and read again a bit later. */
  async commanded(record, change = {}, delays = this.timings.afterCommandMs) {
    record.commandSeq += 1;
    record.snapshot = { ...record.snapshot, ...change };
    await this.afterChange(record);
    this.readLater(record, delays);
  }

  async setPower(record, on) {
    logger.info(`${deviceName(record)}: ${on ? 'turn on' : 'standby'}`);
    await this.run(record, (client) => client.setPower(on));
    await this.commanded(
      record,
      { reachable: true, power: on ? 'active' : 'standby' },
      on ? this.timings.afterPowerOnMs : this.timings.afterCommandMs,
    );
  }

  /** Turn the device on and wait until it says so. */
  async ensureOn(record) {
    if (isActive(record)) {
      return;
    }
    await this.run(record, (client) => client.setPower(true));
    const deadline = this.now() + this.timings.powerOnWaitMs;
    while (this.now() < deadline) {
      await this.sleep(this.timings.powerOnCheckMs);
      const power = parsePower(await record.client.getPowerStatus().catch(() => ({})));
      if (isOn(power)) {
        record.snapshot = { ...record.snapshot, reachable: true, power };
        return;
      }
    }
    throw failure(this.language, 'notOn', { name: deviceName(record) });
  }

  async setVolume(record, value) {
    const volume = record.snapshot.volume;
    const range = record.caps.volume ?? { min: 0, max: 100 };
    const level = Math.min(range.max, Math.max(range.min, Math.round(Number(value))));
    if (!Number.isFinite(level)) {
      throw failure(this.language, 'noFeature', { name: deviceName(record) });
    }
    logger.info(`${deviceName(record)}: volume ${level}`);
    await this.run(record, (client) => client.setVolume(volume?.output ?? '', level));
    await this.commanded(record, {
      volume: { ...(volume ?? { output: '', mute: false, ...range, step: 1 }), volume: level },
    });
    return level;
  }

  /** Volume up or down by the configured step. */
  async stepVolume(record, direction) {
    const current = record.snapshot.volume?.volume;
    if (current === undefined) {
      const fresh = parseVolume(await record.client.getVolumeInformation().catch(() => []));
      record.snapshot = { ...record.snapshot, volume: fresh ?? record.snapshot.volume };
    }
    const base = record.snapshot.volume?.volume ?? 0;
    return this.setVolume(record, base + direction * this.config.volumeStep);
  }

  async setMute(record, mute) {
    const volume = record.snapshot.volume;
    logger.info(`${deviceName(record)}: ${mute ? 'mute' : 'unmute'}`);
    await this.run(record, (client) => client.setMute(volume?.output ?? '', mute));
    await this.commanded(record, volume ? { volume: { ...volume, mute } } : {});
  }

  /** Choose an input, by its uri or by what a user typed; turns on first. */
  async selectSource(record, typed) {
    if (typed === OTHER_SOURCE) {
      throw failure(this.language, 'otherSource');
    }
    let source = findByName(record.caps.sources, typed);
    if (!source && !isActive(record)) {
      // Its inputs may only be known once on (a device first seen in standby).
      await this.ensureOn(record);
      await this.poll(record, { force: true });
      source = findByName(record.caps.sources, typed);
    }
    if (!source) {
      throw failure(this.language, 'unknownSource', { name: deviceName(record), value: typed });
    }
    logger.info(`${deviceName(record)}: source ${source.name}`);
    await this.ensureOn(record);
    await this.run(record, (client) => client.setPlayContent(source.uri));
    await this.commanded(record, { sourceUri: source.uri, sourceKnown: true });
    return source;
  }

  /** Change one sound setting to one of its values. */
  async setSetting(record, target, value) {
    const setting = record.snapshot.settings?.[target];
    const api =
      setting?.api ?? (target === SETTING_TARGETS.SUBWOOFER ? record.caps.subwoofer?.api : null);
    logger.info(`${deviceName(record)}: ${target} ${value}`);
    await this.run(record, (client) => client.setSetting(api ?? 'sound', target, value));
    const settings = { ...record.snapshot.settings };
    settings[target] = { ...(setting ?? { target, api: api ?? 'sound', candidates: [] }), value };
    await this.commanded(record, { settings });
  }

  async setSoundMode(record, typed) {
    const mode = findByName(
      record.caps.soundModes,
      typed,
      (item) => item.label,
      (item) => item.value,
    );
    if (!mode) {
      throw failure(this.language, 'unknownSoundMode', { name: deviceName(record), value: typed });
    }
    await this.setSetting(record, SETTING_TARGETS.SOUND_MODE, mode.value);
    return mode;
  }

  async setVoice(record, value) {
    if (record.caps.voice === 'binary') {
      const on = value === true || value === 1 || value === '1' || value === 'on';
      await this.setSetting(record, SETTING_TARGETS.VOICE, on ? 'on' : 'off');
      return;
    }
    const choice = findByName(
      record.caps.voiceChoices,
      value,
      (item) => item.label,
      (item) => item.value,
    );
    if (!choice) {
      throw failure(this.language, 'unknownVoice', { name: deviceName(record), value });
    }
    await this.setSetting(record, SETTING_TARGETS.VOICE, choice.value);
  }

  /**
   * Voice enhancement on or off, whatever the setting is: on/off, or levels
   * (the older sound bars: on = the first level that is not off).
   */
  async setVoiceSwitch(record, on) {
    if (record.caps.voice === 'binary') {
      return this.setVoice(record, on ? 1 : 0);
    }
    const choices = record.caps.voiceChoices;
    const choice = on
      ? choices.find((item) => item.value.toLowerCase() !== 'off')
      : choices.find((item) => item.value.toLowerCase() === 'off');
    if (!choice) {
      throw failure(this.language, 'noFeature', { name: deviceName(record) });
    }
    return this.setSetting(record, SETTING_TARGETS.VOICE, choice.value);
  }

  async setSubwoofer(record, value) {
    const range = record.caps.subwoofer;
    if (!range) {
      throw failure(this.language, 'noFeature', { name: deviceName(record) });
    }
    const steps = Math.round((Number(value) - range.min) / range.step);
    const level = Math.min(range.max, Math.max(range.min, range.min + steps * range.step));
    if (!Number.isFinite(level)) {
      throw failure(this.language, 'noFeature', { name: deviceName(record) });
    }
    await this.setSetting(record, SETTING_TARGETS.SUBWOOFER, String(Number(level.toFixed(2))));
  }

  /** Play or pause: the device toggles, so only when it is not already so. */
  async playPause(record, play) {
    if (!canPause(record)) {
      throw failure(this.language, 'noPlayback', { name: deviceName(record) });
    }
    const playing = record.snapshot.playing?.state === 'PLAYING';
    logger.info(`${deviceName(record)}: ${play ? 'play' : 'pause'}`);
    if (play !== playing) {
      await this.run(record, (client) => client.pausePlayingContent());
      const state = play ? 'PLAYING' : 'PAUSED';
      await this.commanded(record, {
        playing: { ...(record.snapshot.playing ?? { uri: null, kind: null, title: null }), state },
      });
    }
  }

  /** The playback state written from Gladys: 0 pause, 1 play, 2 stop. */
  async setPlaybackState(record, value) {
    const state = Number(value);
    if (state === PLAYBACK_STATE.IDLE) {
      return this.stopPlayback(record);
    }
    if (state === PLAYBACK_STATE.PLAYING || state === PLAYBACK_STATE.PAUSED) {
      return this.playPause(record, state === PLAYBACK_STATE.PLAYING);
    }
    throw failure(this.language, 'badPlaybackState');
  }

  async stopPlayback(record) {
    if (!canPause(record)) {
      throw failure(this.language, 'noPlayback', { name: deviceName(record) });
    }
    logger.info(`${deviceName(record)}: stop`);
    if (playbackStateOf(record.snapshot.playing) === PLAYBACK_STATE.IDLE) {
      return;
    }
    await this.run(record, (client) => client.stopPlayingContent());
    await this.commanded(record, {
      playing: { ...record.snapshot.playing, state: 'STOPPED' },
    });
  }

  /**
   * Move within the track: the device has no seek method, but plays a USB
   * track from a position (setPlayContent 1.2). Anything else is refused.
   */
  async seek(record, seconds) {
    const playing = record.snapshot.playing;
    const position = Number(seconds);
    if (
      !Number.isFinite(position) ||
      !canPause(record) ||
      !/^storage:/.test(playing?.uri ?? '') ||
      record.client.versionOf('avContent', 'setPlayContent') !== '1.2'
    ) {
      throw failure(this.language, 'noSeek', { name: deviceName(record) });
    }
    const target = Math.max(0, Math.round(position));
    logger.info(`${deviceName(record)}: seek to ${target} s`);
    await this.run(record, (client) => client.playContentAt(playing.uri, target * 1000));
    await this.commanded(record, {
      playing: { ...playing, positionMs: target * 1000 },
    });
  }

  async skip(record, forward) {
    if (!canPause(record)) {
      throw failure(this.language, 'noPlayback', { name: deviceName(record) });
    }
    logger.info(`${deviceName(record)}: ${forward ? 'next' : 'previous'}`);
    await this.run(record, (client) => (forward ? client.playNext() : client.playPrevious()));
    await this.commanded(record);
  }

  /** A feature command (onSetValue). */
  async setValue(device, feature, value) {
    const record = this.target(device?.external_id);
    const key = String(feature?.external_id ?? '').slice(this.deviceId(record).length + 1);
    const on = Number(value) === 1;
    const command = (async () => {
      switch (key) {
        case FEATURE_KEYS.POWER:
          return this.setPower(record, on);
        case FEATURE_KEYS.VOLUME:
          return this.setVolume(record, value);
        case FEATURE_KEYS.MUTE:
          return this.setMute(record, on);
        case FEATURE_KEYS.SOURCE:
          return this.selectSource(record, String(value));
        case FEATURE_KEYS.SOUND_MODE:
          return this.setSoundMode(record, String(value));
        case FEATURE_KEYS.NIGHT_MODE:
          return this.setSetting(record, SETTING_TARGETS.NIGHT_MODE, on ? 'on' : 'off');
        case FEATURE_KEYS.VOICE:
          return this.setVoice(record, record.caps.voice === 'binary' ? Number(value) : value);
        case FEATURE_KEYS.SUBWOOFER:
          return this.setSubwoofer(record, value);
        case FEATURE_KEYS.PLAY:
          return this.playPause(record, true);
        case FEATURE_KEYS.PAUSE:
          return this.playPause(record, false);
        case FEATURE_KEYS.NEXT:
          return this.skip(record, true);
        case FEATURE_KEYS.PREVIOUS:
          return this.skip(record, false);
        case FEATURE_KEYS.PLAYBACK:
          return this.setPlaybackState(record, value);
        case FEATURE_KEYS.POSITION:
          return this.seek(record, value);
        default:
          throw failure(this.language, 'noFeature', { name: deviceName(record) });
      }
    })();
    // The core waits 5 s for the acknowledgement: a source change that turns
    // the device on first takes longer, it goes on after the acknowledgement.
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve('late'), this.timings.featureAckMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([command.then(() => 'done'), late]);
      if (outcome === 'late') {
        command.catch((err) => logger.warn(`${deviceName(record)}: ${err.message}`));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Report ------------------------------------------------------------------------

  /** "Test the connection": read everything now, one line per device. */
  async testConnection() {
    this.refreshPending();
    await this.identifyPending();
    await Promise.all(
      [...this.records.values()].map((record) =>
        this.poll(record, { force: true }).catch(() => {}),
      ),
    );
    await this.updateConnection();
    const language = this.language;
    const text = REPORT_TEXT[language] ?? REPORT_TEXT.en;
    const lines = [];
    for (const record of this.records.values()) {
      const host = hostOf(record.endpoint);
      const { snapshot } = record;
      if (snapshot.reachable === false) {
        lines.push(`${deviceName(record)} (${host}): ${pick(ERROR_TEXT.unreachable, language)}`);
        continue;
      }
      const parts = [isOn(snapshot.power) ? text.on : text.standby];
      if (isOn(snapshot.power)) {
        const source = record.caps.sources.find((item) => item.uri === snapshot.sourceUri);
        if (source) {
          parts.push(source.name);
        }
        if (snapshot.volume) {
          parts.push(
            snapshot.volume.mute ? text.muted : `${text.volume} ${snapshot.volume.volume}`,
          );
        }
      }
      parts.push(
        record.notifying
          ? text.notifications
          : fill(text.noNotifications, { value: this.config.pollIntervalMs / 1000 }),
      );
      lines.push(`${deviceName(record)} (${host}): ${parts.join(', ')}`);
    }
    for (const entry of this.pending.values()) {
      const explanation = pick(ERROR_TEXT[entry.error] ?? ERROR_TEXT.notReached, language);
      lines.push(`${hostOf(entry.endpoint)}: ${explanation}`);
    }
    for (const typed of this.config.invalidHosts) {
      lines.push(fill(text.invalid, { value: typed }));
    }
    logger.info(`Connection test: ${lines.length} line(s)`);
    return lines.length > 0 ? lines.join(' · ') : text.none;
  }
}
