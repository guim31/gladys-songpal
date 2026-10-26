// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// (Adapted from guim31/gladys-sony-bravia.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, LANGUAGES, POLL_INTERVALS, VOLUME_STEPS } from '../src/config.js';
import { TRIGGERS, WIDGET_KEYS } from '../src/hub.js';
import { SCENE_ACTIONS, SWITCH_CHOICES } from '../src/scenes.js';
import { SSDP_SEARCH_TARGET } from '../src/songpal/discovery.js';
import { SLOT_COUNT, WIDGETS } from '../src/widgets.js';
import { createWorld, deviceOf } from './helpers/world.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Every list of form fields the manifest can declare (same field grammar).
const allFields = [
  ...(manifest.config_schema ?? []),
  ...[
    ...(manifest.actions ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ].flatMap((item) => item.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

const CAPABILITY_FIELDS = ['scene_triggers', 'scene_actions', 'widgets'];
const keysOf = (list) => (list ?? []).map((entry) => entry.key);

function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

test('identity: name, image, cover, local transport, multimedia category, SSDP search', () => {
  assert.equal(manifest.name, 'Sony Audio');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.docker_image, /^ghcr\.io\/guim31\/gladys-songpal:/);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/guim31/gladys-songpal/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['multimedia']);
  // The core sends the M-SEARCH: a single `st` per manifest for SSDP.
  assert.deepEqual(manifest.network_discovery, [{ type: 'ssdp', st: SSDP_SEARCH_TARGET }]);
  assert.equal(manifest.network_wake, undefined);
});

test('every manifest action has a handler', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.deepEqual(keysOf(manifest.actions), ['test_connection']);
  for (const action of manifest.actions) {
    const ack = await world.fake.action(action.key, {});
    assert.equal(ack.success, true, `${action.key}: ${ack.error}`);
  }
});

test('categories need Gladys >= 4.86.0, triggers, scene actions and widgets 5.1.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const declared = CAPABILITY_FIELDS.filter((field) => manifest[field] !== undefined);
  assert.deepEqual(declared, CAPABILITY_FIELDS);
  assert.ok(isAtLeast(minGladysVersion(), [5, 1, 0]));
  // The music player (`music`, Gladys 5.3.0) needs the newest core.
  assert.equal(manifest.gladys_version, '>=5.3.0');
  assert.deepEqual(manifest.music, {});
});

test('every scene_actions key has a handler, and returns the declared outputs', async (t) => {
  assert.deepEqual(keysOf(manifest.scene_actions).sort(), Object.keys(SCENE_ACTIONS).sort());
  const world = await createWorld();
  t.after(() => world.app.stop());
  const fields = {
    select_source: { source: 'HDMI 1' },
    set_sound: { sound_mode: 'Music', night_mode: 'off', voice: 'off', volume: 10 },
  };
  for (const action of manifest.scene_actions) {
    const ack = await world.fake.sceneAction(action.key, {
      device: deviceOf(world).external_id,
      ...fields[action.key],
    });
    assert.equal(ack.success, true, `${action.key}: ${ack.error}`);
    assert.deepEqual(
      Object.keys(ack.data.outputs).sort(),
      keysOf(action.outputs).sort(),
      `${action.key} outputs`,
    );
  }
  const setSound = manifest.scene_actions.find((action) => action.key === 'set_sound');
  for (const key of ['night_mode', 'voice']) {
    const field = setSound.fields.find((item) => item.key === key);
    assert.deepEqual(
      field.options.map((option) => option.value),
      Object.values(SWITCH_CHOICES),
    );
    assert.equal(field.default, SWITCH_CHOICES.UNCHANGED);
  }
});

test('the scene trigger is the one the hub fires, with its filters and variables', async (t) => {
  assert.deepEqual(keysOf(manifest.scene_triggers), Object.values(TRIGGERS));
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.device.play('extInput:hdmi?port=1');
  await world.hub.pollAll({ force: true });
  const [event] = world.fake.sceneEvents;
  assert.equal(event.key, TRIGGERS.SOURCE_CHANGED);
  const [trigger] = manifest.scene_triggers;
  for (const key of [...keysOf(trigger.fields), ...keysOf(trigger.variables)]) {
    assert.ok(key in event.data, `"${key}" is in the event data`);
  }
  for (const key of Object.keys(event.data)) {
    assert.ok(
      keysOf(trigger.variables).includes(key) || keysOf(trigger.fields).includes(key),
      `"${key}" is declared`,
    );
  }
});

