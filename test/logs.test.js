// -----------------------------------------------------------------------------
// What the integration writes in its logs, and the timer that reads the
// devices. At the info level only the life cycle shows: a normal evening
// (reads, states, notifications, sources that change, standby and back)
// writes nothing, and a problem that lasts writes one line, then one when it
// is gone. No address with credentials ever reaches the logs.
// The core never polls these devices (should_poll: false, and GladysAssistant/
// Gladys#3198): the container's own timer must read them.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSongpal, createWorld, deviceOf, settle, stateOf } from './helpers/world.js';

/** Every line the SDK logger writes (console.log for debug/info, console.error above). */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = previous;
    }
  });
  const lines = [];
  const keep = (...args) => lines.push(args.map(String).join(' '));
  t.mock.method(console, 'log', keep);
  t.mock.method(console, 'error', keep);
  t.mock.method(console, 'warn', keep);
  t.mock.method(console, 'info', keep);
  return lines;
}

test('a normal evening writes nothing at the info level', async (t) => {
  const devices = ['ht-zf9', 'srs-x77', 'str-dn1080'].map((name) => new FakeSongpal(name));
  const world = await createWorld({ devices });
  t.after(() => world.app.stop());
  const lines = captureLogs(t);
  const [bar, speaker] = devices;
  for (let round = 0; round < 3; round += 1) {
    bar.changeVolume(20 + round);
    bar.changeSetting('soundField', round % 2 ? 'movie' : 'music');
    bar.play('extInput:hdmi?port=1');
    speaker.play('netService:audio', round % 2 ? 'PAUSED' : 'PLAYING');
    await settle();
    await world.hub.pollAll({ force: true });
    bar.play('extInput:tv');
    // The night: standby, read again and again.
    bar.pressPower('standby');
    await settle();
    for (let read = 0; read < 3; read += 1) {
      await world.hub.pollAll({ force: true });
    }
    // The morning.
    bar.pressPower('active');
    await settle();
    await world.hub.pollAll({ force: true });
  }
  assert.ok(world.fake.states.length > 10, 'states were published');
  assert.ok(world.fake.sceneEvents.length > 3, 'events were fired');
  assert.deepEqual(lines, []);
});

test('a problem that lasts: one line, then one when it is gone', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const lines = captureLogs(t);

  world.device.online = false;
  for (let read = 0; read < 4; read += 1) {
    await world.hub.pollAll({ force: true });
  }
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[WARN\].*Living room sound bar \(192\.0\.2\.30\) does not answer/);
  world.device.online = true;
  await world.hub.pollAll({ force: true });
  await world.hub.pollAll({ force: true });
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[1], /\[INFO\].*Living room sound bar: answers again/);

  // Gladys refuses the states (restarting): one warning, then one line back.
  lines.length = 0;
  const publish = world.gladys.publishChangedStates.bind(world.gladys);
  world.gladys.publishChangedStates = async () => {
    throw new Error('HTTP 503');
  };
  for (let read = 0; read < 4; read += 1) {
    world.device.mainVolume.volume = 40 + read;
    await world.hub.pollAll({ force: true });
  }
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /\[WARN\].*States of Living room sound bar refused: HTTP 503/);
  world.gladys.publishChangedStates = publish;
  await world.hub.pollAll({ force: true });
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[1], /\[INFO\].*States: working again/);
  assert.equal(stateOf(world, 'volume'), 43);
});

test('one line per user action, and never the credentials of an address', async (t) => {
  const world = await createWorld({
    config: { hosts: 'http://admin:s3cr3t-pass@192.0.2.97/, 192.0.2.96', language: 'en' },
  });
  t.after(() => world.app.stop());
  const lines = captureLogs(t, 'debug');
  const discovered = deviceOf(world);
  await world.fake.setValue(
    discovered,
    discovered.features.find((f) => f.external_id.endsWith(':volume')),
    25,
  );
  await world.fake.action('test_connection', {});
  await world.fake.configUpdated({ hosts: 'http://admin:s3cr3t-pass@192.0.2.97/', language: 'en' });
  await world.hub.pollAll({ force: true });
  await settle();
  const info = lines.filter((line) => /\[INFO\]/.test(line));
  assert.ok(
    info.some((line) => /Living room sound bar: volume 25/.test(line)),
    info.join('\n'),
  );
  for (const line of lines) {
    assert.ok(!line.includes('s3cr3t-pass') && !line.includes('admin:'), line);
  }
});

test('the container reads the devices on its own timer, without any poll from Gladys', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // No WebSocket: the timer is the only way the states change.
  const world = await createWorld({ timers: true, websocket: false });
  t.after(() => world.app.stop());
  assert.equal(deviceOf(world).should_poll, false);
  // Nothing here calls `fake.poll` (the onPoll of Gladys): only the timer reads.
  assert.equal(stateOf(world, 'volume'), 15);
  const interval = world.hub.config.pollIntervalMs;
  world.device.mainVolume.volume = 33;
  world.clock.advance(interval);
  t.mock.timers.tick(interval);
  for (let turn = 0; turn < 200 && stateOf(world, 'volume') !== 33; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(stateOf(world, 'volume'), 33);
  // And again at the next interval: the timer is set again after each read.
  world.device.mainVolume.volume = 34;
  world.clock.advance(interval);
  t.mock.timers.tick(interval);
  for (let turn = 0; turn < 200 && stateOf(world, 'volume') !== 34; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(stateOf(world, 'volume'), 34);
});

test('while the notifications work, the timer reads every 5 minutes only', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const world = await createWorld({ timers: true });
  t.after(() => world.app.stop());
  const reads = () => world.device.calls.filter((c) => c.method === 'getPowerStatus').length;
  const interval = world.hub.config.pollIntervalMs;
  const before = reads();
  for (let cycle = 0; cycle < 8; cycle += 1) {
    world.clock.advance(interval);
    t.mock.timers.tick(interval);
    await settle(10);
  }
  // 8 × 30 s = 4 min: not due yet (a little slack: the next one is).
  assert.equal(reads(), before);
  world.clock.advance(interval);
  t.mock.timers.tick(interval);
  await settle(10);
  assert.equal(reads(), before + 1);
  // onPoll of Gladys, as a fallback: skipped, the device was just read.
  await world.fake.poll(deviceOf(world));
  assert.equal(reads(), before + 1);
});
