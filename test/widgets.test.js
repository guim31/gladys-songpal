// -----------------------------------------------------------------------------
// The dashboard widgets: their content in the core vocabulary (checked by the
// SDK's validateWidgetContent, budget included), their buttons, and what the
// taps do.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { ACTIONS, TEXT } from '../src/widgets.js';
import { WIDGET_KEYS } from '../src/hub.js';
import { FakeSongpal, createWorld, deviceOf, settle } from './helpers/world.js';

async function content(world, key, settings = {}, language = 'en') {
  const ack = await world.fake.widgetGet(key, { settings, language });
  assert.equal(ack.success, true, ack.error);
  // What the core would refuse, drop or alter: nothing.
  assert.deepEqual(validateWidgetContent(ack.data.content), []);
  return ack.data.content;
}

const buttons = (widget) => widget.components.filter((component) => component.type === 'button');
const rows = (widget) => widget.components.find((component) => component.type === 'status').items;

test('the remote shows the state, the source, the sound mode and the volume', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const widget = await content(world, WIDGET_KEYS.REMOTE);
  assert.deepEqual(
    rows(widget).map((row) => [row.label, row.value]),
    [
      ['Living room sound bar', 'On'],
      ['Source', 'TV'],
      ['Sound mode', 'Standard'],
      ['Volume', 15],
    ],
  );
  assert.deepEqual(
    buttons(widget).map((button) => [button.label, button.action.key]),
    [
      ['Standby', ACTIONS.POWER],
      ['Volume −', ACTIONS.VOLUME_DOWN],
      ['Volume +', ACTIONS.VOLUME_UP],
      ['Mute', ACTIONS.MUTE],
    ],
  );
  // Every text is localized.
  const french = await content(world, WIDGET_KEYS.REMOTE, {}, 'fr');
  assert.equal(rows(french)[0].value, 'Allumé');
});

test('the remote buttons: volume by the configured step, mute, standby and on', async (t) => {
  const world = await createWorld({ config: { volume_step: '5', language: 'en' } });
  t.after(() => world.app.stop());
  const { device } = world;
  const settings = { device: deviceOf(world).external_id };
  const tap = async (key, params) => {
    const ack = await world.fake.widgetAction(WIDGET_KEYS.REMOTE, key, params, { settings });
    await settle();
    return ack;
  };
  await tap(ACTIONS.VOLUME_UP);
  assert.equal(device.mainVolume.volume, 20);
  await tap(ACTIONS.VOLUME_DOWN);
  await tap(ACTIONS.VOLUME_DOWN);
  assert.equal(device.mainVolume.volume, 10);
  await tap(ACTIONS.MUTE);
  assert.equal(device.mainVolume.mute, 'on');
  const muted = await content(world, WIDGET_KEYS.REMOTE, settings);
  assert.equal(buttons(muted)[3].icon, 'check-circle');
  assert.equal(rows(muted)[3].value, 'Muted');
  await tap(ACTIONS.MUTE);
  assert.equal(device.mainVolume.mute, 'off');

  const off = await tap(ACTIONS.POWER, { on: false });
  assert.equal(off.success, true);
  assert.equal(off.data.message.en, 'Living room sound bar in standby.');
  assert.equal(device.power, 'standby');
  const standby = await content(world, WIDGET_KEYS.REMOTE, settings);
  assert.deepEqual(
    rows(standby).map((row) => row.value),
    ['Standby'],
  );
  assert.equal(buttons(standby)[0].label, 'Turn on');
  await tap(ACTIONS.POWER, { on: true });
  assert.equal(device.power, 'active');
});

test('the sources widget: the connected inputs by default, or the typed ones', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const settings = { device: deviceOf(world).external_id };
  const widget = await content(world, WIDGET_KEYS.SOURCES, settings);
  // HDMI 2 is disconnected: not offered by default.
  assert.deepEqual(
    buttons(widget).map((button) => [button.label, button.icon]),
    [
      ['HDMI 1', 'log-in'],
      ['TV', 'check-circle'],
      ['Bluetooth Audio', 'log-in'],
      ['Analog', 'log-in'],
    ],
  );
  const ack = await world.fake.widgetAction(
    WIDGET_KEYS.SOURCES,
    buttons(widget)[0].action.key,
    buttons(widget)[0].action.params,
    { settings },
  );
  assert.equal(ack.success, true, ack.error);
  assert.equal(ack.data.message.fr, 'Source : HDMI 1.');
  assert.equal(world.device.playing[0].uri, 'extInput:hdmi?port=1');

  const typed = await content(world, WIDGET_KEYS.SOURCES, {
    ...settings,
    source_1: 'bluetooth',
    source_2: 'Phono',
    source_3: 'hdmi 2',
  });
  assert.deepEqual(
    buttons(typed).map((button) => button.label),
    ['Bluetooth Audio', 'HDMI 2'],
  );
  assert.ok(typed.components.some((c) => c.type === 'text' && /Not found: Phono/.test(c.text)));
});

test('a widget without device, or bound to a device that left', async (t) => {
  const empty = await createWorld({ devices: [], discover: false });
  t.after(() => empty.app.stop());
  const none = await content(empty, WIDGET_KEYS.REMOTE);
  assert.equal(none.components[0].text, TEXT.pick.en);
  const tap = await empty.fake.widgetAction(WIDGET_KEYS.REMOTE, ACTIONS.MUTE, {}, { settings: {} });
  assert.equal(tap.success, false);

  const world = await createWorld({ devices: [new FakeSongpal('srs-x77')] });
  t.after(() => world.app.stop());
  const gone = await content(world, WIDGET_KEYS.SOURCES, {
    device: 'ext:test-integration:audio:mac-00005e00ffff',
  });
  assert.equal(gone.components[0].text, TEXT.unknown.en);
  // Unplugged: said so.
  world.device.online = false;
  await world.hub.pollAll({ force: true });
  const asleep = await content(world, WIDGET_KEYS.REMOTE);
  assert.equal(rows(asleep)[0].value, 'Not answering');
});
