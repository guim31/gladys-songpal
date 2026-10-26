// -----------------------------------------------------------------------------
// The hub against fake devices: the search of the Discovery tab, the
// commands of every feature, the notifications, standby and unplugged
// devices, a new IP address, the addresses typed in the configuration, the
// restart from /data and the "Test the connection" report.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRIGGERS, WIDGET_KEYS } from '../src/hub.js';
import {
  FakeSongpal,
  createAll,
  createClock,
  createWorld,
  deviceOf,
  featureOf,
  settle,
  stateOf,
} from './helpers/world.js';

const FAMILIES = ['ht-zf9', 'ht-st5000', 'srs-x77', 'str-dn1080', 'bravia-tv'];

/** Run a feature command as Gladys does; resolves with its ack. */
async function command(world, key, value, device = world.device) {
  const discovered = deviceOf(world, device);
  const ack = await world.fake.setValue(discovered, featureOf(discovered, key), value);
  await settle();
  return ack;
}

// --- Search ------------------------------------------------------------------

test('the search finds the Sony audio devices, not the TV nor the noise', async (t) => {
  const devices = FAMILIES.map((name) => new FakeSongpal(name));
  const world = await createWorld({ devices, discover: false });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices.length, 0);
  assert.equal(world.fake.connectionStatus.connected, false);

  await world.fake.scanRequest();
  assert.deepEqual(world.fake.scans, [{ type: 'ssdp', timeout_seconds: 5 }]);
  const discovered = world.fake.discoveredDevices;
  assert.deepEqual(discovered.map((device) => device.name).sort(), [
    'HT-ST5000',
    'Kitchen speaker',
    'Living room sound bar',
    'STR-DN1080',
  ]);
  const bar = deviceOf(world);
  assert.equal(bar.external_id, 'ext:test-integration:audio:mac-00005e005330');
  assert.deepEqual(bar.params, [
    { name: 'SONGPAL_ENDPOINT', value: 'http://192.0.2.30:10000/sony' },
    { name: 'SONGPAL_MODEL', value: 'HT-ZF9' },
  ]);
  assert.equal(bar.should_poll, false);
  // The TV answered the API description, nothing more was asked to it.
  const tv = world.network.devices.get('192.0.2.40');
  assert.ok(tv.calls.every((call) => call.method !== 'getPowerStatus'));
  // The description of 192.0.2.50 points elsewhere: never fetched there.
  assert.ok(!world.network.devices.has('198.51.100.7'));
  // Not added to Gladys yet: no state, no notification socket.
  assert.equal(world.fake.states.length, 0);
  assert.equal(world.network.WebSocket.opened.length, 0);
  assert.equal(world.fake.connectionStatus.connected, true);

  // Added: its states, then its notifications.
  await createAll(world);
  await settle();
  assert.equal(stateOf(world, 'power'), 1);
  assert.equal(stateOf(world, 'volume'), 15);
  assert.equal(stateOf(world, 'source'), 'extInput:tv');
  assert.ok(world.network.WebSocket.opened.length >= 3);
  assert.ok([...world.hub.records.values()].every((record) => record.notifying));
});

test('a device added in Gladys is sent all its states and nudges the widgets', async (t) => {
  const world = await createWorld({ discover: false });
  t.after(() => world.app.stop());
  await world.fake.scanRequest();
  const before = world.fake.widgetRefreshes.length;
  await createAll(world);
  assert.equal(stateOf(world, 'power'), 1);
  assert.equal(stateOf(world, 'sound_mode'), 'standard');
  assert.equal(stateOf(world, 'subwoofer'), 0);
  assert.ok(world.fake.widgetRefreshes.length > before);
  assert.deepEqual(
    [...new Set(world.fake.widgetRefreshes)].sort(),
    Object.values(WIDGET_KEYS).sort(),
  );
});

test('a search again forgets what is gone, keeps what was added', async (t) => {
  const bar = new FakeSongpal('ht-zf9');
  const speaker = new FakeSongpal('srs-x77');
  const world = await createWorld({ devices: [bar, speaker], discover: false });
  t.after(() => world.app.stop());
  await world.fake.scanRequest();
  assert.equal(world.fake.discoveredDevices.length, 2);
  await world.fake.deviceCreated(deviceOf(world, bar));
  bar.online = false;
  speaker.online = false;
  await world.fake.scanRequest();
  // The bar is in Gladys: still listed. The speaker was not: gone.
  assert.deepEqual(
    world.fake.discoveredDevices.map((device) => device.name),
    ['Living room sound bar'],
  );
});

