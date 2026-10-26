// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from realistic
// fixtures (test/fixtures/songpal/): a 2018 and a 2017 sound bar, a wireless
// speaker and an AV receiver, on an input, on a network source or in standby,
// in every feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys". The
// option lists follow the core's normalizeSupportedOptions (unique values,
// non-empty labels, strings on text/select only).
// Do not loosen this test to make it pass: fix the integration.
// (Adapted from guim31/gladys-wled and guim31/gladys-sony-bravia.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PUSH_KEYS } from '../src/devices.js';
import { FakeSongpal, createWorld } from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const FAMILIES = ['ht-zf9', 'ht-st5000', 'srs-x77', 'str-dn1080'];
const all = () => FAMILIES.map((name) => new FakeSongpal(name));

const scenarios = [
  { label: 'four families, each on its usual source', devices: all },
  {
    label: 'a sound bar on HDMI, a speaker on Bluetooth',
    devices: () => {
      const bar = new FakeSongpal('ht-zf9');
      bar.play('extInput:hdmi?port=1');
      const speaker = new FakeSongpal('srs-x77');
      speaker.play('extInput:btAudio');
      return [bar, speaker];
    },
  },
  {
    label: 'a speaker paused on a network source',
    devices: () => {
      const speaker = new FakeSongpal('srs-x77');
      speaker.play('netService:audio', 'PAUSED');
      return [speaker];
    },
  },
  ...['en', 'fr', 'de', 'es'].map((language) => ({
    label: `four families, names in ${language}`,
    config: { language },
    devices: all,
  })),
];

/** The checks of one discovered device. */
// The string music types of Gladys 5.3 (capabilities/music.md, section 1).
const MUSIC_STRING_TYPES = new Set(['title', 'artist', 'album', 'artwork']);

