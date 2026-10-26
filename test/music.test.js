// The Gladys 5.3 music player: features, now playing from real answers of an
// HT-ZF9 (test/fixtures/songpal/ht-zf9-notifications.json), commands, artwork.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import {
  FEATURE_KEYS,
  emptyCapabilities,
  featureList,
  percentToVolume,
  volumeToPercent,
} from '../src/devices.js';
import { createArtworkHandler, nowPlayingOf } from '../src/music.js';
import { parsePlaying } from '../src/songpal/model.js';
import { FakeSongpal, createWorld, deviceOf, featureOf, settle, stateOf } from './helpers/world.js';

const REAL = JSON.parse(
  readFileSync(new URL('./fixtures/songpal/ht-zf9-notifications.json', import.meta.url)),
);

async function command(world, key, value, device = world.device) {
  const discovered = deviceOf(world, device);
  const ack = await world.fake.setValue(discovered, featureOf(discovered, key), value);
  await settle();
  return ack;
}

const nowPlaying = (world, device = world.device) =>
  Object.fromEntries(
    ['playback', 'title', 'artist', 'album', 'artwork', 'duration', 'position'].map((key) => [
      key,
      stateOf(world, key, device),
    ]),
  );

const IDLE = {
  playback: 2,
  title: '',
  artist: '',
  album: '',
  artwork: '',
  duration: 0,
  position: 0,
};

test('a player gets the music features of Gladys 5.3, the 1.0 ids kept', async (t) => {
  const world = await createWorld({ devices: [new FakeSongpal('ht-zf9')] });
  t.after(() => world.app.stop());
  const device = deviceOf(world);
  const feature = (key) => featureOf(device, key);
  assert.equal(feature('playback').type, 'playback_state');
  assert.equal(feature('playback').read_only, false);
  assert.equal(feature('playback').has_feedback, true);
  assert.equal(feature('playback').max, 2);
  // The mute switch of 1.0 becomes music/mute, same external id.
  assert.deepEqual(
    [feature('mute').category, feature('mute').type, feature('mute').has_feedback],
    ['music', 'mute', true],
  );
  for (const key of ['title', 'artist', 'album', 'artwork', 'duration']) {
    assert.equal(feature(key).category, 'music');
    assert.equal(feature(key).type, key);
    assert.equal(feature(key).read_only, true);
  }
  assert.equal(feature('position').read_only, false);
  assert.equal(feature('position').unit, 'seconds');
  assert.equal(feature('duration').unit, 'seconds');
  // Kept for the scenes and dashboards of 1.0.
  for (const key of ['play', 'pause', 'next', 'previous', 'volume']) {
    assert.ok(feature(key), key);
  }
  // No shuffle or repeat: nothing documented to confirm them.
  assert.equal(feature('shuffle'), undefined);
  assert.equal(feature('repeat'), undefined);
});

test('a device that cannot pause keeps its 1.0 features (mute switch, no player)', () => {
  const caps = { ...emptyCapabilities(), volume: { min: 0, max: 50 } };
  const features = featureList(caps, 'en');
  const mute = features.find((feature) => feature.key === FEATURE_KEYS.MUTE);
  assert.equal(mute.definition.category, 'switch');
  assert.equal(
    features.some((feature) => feature.key === FEATURE_KEYS.TITLE),
    false,
  );
});

test('on the TV input nothing is loaded: idle, texts empty; volume and mute published', async (t) => {
  const world = await createWorld({ devices: [new FakeSongpal('ht-zf9')] });
  t.after(() => world.app.stop());
  assert.deepEqual(nowPlaying(world), IDLE);
  assert.equal(typeof stateOf(world, 'volume'), 'number');
  assert.equal(stateOf(world, 'mute'), 0);
});

test('a real USB track of an HT-ZF9, then a folder browsed, an input, HDMI stopped', async (t) => {
  const device = new FakeSongpal('ht-zf9');
  const world = await createWorld({ devices: [device] });
  t.after(() => world.app.stop());

  device.setPlaying(REAL.usbTrack);
  await settle();
  assert.deepEqual(nowPlaying(world), {
    playback: 1,
    title: 'Three Dimensional Surround Experience',
    artist: 'Sony Corporation',
    album: 'Sony Sound Bar',
    artwork: '',
    duration: 128,
    position: 0,
  });

  // `kind: "directory"` has no state: what plays is unchanged (no flicker).
  const before = world.fake.states.length;
  device.notify('notifyPlayingContentInfo', REAL.directory);
  await settle();
  assert.equal(stateOf(world, 'title'), 'Three Dimensional Surround Experience');
  assert.equal(
    world.fake.states
      .slice(before)
      .some((state) => /:title$/.test(state.device_feature_external_id)),
    false,
  );

  // Back to an input (`kind`, the newer spelling of `contentKind`).
  device.setPlaying({ uri: 'extInput:tv', source: 'extInput:tv', ...REAL.input });
  await settle();
  assert.deepEqual(nowPlaying(world), IDLE);

  device.setPlaying(REAL.usbTrack);
  await settle();
  assert.equal(stateOf(world, 'playback'), 1);
  device.setPlaying(REAL.hdmiStopped);
  await settle();
  assert.deepEqual(nowPlaying(world), IDLE);
  // Only `parentUri` says it is HDMI: an input, nothing to pause.
  const refused = await command(world, 'playback', 0);
  assert.equal(refused.success, false);
  assert.match(refused.error, /cannot be paused/);
});