// --- Commands ----------------------------------------------------------------

test('power, volume, mute: the device follows, the states too', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { device } = world;

  assert.equal((await command(world, 'power', 0)).success, true);
  assert.equal(device.power, 'standby');
  assert.equal(stateOf(world, 'power'), 0);
  assert.equal((await command(world, 'power', 1)).success, true);
  assert.equal(device.power, 'active');
  assert.equal(stateOf(world, 'power'), 1);
  // Already on: the device answers 40000, a success.
  assert.equal((await command(world, 'power', 1)).success, true);

  await command(world, 'volume', 32);
  assert.equal(device.mainVolume.volume, 32);
  assert.equal(stateOf(world, 'volume'), 32);
  // Beyond the bounds of the device: clamped, never refused.
  await command(world, 'volume', 80);
  assert.equal(device.mainVolume.volume, 50);
  assert.equal(stateOf(world, 'volume'), 50);
  const setVolume = device.calls.filter((call) => call.method === 'setAudioVolume').at(-1);
  assert.deepEqual(setVolume, {
    service: 'audio',
    method: 'setAudioVolume',
    params: [{ output: '', volume: '50' }],
    version: '1.1',
  });

  await command(world, 'mute', 1);
  assert.equal(device.mainVolume.mute, 'on');
  assert.equal(stateOf(world, 'mute'), 1);
  await command(world, 'mute', 0);
  assert.equal(stateOf(world, 'mute'), 0);
});

test('source, sound mode, night mode, voice and subwoofer on a sound bar', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { device } = world;

  await command(world, 'source', 'extInput:hdmi?port=1');
  assert.equal(device.playing[0].uri, 'extInput:hdmi?port=1');
  assert.equal(stateOf(world, 'source'), 'extInput:hdmi?port=1');
  const other = await command(world, 'source', 'other');
  assert.equal(other.success, false);
  assert.match(other.error, /Choose one of the sources/);
  const unknown = await command(world, 'source', 'extInput:usb');
  assert.equal(unknown.success, false);

  await command(world, 'sound_mode', 'movie');
  assert.equal(device.setting('soundField').currentValue, 'movie');
  assert.equal(stateOf(world, 'sound_mode'), 'movie');
  await command(world, 'night_mode', 1);
  assert.equal(device.setting('nightMode').currentValue, 'on');
  assert.equal(stateOf(world, 'night_mode'), 1);
  await command(world, 'voice', 1);
  assert.equal(device.setting('voice').currentValue, 'on');
  assert.equal(stateOf(world, 'voice'), 1);
  await command(world, 'subwoofer', 4);
  assert.equal(device.setting('subwooferLevel').currentValue, '4');
  assert.equal(stateOf(world, 'subwoofer'), 4);
  // Out of bounds: clamped to the device's.
  await command(world, 'subwoofer', -20);
  assert.equal(device.setting('subwooferLevel').currentValue, '-6');
});

test('voice levels on a 2017 sound bar, subwoofer in half dB on a receiver', async (t) => {
  const bar = new FakeSongpal('ht-st5000');
  const receiver = new FakeSongpal('str-dn1080');
  const world = await createWorld({ devices: [bar, receiver] });
  t.after(() => world.app.stop());

  const barDevice = deviceOf(world, bar);
  assert.equal(featureOf(barDevice, 'voice').type, 'select');
  assert.deepEqual(
    featureOf(barDevice, 'voice').supported_options.map((option) => option.value),
    ['type1', 'type2', 'type3', 'off'],
  );
  await command(world, 'voice', 'type3', bar);
  assert.equal(bar.setting('voice').currentValue, 'type3');
  assert.equal(stateOf(world, 'voice', bar), 'type3');
  // The labelled input keeps its label, the hidden entry is left out.
  assert.deepEqual(
    featureOf(barDevice, 'source').supported_options.map((option) => option.label),
    ['Console', 'HDMI2', 'HDMI3', 'TV', 'Bluetooth', 'Other (network, app)'],
  );

  const receiverDevice = deviceOf(world, receiver);
  assert.equal(featureOf(receiverDevice, 'volume').max, 74);
  assert.equal(featureOf(receiverDevice, 'subwoofer').min, -10);
  assert.equal(stateOf(world, 'subwoofer', receiver), -2.5);
  await command(world, 'subwoofer', 3.3, receiver);
  const set = receiver.calls.filter((call) => call.method === 'setSpeakerSettings').at(-1);
  assert.deepEqual(set.params, [{ settings: [{ target: 'subwooferLevel', value: '3.5' }] }]);
  // The zones are not sources; the volume is the main zone's.
  assert.ok(
    featureOf(receiverDevice, 'source').supported_options.every(
      (option) => !option.value.startsWith('extOutput:'),
    ),
  );
  await command(world, 'volume', 40, receiver);
  assert.equal(receiver.volumes[0].volume, 40);
  assert.equal(receiver.volumes[1].volume, 20);
  assert.equal(stateOf(world, 'mute', receiver), 0);
});