function checkDevice(device, fake) {
  const where = device.name;

  // should_poll: true if and only if poll_frequency is provided, in ms.
  if (device.poll_frequency === undefined) {
    assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
  } else {
    assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
    assert.ok(
      table.poll_frequencies_ms.includes(device.poll_frequency),
      `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
    );
  }
  for (const param of device.params ?? []) {
    assert.ok(!/^GLADYS_/i.test(param.name), `${where}: reserved param ${param.name}`);
    assert.equal(typeof param.value, 'string');
  }

  assert.ok(device.features.length > 0, `${where}: no feature`);
  const externalIds = new Set();
  const names = new Set();
  for (const feature of device.features) {
    const at = `${where} / ${feature.name}`;
    const pair = table.pairs[`${feature.category}/${feature.type}`];
    assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
    assert.ok(pair.label_en && pair.label_fr && pair.icon, `${at}: couple without label or icon`);

    assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
    assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
    assert.ok(
      Number.isFinite(feature.min) && Number.isFinite(feature.max),
      `${at}: finite min/max`,
    );
    assert.ok(feature.min <= feature.max, `${at}: min > max`);
    assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
    assert.equal(typeof feature.has_feedback, 'boolean', `${at}: has_feedback must be a boolean`);
    if (feature.unit !== undefined) {
      assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
    }

    assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
    externalIds.add(feature.external_id);
    assert.ok(feature.external_id.startsWith(`${device.external_id}:`), `${at}: external_id`);
    assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
    names.add(feature.name);

    // The option lists, as the core's normalizeSupportedOptions wants them.
    const isSelect = feature.category === 'text' && feature.type === 'select';
    if (feature.supported_options !== undefined) {
      assert.ok(isSelect, `${at}: string options belong to text/select features only`);
      assert.ok(feature.supported_options.length > 0, `${at}: no option`);
      const values = feature.supported_options.map((option) => `${option.value}`);
      assert.equal(new Set(values).size, values.length, `${at}: duplicate option values`);
      for (const option of feature.supported_options) {
        assert.ok(
          typeof option.value === 'string' && option.value.trim().length > 0,
          `${at}: option value`,
        );
        assert.ok(
          typeof option.label === 'string' && option.label.trim().length > 0,
          `${at}: option label`,
        );
        assert.ok(Number.isInteger(option.sort_order), `${at}: option sort_order`);
      }
    } else {
      assert.ok(!isSelect, `${at}: a select without options`);
    }

    // The value published from the fixtures fits the feature.
    const key = feature.external_id.slice(device.external_id.length + 1);
    const value = fake.lastState(feature.external_id);
    if (PUSH_KEYS.has(key)) {
      assert.equal(value, undefined, `${at}: a push button has no state`);
      assert.equal(feature.read_only, false, `${at}: a push button is writable`);
      continue;
    }
    if (value === undefined) {
      // In standby only the power has something to say.
      assert.ok(fake.lastState(`${device.external_id}:power`) === 0, `${at}: no state published`);
      continue;
    }
    if (feature.category === 'music' && MUSIC_STRING_TYPES.has(feature.type)) {
      // Gladys 5.3: string states, empty when nothing is loaded; an artwork
      // is a key, never a URL.
      assert.equal(typeof value, 'string', `${at}: ${value} is not a text`);
      if (feature.type === 'artwork' && value !== '') {
        assert.match(value, /^[a-z0-9][a-z0-9-]{0,63}$/, `${at}: ${value} is not an image key`);
      }
    } else if (feature.category === 'text') {
      assert.equal(typeof value, 'string', `${at}: ${value} is not a text`);
      assert.ok(value.trim().length > 0, `${at}: empty text`);
      if (isSelect) {
        assert.ok(
          feature.supported_options.some((option) => option.value === value),
          `${at}: ${value} is not one of the options`,
        );
      }
    } else {
      assert.equal(typeof value, 'number', `${at}: ${value} is not a number`);
      assert.ok(value >= feature.min && value <= feature.max, `${at}: ${value} out of bounds`);
    }
  }

  // The core's Music box reads all of them once it lists the device.
  const types = device.features.filter((f) => f.category === 'music').map((f) => f.type);
  if (types.includes('play')) {
    for (const type of ['pause', 'previous', 'next', 'volume', 'playback_state']) {
      assert.ok(types.includes(type), `${where}: music/${type} missing next to music/play`);
    }
  }
  // Only one `volume` type: the Music box takes the first it finds.
  assert.ok(
    device.features.filter((f) => f.type === 'volume').length <= 1,
    `${where}: two features of type volume`,
  );
}

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const devices = scenario.devices();
    const world = await createWorld({ config: scenario.config ?? { language: 'en' }, devices });
    try {
      const discovered = world.fake.discoveredDevices;
      assert.equal(discovered.length, devices.length);
      assert.equal(new Set(discovered.map((device) => device.external_id)).size, discovered.length);
      for (const device of discovered) {
        checkDevice(device, world.fake);
      }
    } finally {
      await world.app.stop();
    }
  });
}

test('every device follows the Gladys rules in standby, and known from /data only', async () => {
  const devices = all();
  const first = await createWorld({ devices });
  await first.app.stop();
  // Next start: every device in standby, then unplugged.
  for (const device of devices) {
    device.power = 'standby';
  }
  const asleep = await createWorld({
    devices,
    dataDir: first.dataDir,
    created: first.fake.discoveredDevices,
    discover: false,
  });
  try {
    assert.equal(asleep.fake.discoveredDevices.length, devices.length);
    for (const device of asleep.fake.discoveredDevices) {
      checkDevice(device, asleep.fake);
      assert.equal(asleep.fake.lastState(`${device.external_id}:power`), 0);
    }
    for (const device of devices) {
      device.online = false;
    }
    await asleep.hub.pollAll({ force: true });
    for (const device of asleep.fake.discoveredDevices) {
      checkDevice(device, asleep.fake);
    }
  } finally {
    await asleep.app.stop();
  }
});