test('a reading without a state (folder browsed) leaves what plays as it was', async (t) => {
  const device = new FakeSongpal('ht-zf9');
  const world = await createWorld({ devices: [device] });
  t.after(() => world.app.stop());
  device.setPlaying(REAL.usbTrack);
  await settle();
  device.playing = [{ ...REAL.directory }];
  await world.hub.pollAll({ force: true });
  assert.equal(stateOf(world, 'title'), 'Three Dimensional Surround Experience');
  assert.equal(stateOf(world, 'playback'), 1);
});

test('the position given by the device moves on: never published back in time', async (t) => {
  const device = new FakeSongpal('ht-zf9');
  const world = await createWorld({ devices: [device] });
  t.after(() => world.app.stop());
  device.setPlaying({ ...REAL.usbTrack, positionMsec: 30_000 });
  await settle();
  assert.equal(stateOf(world, 'position'), 30);
  // 20 s later the volume changes (no new read of what plays), then a pause
  // from Gladys: the position published is the one of now, not the sample.
  world.clock.advance(20_000);
  device.changeVolume(10);
  await settle();
  assert.notEqual(stateOf(world, 'position'), 30);
  assert.equal((await command(world, 'playback', 0)).success, true);
  assert.equal(stateOf(world, 'playback'), 0);
  assert.equal(stateOf(world, 'position'), 50);
  // Never beyond the duration.
  const record = [...world.hub.records.values()][0];
  record.snapshot.playing = { ...record.snapshot.playing, state: 'PLAYING' };
  assert.equal(nowPlayingOf(record, 0, world.clock.now() + 600_000).position, 128);
});

test('the volume is a percent of the device range, both ways', () => {
  const range = { min: 0, max: 50 };
  assert.equal(volumeToPercent(25, range), 50);
  assert.equal(volumeToPercent(80, range), 100);
  assert.equal(percentToVolume(64, range), 32);
  assert.equal(percentToVolume(150, range), 50);
  assert.equal(percentToVolume(0, { min: 0, max: 74 }), 0);
  assert.equal(volumeToPercent(5, { min: 5, max: 5 }), 0);
});

test('after "Update" in Discover the music states go at once', async (t) => {
  const device = new FakeSongpal('ht-zf9');
  const world = await createWorld({ devices: [device] });
  t.after(() => world.app.stop());
  device.setPlaying(REAL.usbTrack);
  await settle();
  const before = world.fake.states.length;
  await world.fake.deviceUpdated(deviceOf(world));
  await settle();
  assert.ok(
    world.fake.states
      .slice(before)
      .some((state) => /:title$/.test(state.device_feature_external_id)),
  );
});

test('playback state written: 0 pause, 1 play, 2 stop, 3 refused', async (t) => {
  const device = new FakeSongpal('ht-zf9');
  const world = await createWorld({ devices: [device] });
  t.after(() => world.app.stop());
  device.setPlaying(REAL.usbTrack);
  await settle();

  assert.equal((await command(world, 'playback', 0)).success, true);
  assert.equal(device.playing[0].stateInfo.state, 'PAUSED');
  assert.equal(stateOf(world, 'playback'), 0);
  assert.equal((await command(world, 'playback', 1)).success, true);
  assert.equal(device.playing[0].stateInfo.state, 'PLAYING');
  assert.equal(stateOf(world, 'playback'), 1);
  assert.equal((await command(world, 'playback', 2)).success, true);
  assert.ok(device.calls.some((call) => call.method === 'stopPlayingContent'));
  assert.equal(stateOf(world, 'playback'), 2);
  // Play after a stop: the content is unloaded, started again from its URI
  // (the pause toggle would answer 7).
  const toggles = device.calls.filter((call) => call.method === 'pausePlayingContent').length;
  assert.equal((await command(world, 'playback', 1)).success, true);
  const restart = device.calls.findLast((call) => call.method === 'setPlayContent');
  assert.equal(restart.params[0].uri, REAL.usbTrack.uri);
  assert.equal(
    device.calls.filter((call) => call.method === 'pausePlayingContent').length,
    toggles,
  );
  assert.equal(stateOf(world, 'playback'), 1);
  // Buffering is on its way to play: a play sends nothing.
  device.setPlaying({ ...REAL.usbTrack, stateInfo: { state: 'BUFFERING' } });
  await settle();
  const sent = device.calls.length;
  assert.equal((await command(world, 'playback', 1)).success, true);
  assert.equal(
    device.calls.slice(sent).some((call) => /PlayContent|PlayingContent/.test(call.method)),
    false,
  );
  const refused = await command(world, 'playback', 3);
  assert.equal(refused.success, false);
  assert.match(refused.error, /pause \(0\), play \(1\) or stop \(2\)/);
});