test('play, pause, next on a network source; refused on an input', async (t) => {
  const speaker = new FakeSongpal('srs-x77');
  const world = await createWorld({ devices: [speaker] });
  t.after(() => world.app.stop());
  assert.equal(stateOf(world, 'playback', speaker), 1);
  assert.equal(stateOf(world, 'source', speaker), 'other');

  await command(world, 'pause', 1, speaker);
  assert.equal(speaker.playing[0].stateInfo.state, 'PAUSED');
  assert.equal(stateOf(world, 'playback', speaker), 0);
  // Already paused: nothing sent (the device toggles).
  const before = speaker.commands().length;
  await command(world, 'pause', 1, speaker);
  assert.equal(speaker.commands().length, before);
  await command(world, 'play', 1, speaker);
  assert.equal(speaker.playing[0].stateInfo.state, 'PLAYING');
  assert.equal(stateOf(world, 'playback', speaker), 1);
  assert.equal((await command(world, 'next', 1, speaker)).success, true);
  assert.ok(speaker.calls.some((call) => call.method === 'setPlayNextContent'));

  await command(world, 'source', 'extInput:btAudio', speaker);
  // An input: nothing loaded on the player (Gladys 5.3: IDLE).
  assert.equal(stateOf(world, 'playback', speaker), 2);
  const refused = await command(world, 'pause', 1, speaker);
  assert.equal(refused.success, false);
  assert.match(refused.error, /cannot be paused/);
});

test('a source chosen in standby turns the device on first, acknowledged in time', async (t) => {
  const device = new FakeSongpal('ht-zf9');
  const clock = createClock();
  // A real wait between the power reads, and a device that boots slowly.
  clock.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20)));
  const world = await createWorld({
    devices: [device],
    clock,
    timings: { featureAckMs: 30, powerOnCheckMs: 1, powerOnWaitMs: 60_000 },
  });
  t.after(() => world.app.stop());
  await command(world, 'power', 0);
  device.bootReads = 4;
  const startedAt = Date.now();
  const ack = await command(world, 'source', 'extInput:hdmi?port=1');
  assert.equal(ack.success, true);
  assert.ok(Date.now() - startedAt < 200, 'acknowledged before the device finished');
  for (let turn = 0; turn < 50 && device.playing[0].uri !== 'extInput:hdmi?port=1'; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(device.power, 'active');
  assert.equal(device.playing[0].uri, 'extInput:hdmi?port=1');
});

// --- Notifications -------------------------------------------------------------

test('the remote, the TV or the app: the notifications update Gladys at once', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { device } = world;
  const reads = () => device.calls.filter((call) => call.method === 'getVolumeInformation').length;
  const before = reads();

  device.changeVolume(27);
  await settle();
  assert.equal(stateOf(world, 'volume'), 27);
  device.changeVolume(27, true);
  await settle();
  assert.equal(stateOf(world, 'mute'), 1);
  device.changeSetting('soundField', 'music');
  await settle();
  assert.equal(stateOf(world, 'sound_mode'), 'music');
  device.changeSetting('nightMode', 'on');
  await settle();
  assert.equal(stateOf(world, 'night_mode'), 1);
  // Applied from the notification itself: no read needed.
  assert.equal(reads(), before);

  device.play('extInput:hdmi?port=1');
  await settle();
  assert.equal(stateOf(world, 'source'), 'extInput:hdmi?port=1');
  device.pressPower('standby');
  await settle();
  assert.equal(stateOf(world, 'power'), 0);
});

