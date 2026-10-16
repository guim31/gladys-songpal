// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, fake Sony devices on a fake
// network (HTTP and WebSocket), a temporary /data and a manual clock, with the
// integration wired on top through registerHandlers. No timer runs (unless
// `timers`, with mocked timers): the tests read the devices with
// `world.hub.pollAll({ force: true })`, and the waits of the commands are
// instant. (Adapted from guim31/gladys-sony-bravia.)
// -----------------------------------------------------------------------------

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { Store } from '../../src/store.js';
import { FakeSongpal, createNetwork } from './fakeSongpal.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

export const SSDP_RESULTS = JSON.parse(
  readFileSync(new URL('../fixtures/ssdp-results.json', import.meta.url), 'utf8'),
);

/** A manual clock; `sleep` moves it forward instead of waiting. */
export function createClock(start = Date.UTC(2026, 9, 16, 19, 0, 0)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
    sleep: async (ms) => {
      clock.time += ms;
    },
  };
  return clock;
}

/** Wait for the queued microtasks and immediate callbacks (notifications). */
export async function settle(turns = 20) {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * @param {object} [options]
 * @param {FakeSongpal[]} [options.devices] the devices on the network
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.created] devices already created in Gladys
 * @param {boolean} [options.connect]
 * @param {boolean} [options.websocket] give the hub a WebSocket class
 * @param {boolean} [options.discover] run the search once and add every device
 */
export async function createWorld({
  clock = createClock(),
  devices,
  config = { language: 'en' },
  created = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-songpal-')),
  timings = {},
  timers = false,
  websocket = true,
  discover = true,
  scanResults = SSDP_RESULTS,
} = {}) {
  const network = createNetwork(devices ?? [new FakeSongpal('ht-zf9')]);
  const gladys = createFakeGladys({
    config,
    devices: created,
    scanResults: { ssdp: scanResults },
  });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request: network.request,
    WebSocketImpl: websocket ? network.WebSocket : null,
    timers,
    timings,
    now: clock.now,
    sleep: clock.sleep,
  });
  const world = {
    gladys,
    fake: gladys.fake,
    network,
    device: [...network.devices.values()][0],
    app,
    hub: app.hub,
    clock,
    dataDir,
  };
  if (connect) {
    await gladys.connect();
    await app.ready;
    if (discover) {
      await gladys.fake.scanRequest();
      await createAll(world);
    }
    await settle();
  }
  return world;
}

/** The discovered device of a fake device, by its address. */
export function deviceOf(world, device = world.device) {
  const record = [...world.hub.records.values()].find((item) =>
    item.endpoint.includes(device.address),
  );
  return world.fake.discoveredDevices.find(
    (item) => record && item.external_id === world.hub.deviceId(record),
  );
}

/** A feature of a discovered device, by key. */
export const featureOf = (device, key) =>
  device.features.find((feature) => feature.external_id === `${device.external_id}:${key}`);

/** The last state of a feature of a fake device. */
export const stateOf = (world, key, device = world.device) =>
  world.fake.lastState(`${deviceOf(world, device).external_id}:${key}`);

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    if (!world.gladys.devices.some((item) => item.external_id === device.external_id)) {
      await world.fake.deviceCreated(device);
    }
  }
}

export { FakeSongpal };
