// -----------------------------------------------------------------------------
// The notifications: which services get a socket, the subscription, the
// events, the retries; then the whole integration end to end over real HTTP
// and WebSocket on the loopback interface (the fake device served by a `ws`
// server, the integration on Node's built-in WebSocket client).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../src/app.js';
import { parseApiInfo } from '../src/songpal/client.js';
import { Notifier, subscriptionsOf } from '../src/songpal/notifier.js';
import { Store } from '../src/store.js';
import { FakeSongpal, createNetwork, fixture } from './helpers/fakeSongpal.js';
import { createSongpalServer } from './helpers/songpalServer.js';
import { settle } from './helpers/world.js';

const servicesOf = (name) =>
  parseApiInfo(fixture(name).responses['guide.getSupportedApiInfo'].result);

test('a socket per service that sends a notification the hub handles', () => {
  assert.deepEqual(subscriptionsOf(servicesOf('ht-zf9')), [
    {
      service: 'system',
      notifications: [
        { name: 'notifyPowerStatus', version: '1.0' },
        { name: 'notifySettingsUpdate', version: '1.0' },
      ],
    },
    { service: 'audio', notifications: [{ name: 'notifyVolumeInformation', version: '1.0' }] },
    {
      service: 'avContent',
      notifications: [
        { name: 'notifyPlayingContentInfo', version: '1.0' },
        { name: 'notifyExternalTerminalStatus', version: '1.0' },
      ],
    },
  ]);
  // No WebSocket protocol, or no switchNotifications: no socket.
  const services = servicesOf('ht-zf9');
  services.audio.protocols = ['xhrpost:jsonizer'];
  delete services.avContent.apis.switchNotifications;
  assert.deepEqual(
    subscriptionsOf(services).map((item) => item.service),
    ['system'],
  );
  assert.deepEqual(subscriptionsOf(servicesOf('bravia-tv')), []);
});

test('subscribed, the events arrive; closed, retried later; stopped, silent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = new FakeSongpal('ht-zf9');
  const network = createNetwork([device]);
  const events = [];
  const statuses = [];
  const notifier = new Notifier({
    endpoint: 'http://192.0.2.30:10000/sony',
    subscriptions: subscriptionsOf(servicesOf('ht-zf9')),
    WebSocketImpl: network.WebSocket,
    onEvent: (name, params, service) => events.push([service, name, params]),
    onStatus: (connected) => statuses.push(connected),
  });
  notifier.start();
  await settle();
  assert.equal(notifier.connected, true);
  assert.deepEqual(statuses, [true]);
  assert.deepEqual(
    network.WebSocket.opened.map((ws) => ws.url),
    [
      'ws://192.0.2.30:10000/sony/system',
      'ws://192.0.2.30:10000/sony/audio',
      'ws://192.0.2.30:10000/sony/avContent',
    ],
  );

  device.changeVolume(18);
  device.changeSetting('nightMode', 'on');
  await settle();
  assert.deepEqual(events, [
    ['audio', 'notifyVolumeInformation', { output: '', volume: 18, mute: 'off' }],
    [
      'system',
      'notifySettingsUpdate',
      {
        titleTextID: '',
        guideTextID: '',
        isAvailable: true,
        type: 'booleanTarget',
        title: 'Night',
        apiMappingUpdate: {
          service: 'audio',
          target: 'nightMode',
          currentValue: 'on',
          targetSuppl: '',
        },
      },
    ],
  ]);

  // Unplugged: the sockets close, and are opened again 10 s later, then 20 s…
  device.online = false;
  device.dropSockets();
  await settle();
  assert.equal(notifier.connected, false);
  assert.deepEqual(statuses, [true, false]);
  const opened = network.WebSocket.opened.length;
  t.mock.timers.tick(9_999);
  await settle();
  assert.equal(network.WebSocket.opened.length, opened);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(network.WebSocket.opened.length, opened + 3);
  device.online = true;
  // The device answers again: no need to wait for the next try.
  notifier.reconnectNow();
  await settle();
  assert.equal(notifier.connected, true);

  notifier.stop();
  device.changeVolume(19);
  await settle();
  assert.equal(events.length, 2);
  assert.equal(device.sockets.size, 0);
});

test('a refused subscription waits the longest delay', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const device = new FakeSongpal('ht-zf9');
  const network = createNetwork([device]);
  device.onSocketMessage = (socket, text) =>
    socket.sink(JSON.stringify({ id: JSON.parse(text).id, error: [15, 'Unsupported'] }));
  const notifier = new Notifier({
    endpoint: 'http://192.0.2.30:10000/sony',
    subscriptions: [
      { service: 'audio', notifications: [{ name: 'notifyVolumeInformation', version: '1.0' }] },
    ],
    WebSocketImpl: network.WebSocket,
    onEvent: () => {},
  });
  notifier.start();
  await settle();
  assert.equal(notifier.connected, false);
  t.mock.timers.tick(4 * 60_000);
  await settle();
  assert.equal(network.WebSocket.opened.length, 1);
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(network.WebSocket.opened.length, 2);
  notifier.stop();
});

test('end to end over real HTTP and WebSocket', async (t) => {
  const device = new FakeSongpal('ht-zf9', { address: '127.0.0.1' });
  const server = createSongpalServer(device);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  const gladys = createFakeGladys({ config: { hosts: `127.0.0.1:${port}`, language: 'en' } });
  // The real HTTP client and Node's WebSocket: no seam replaced.
  const app = registerHandlers(gladys, {
    store: new Store(mkdtempSync(join(tmpdir(), 'gladys-songpal-e2e-'))),
    timers: false,
  });
  t.after(async () => {
    // The integration first (its sockets), then the server and its idle
    // keep-alive connections.
    await app.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await gladys.connect();
  await app.ready;
  const [discovered] = gladys.fake.discoveredDevices;
  assert.equal(discovered.name, 'Sony HT-ZF9');
  assert.equal(discovered.params[0].value, `http://127.0.0.1:${port}/sony`);
  await gladys.fake.deviceCreated(discovered);
  const state = (key) => gladys.fake.lastState(`${discovered.external_id}:${key}`);
  assert.equal(state('volume'), 30);

  const record = [...app.hub.records.values()][0];
  for (let turn = 0; turn < 100 && !record.notifying; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(record.notifying, true, 'subscribed over WebSocket');

  // The remote changes the volume: the notification brings it.
  device.changeVolume(26);
  for (let turn = 0; turn < 100 && state('volume') !== 52; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state('volume'), 52);

  // Gladys changes the source: over HTTP.
  const feature = discovered.features.find((f) => f.external_id.endsWith(':source'));
  const ack = await gladys.fake.setValue(discovered, feature, 'extInput:hdmi?port=1');
  assert.equal(ack.success, true);
  assert.equal(device.playing[0].uri, 'extInput:hdmi?port=1');
  assert.equal(state('source'), 'extInput:hdmi?port=1');
});