test('the source changes fire the scene event, with the names', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { device } = world;
  assert.equal(world.fake.sceneEvents.length, 0, 'not on the first reading');

  device.play('extInput:hdmi?port=1');
  await settle();
  await command(world, 'source', 'extInput:btAudio');
  // Back to the same source after a standby: no event; another one: an event.
  await command(world, 'power', 0);
  await command(world, 'power', 1);
  await world.hub.pollAll({ force: true });
  const external = deviceOf(world).external_id;
  assert.deepEqual(world.fake.sceneEvents, [
    {
      key: TRIGGERS.SOURCE_CHANGED,
      data: {
        device: external,
        device_name: 'Living room sound bar',
        source: 'HDMI 1',
        previous_source: 'TV',
      },
    },
    {
      key: TRIGGERS.SOURCE_CHANGED,
      data: {
        device: external,
        device_name: 'Living room sound bar',
        source: 'Bluetooth Audio',
        previous_source: 'HDMI 1',
      },
    },
  ]);
});

test('the notifications come back after the device was unplugged', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { device } = world;
  const record = [...world.hub.records.values()][0];
  assert.equal(record.notifying, true);

  device.online = false;
  device.dropSockets();
  await settle();
  assert.equal(record.notifying, false);
  // The first retries meet nobody.
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(record.notifying, false);
  device.online = true;
  t.mock.timers.tick(20_000);
  await settle();
  assert.equal(record.notifying, true);
  device.changeVolume(9);
  await settle();
  assert.equal(stateOf(world, 'volume'), 9);
});

// --- Standby, unplugged, moved -------------------------------------------------

test('standby, then unplugged: power off, transport unreachable, then back', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { device } = world;
  const external = deviceOf(world).external_id;
  const transport = () =>
    world.fake.transports.filter((entry) => entry.device_external_id === external).at(-1)
      ?.transport;
  assert.equal(transport(), 'local');

  device.power = 'standby';
  await world.hub.pollAll({ force: true });
  assert.equal(stateOf(world, 'power'), 0);
  // Standby reads only the power: the device refuses the rest anyway.
  const last = device.calls.at(-1);
  assert.equal(last.method, 'getPowerStatus');

  device.online = false;
  await world.hub.pollAll({ force: true });
  assert.equal(transport(), 'unreachable');
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.match(world.fake.connectionStatus.message.en, /No device answers/);

  device.online = true;
  device.power = 'active';
  await world.hub.pollAll({ force: true });
  assert.equal(transport(), 'local');
  assert.equal(stateOf(world, 'power'), 1);
  assert.equal(world.fake.connectionStatus.connected, true);
});

test('a new IP address: the search moves the device, same Gladys device', async (t) => {
  const device = new FakeSongpal('ht-zf9');
  const world = await createWorld({ devices: [device] });
  t.after(() => world.app.stop());
  const external = deviceOf(world).external_id;

  // DHCP gave it another address.
  const moved = new FakeSongpal('ht-zf9', { address: '192.0.2.130' });
  device.online = false;
  world.network.devices.set('192.0.2.130', moved);
  await world.hub.pollAll({ force: true });
  assert.equal(stateOf(world, 'power'), 0);

  world.fake.scanResults.ssdp = world.fake.scanResults.ssdp.map((answer) =>
    answer.source_ip === '192.0.2.30'
      ? {
          ...answer,
          source_ip: '192.0.2.130',
          headers: answer.headers.replaceAll('192.0.2.30', '192.0.2.130'),
        }
      : answer,
  );
  await world.fake.scanRequest();
  const discovered = world.fake.discoveredDevices.find((item) => item.external_id === external);
  assert.equal(discovered.params[0].value, 'http://192.0.2.130:10000/sony');
  assert.equal(world.fake.lastState(`${external}:power`), 1);
  moved.changeVolume(31);
  await settle();
  assert.equal(world.fake.lastState(`${external}:volume`), 31);
});

// --- Configuration ---------------------------------------------------------------