test('every widgets key has a handler', async (t) => {
  assert.deepEqual(keysOf(manifest.widgets), Object.values(WIDGET_KEYS));
  assert.deepEqual(Object.keys(WIDGETS), Object.values(WIDGET_KEYS));
  const world = await createWorld();
  t.after(() => world.app.stop());
  for (const key of Object.values(WIDGET_KEYS)) {
    const ack = await world.fake.widgetGet(key, { settings: {} });
    assert.equal(ack.success, true, ack.error);
  }
  const sources = manifest.widgets.find((widget) => widget.key === WIDGET_KEYS.SOURCES);
  assert.deepEqual(keysOf(sources.settings), [
    'device',
    ...Array.from({ length: SLOT_COUNT }, (_, i) => `source_${i + 1}`),
  ]);
});

test('config_schema defaults and options stay consistent with the code', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
  const options = (key) =>
    manifest.config_schema.find((f) => f.key === key).options.map((o) => o.value);
  assert.deepEqual(options('language'), LANGUAGES);
  assert.deepEqual(options('poll_interval'), POLL_INTERVALS);
  assert.deepEqual(options('volume_step'), VOLUME_STEPS);
  assert.deepEqual(
    Object.keys(DEFAULT_CONFIG).sort(),
    manifest.config_schema
      .filter((f) => f.type !== 'section')
      .map((f) => f.key)
      .sort(),
  );
  // The API has no secret: the configuration holds none.
  assert.ok(manifest.config_schema.every((field) => field.type !== 'secret'));
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0);
  for (const section of sections) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.equal(section.placeholder, undefined);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('dynamic selects declare a source and no static options', () => {
  const dynamicSelects = allFields.filter((f) => f.source !== undefined);
  assert.ok(dynamicSelects.length > 0);
  for (const field of dynamicSelects) {
    assert.equal(field.source, 'devices');
    assert.equal(field.options, undefined);
  }
});

test('number fields have integer bounds and defaults (the form has no step)', () => {
  for (const field of allFields.filter((f) => f.type === 'number')) {
    for (const key of ['min', 'max', 'default']) {
      if (field[key] !== undefined) {
        assert.ok(Number.isInteger(field[key]), `field "${field.key}".${key} must be an integer`);
      }
    }
  }
});

test('actions declare no secret field, no required field (no default is applied)', () => {
  // Gladys#3154/#3155: a secret in an action form cannot be filled, and an
  // action applies no default while enforcing `required`.
  for (const action of manifest.actions ?? []) {
    for (const field of action.fields ?? []) {
      assert.notEqual(field.type, 'secret');
      assert.notEqual(field.required, true);
    }
  }
});

test('widget settings hold no secret, at most 10 fields, the device to show', () => {
  for (const widget of manifest.widgets) {
    assert.ok(widget.settings.length <= 10, `${widget.key}: too many settings`);
    assert.equal(widget.settings[0].key, 'device');
    for (const field of widget.settings) {
      assert.ok(['string', 'number', 'boolean', 'select', 'multi_select'].includes(field.type));
    }
  }
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.ok(manifest.docker_image.endsWith(`:${manifest.version}`));
});

test('the catalog description holds 10 to 100 characters per language', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} has ${text.length} characters (10 to 100 allowed)`,
    );
  }
});

test('every package the code imports is a production dependency (npm ci --omit=dev)', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(new URL('../src', import.meta.url), { recursive: true }))
    .filter((file) => file.endsWith('.js'))
    .map((file) => `src/${file}`);
  files.push('index.js');
  for (const file of files) {
    const code = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const [, name] of code.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)) {
      if (name.startsWith('.') || name.startsWith('node:')) {
        continue;
      }
      const root = name.startsWith('@')
        ? name.split('/').slice(0, 2).join('/')
        : name.split('/')[0];
      assert.ok(pkg.dependencies?.[root], `${file}: ${root} must be in dependencies`);
    }
  }
});
