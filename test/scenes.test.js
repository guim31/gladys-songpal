// -----------------------------------------------------------------------------
// The scene actions: what a scene author types, the device turned on first,
// and what they return to the next actions.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeSongpal, createWorld, deviceOf, settle, stateOf } from './helpers/world.js';

test('choose a source by its name, the device in standby turned on first', async (t) => {
  const receiver = new FakeSongpal('str-dn1080', { power: 'standby' });
  const world = await createWorld({ devices: [receiver] });
  t.after(() => world.app.stop());
  const device = deviceOf(world, receiver).external_id;

  const ack = await world.fake.sceneAction('select_source', { device, source: 'blu ray' });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { source: 'Blu-ray' });
  assert.equal(receiver.power, 'active');
  assert.equal(receiver.playing[0].uri, 'extInput:hdmi?port=1');
  await settle();
  assert.equal(stateOf(world, 'source', receiver), 'extInput:hdmi?port=1');

  const unknown = await world.fake.sceneAction('select_source', { device, source: 'Phono' });
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /"Phono" is not a source of STR-DN1080/);
});

test('without a device: the first one', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const ack = await world.fake.sceneAction('select_source', { source: 'HDMI 1' });
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.device.playing[0].uri, 'extInput:hdmi?port=1');
  const gone = await world.fake.sceneAction('select_source', {
    device: 'ext:test-integration:audio:mac-00005e00ffff',
    source: 'TV',
  });
  assert.equal(gone.success, false);
  assert.match(gone.error, /not known to the integration/);
});

test('set the sound: mode, night, voice and volume in one step', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const { device } = world;
  const ack = await world.fake.sceneAction('set_sound', {
    device: deviceOf(world).external_id,
    sound_mode: 'movie',
    night_mode: 'on',
    voice: 'on',
    volume: 12,
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { sound_mode: 'Movie', volume: 12 });
  assert.equal(device.setting('soundField').currentValue, 'movie');
  assert.equal(device.setting('nightMode').currentValue, 'on');
  assert.equal(device.setting('voice').currentValue, 'on');
  assert.equal(device.mainVolume.volume, 12);

  // Nothing typed: nothing changed, the current values returned.
  const before = device.commands().length;
  const idle = await world.fake.sceneAction('set_sound', {
    device: deviceOf(world).external_id,
    night_mode: 'unchanged',
    voice: 'unchanged',
  });
  assert.deepEqual(idle.data.outputs, { sound_mode: 'Movie', volume: 12 });
  assert.equal(device.commands().length, before);
});

test('set the sound: voice levels of a 2017 sound bar, a speaker without night mode', async (t) => {
  const bar = new FakeSongpal('ht-st5000');
  const speaker = new FakeSongpal('srs-x77');
  const world = await createWorld({ devices: [bar, speaker] });
  t.after(() => world.app.stop());
  const on = await world.fake.sceneAction('set_sound', {
    device: deviceOf(world, bar).external_id,
    voice: 'on',
  });
  assert.equal(on.success, true, on.error);
  assert.equal(bar.setting('voice').currentValue, 'type1');
  await world.fake.sceneAction('set_sound', {
    device: deviceOf(world, bar).external_id,
    voice: 'off',
  });
  assert.equal(bar.setting('voice').currentValue, 'off');

  const refused = await world.fake.sceneAction('set_sound', {
    device: deviceOf(world, speaker).external_id,
    night_mode: 'on',
  });
  assert.equal(refused.success, false);
  assert.match(refused.error, /Kitchen speaker has no such setting/);
  // A sound mode of the speaker: its equalizer presets.
  const rock = await world.fake.sceneAction('set_sound', {
    device: deviceOf(world, speaker).external_id,
    sound_mode: 'Rock',
  });
  assert.deepEqual(rock.data.outputs, { sound_mode: 'Rock', volume: 12 });
});