test('an address typed in the configuration: read without the search', async (t) => {
  const receiver = new FakeSongpal('str-dn1080');
  receiver.online = false;
  const world = await createWorld({
    devices: [receiver],
    config: { hosts: '192.0.2.33, nonsense:port:x', language: 'en' },
    discover: false,
  });
  t.after(() => world.app.stop());
  assert.equal(world.fake.discoveredDevices.length, 0);
  assert.match(world.fake.connectionStatus.message.en, /Address not understood/);

  // Plugged in: found at the next cycle, monitored without being added.
  receiver.online = true;
  await world.hub.identifyPending();
  assert.equal(world.fake.discoveredDevices.length, 1);
  const record = [...world.hub.records.values()][0];
  assert.equal(record.manual, true);
  assert.equal(record.notifying, false);
  await settle();
  assert.equal(record.notifying, true);

  await world.fake.configUpdated({ hosts: '192.0.2.33', language: 'en' });
  assert.equal(world.fake.connectionStatus.connected, true);
});

test('a restart without the device: its Gladys device and lists come from /data', async (t) => {
  const device = new FakeSongpal('ht-zf9');
  const first = await createWorld({ devices: [device] });
  const created = first.fake.discoveredDevices;
  await first.app.stop();

  device.online = false;
  const second = await createWorld({
    devices: [device],
    created,
    dataDir: first.dataDir,
    discover: false,
  });
  t.after(() => second.app.stop());
  assert.deepEqual(second.fake.discoveredDevices, created);
  assert.equal(stateOf(second, 'power'), 0);

  device.online = true;
  await second.hub.pollAll({ force: true });
  await settle();
  assert.equal(stateOf(second, 'power'), 1);
  assert.equal([...second.hub.records.values()][0].notifying, true);
});

test('a device in Gladys whose /data was lost: identified again from its params', async (t) => {
  const device = new FakeSongpal('srs-x77');
  const first = await createWorld({ devices: [device] });
  const created = first.fake.discoveredDevices;
  await first.app.stop();

  const second = await createWorld({ devices: [device], created, discover: false });
  t.after(() => second.app.stop());
  assert.deepEqual(
    second.fake.discoveredDevices.map((item) => item.external_id),
    created.map((item) => item.external_id),
  );
  assert.equal(stateOf(second, 'volume', device), 12);
});

test('"Test the connection" reports every device', async (t) => {
  const bar = new FakeSongpal('ht-zf9');
  const speaker = new FakeSongpal('srs-x77', { power: 'standby' });
  const world = await createWorld({
    devices: [bar, speaker],
    config: { hosts: '192.0.2.99, http://user:pass@192.0.2.98', language: 'en' },
  });
  t.after(() => world.app.stop());
  const ack = await world.fake.action('test_connection', {});
  assert.equal(ack.success, true);
  const report = ack.data.message;
  assert.match(
    report,
    /Living room sound bar \(192\.0\.2\.30\): on, TV, volume 15, live updates on/,
  );
  assert.match(report, /Kitchen speaker \(192\.0\.2\.32\): in standby/);
  assert.match(report, /192\.0\.2\.99: does not answer/);
  assert.match(report, /address not understood: http:\/\/user:pass@192\.0\.2\.98/);

  const empty = await createWorld({ devices: [], discover: false });
  t.after(() => empty.app.stop());
  const none = await empty.fake.action('test_connection', {});
  assert.match(none.data.message, /No device yet/);
});

test('the states are sent with a heartbeat of at most 12 hours', async (t) => {
  const world = await createWorld({ discover: false });
  t.after(() => world.app.stop());
  const heartbeats = [];
  const publish = world.gladys.publishChangedStates.bind(world.gladys);
  world.gladys.publishChangedStates = async (states, options) => {
    heartbeats.push(options?.heartbeat);
    return publish(states, options);
  };
  await world.fake.scanRequest();
  await createAll(world);
  assert.ok(heartbeats.length > 0);
  for (const heartbeat of heartbeats) {
    assert.ok(heartbeat > 0 && heartbeat <= 12 * 60 * 60_000, `heartbeat ${heartbeat}`);
  }
});

test('a reading that overlaps a command is not applied', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { device } = world;
  const record = [...world.hub.records.values()][0];
  // The device answers the read with the volume of before the command.
  const original = device.handle.bind(device);
  device.handle = (request) => {
    const answer = original(request);
    if (request.body?.includes('getVolumeInformation')) {
      device.mainVolume.volume = 44;
      return answer;
    }
    return answer;
  };
  const reading = world.hub.poll(record, { force: true });
  await world.hub.setVolume(record, 20);
  await reading;
  device.handle = original;
  assert.equal(stateOf(world, 'volume'), 20);
});