test('position written: a USB track plays again from there; anything else refused', async (t) => {
  const device = new FakeSongpal('ht-zf9');
  const speaker = new FakeSongpal('srs-x77');
  const world = await createWorld({ devices: [device, speaker] });
  t.after(() => world.app.stop());
  device.setPlaying(REAL.usbTrack);
  await settle();

  assert.equal((await command(world, 'position', 60)).success, true);
  const call = device.calls.findLast((item) => item.method === 'setPlayContent');
  assert.equal(call.params[0].uri, REAL.usbTrack.uri);
  assert.equal(call.params[0].positionMsec, 60_000);
  assert.equal(call.version, '1.2');
  assert.equal(stateOf(world, 'position'), 60);

  // Spotify on the speaker: no position to go to.
  const refused = await command(world, 'position', 30, speaker);
  assert.equal(refused.success, false);
  assert.match(refused.error, /only a USB track/);
});

test('standby: idle and texts cleared, nothing else said', async (t) => {
  const device = new FakeSongpal('ht-zf9');
  const world = await createWorld({ devices: [device] });
  t.after(() => world.app.stop());
  device.setPlaying(REAL.usbTrack);
  await settle();
  device.pressPower('standby');
  await settle();
  await world.hub.pollAll({ force: true });
  assert.deepEqual(nowPlaying(world), IDLE);
  // What played before standby is forgotten: it cannot come back as PLAYING
  // when the device turns on, before it is read again.
  const record = [...world.hub.records.values()][0];
  assert.equal(record.snapshot.playing, null);
  assert.equal(record.clock?.base ?? 0, 0);
});

test('a source without position: counted, not republished at each read', async (t) => {
  const speaker = new FakeSongpal('srs-x77');
  const world = await createWorld({ devices: [speaker] });
  t.after(() => world.app.stop());
  assert.equal(stateOf(world, 'title'), 'A song');
  assert.equal(stateOf(world, 'duration'), 0);
  const positions = () =>
    world.fake.states.filter((state) => /:position$/.test(state.device_feature_external_id)).length;
  const before = positions();
  for (let i = 0; i < 3; i += 1) {
    world.clock.advance(10_000);
    await world.hub.pollAll({ force: true });
  }
  // Counted on the hub's clock: 30 s in, frozen by the pause.
  const record = [...world.hub.records.values()][0];
  assert.equal(nowPlayingOf(record, 30).position, 30);
  assert.equal((await command(world, 'playback', 0, speaker)).success, true);
  assert.ok(positions() > before);
  assert.equal(stateOf(world, 'position', speaker), 30);
});

test('the artwork of what plays: a key, served small enough for Gladys', async (t) => {
  const url = 'https://i.scdn.co/image/ab67616d0000b273cover';
  // A cover larger than the core accepts (300 KB): made smaller here.
  const width = 1200;
  const pixels = Buffer.alloc(width * width * 4);
  for (let i = 0; i < pixels.length; i += 1) {
    pixels[i] = (i * 7919) % 251;
  }
  const big = jpeg.encode({ data: pixels, width, height: width }, 95).data;
  assert.ok(big.length > 300 * 1024);
  const fetched = [];
  const fetchImpl = async (href) => {
    fetched.push(href);
    return new Response(big, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  const speaker = new FakeSongpal('srs-x77');
  const world = await createWorld({ devices: [speaker], fetchImpl });
  t.after(() => world.app.stop());
  speaker.setPlaying({ ...speaker.playing[0], content: { thumbnailUrl: url } });
  await settle();
  const key = stateOf(world, 'artwork');
  assert.equal(key, world.gladys.artworkKey(url));
  const ack = await world.fake.musicGetArtwork(key);
  assert.equal(ack.success, true, ack.error);
  const image = Buffer.from(ack.data.image, 'base64');
  assert.ok(jpeg.decode(image, { useTArray: true }).width <= 400);
  assert.ok(image.length <= 300 * 1024);
  assert.deepEqual([...image.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.deepEqual(fetched, [url]);

  // Not an http(s) URL: never published as an artwork.
  const record = { snapshot: { reachable: true, power: 'active' }, caps: emptyCapabilities() };
  record.snapshot.playing = parsePlaying([
    {
      uri: 'netService:audio',
      kind: 'service',
      stateInfo: { state: 'PLAYING' },
      title: 'x',
      content: { thumbnailUrl: 'file:///etc/passwd' },
    },
  ]);
  assert.equal(nowPlayingOf(record).artwork_url, null);
  // Nor a loopback written the way URL rewrites it.
  const local = await createArtworkHandler(
    { artworkUrls: new Map([['k', 'http://[::ffff:127.0.0.1]/a.jpg']]) },
    { fetchImpl: async () => assert.fail('fetched') },
  )('k').catch((err) => err);
  assert.match(local.message, /a local address/);
});
