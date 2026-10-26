// -----------------------------------------------------------------------------
// What the answers mean, on the fixtures of every family.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  choicesOf,
  currentSourceUri,
  findByName,
  isOnOff,
  normalizeMac,
  parseIdentity,
  parseInterface,
  parsePlaying,
  parseSettings,
  parseSources,
  parseVolume,
  rangeOf,
  sameHardware,
} from '../src/songpal/model.js';
import { fixture } from './helpers/fakeSongpal.js';

const result = (name, key) => fixture(name).responses[key].result;
const list = (name, key) => result(name, key)[0];

test('the identity is the wired MAC, else the Wi-Fi one, else the serial', () => {
  assert.deepEqual(parseIdentity(result('ht-zf9', 'system.getSystemInformation')[0]), {
    platformId: 'mac-00005e005330',
    macs: ['00005e005330', '00005e005332'],
    serial: null,
    firmware: '001.817',
  });
  // A speaker on Wi-Fi gives an empty wired MAC.
  assert.equal(
    parseIdentity(result('srs-x77', 'system.getSystemInformation')[0]).platformId,
    'mac-00005e005350',
  );
  assert.equal(parseIdentity({ serialNumber: 'AB12345' }).platformId, 'sn-ab12345');
  assert.equal(parseIdentity({ macAddr: '00:00:00:00:00:00' }), null);
  assert.equal(parseIdentity({}), null);
  assert.equal(normalizeMac('00-00-5E-00-53-30'), '00005e005330');
  assert.equal(normalizeMac('ff:ff:ff:ff:ff:ff'), null);
  // The same hardware: a MAC in common, whatever the platform id.
  assert.ok(
    sameHardware(
      { platformId: 'mac-a', macs: ['00005e005332'] },
      { platformId: 'mac-b', macs: ['00005e005330', '00005e005332'] },
    ),
  );
  assert.ok(
    !sameHardware({ platformId: 'mac-a', macs: ['1'] }, { platformId: 'mac-b', macs: ['2'] }),
  );
});

test('model and product', () => {
  assert.deepEqual(parseInterface(result('str-dn1080', 'system.getInterfaceInformation')[0]), {
    model: 'STR-DN1080',
    product: 'Str',
    category: 'homeTheaterSystem',
  });
  assert.equal(
    parseInterface(result('bravia-tv', 'system.getInterfaceInformation')[0]).category,
    'tv',
  );
});

test('the volume of the main output', () => {
  assert.deepEqual(parseVolume(list('ht-zf9', 'audio.getVolumeInformation')), {
    output: '',
    volume: 15,
    mute: false,
    min: 0,
    max: 50,
    step: 1,
  });
  // A receiver: zone 1, not the muted zone 2.
  const receiver = parseVolume(list('str-dn1080', 'audio.getVolumeInformation'));
  assert.equal(receiver.output, 'extOutput:zone?zone=1');
  assert.equal(receiver.volume, 35);
  assert.equal(receiver.mute, false);
  assert.equal(parseVolume([]), null);
});

test('the inputs, without the zones and the hidden entries', () => {
  assert.deepEqual(
    parseSources(list('str-dn1080', 'avContent.getCurrentExternalTerminalsStatus')).map(
      (source) => source.name,
    ),
    ['Blu-ray', 'GAME', 'SAT/CATV', 'TV', 'SA-CD/CD', 'Bluetooth Audio'],
  );
  const st5000 = parseSources(list('ht-st5000', 'avContent.getCurrentExternalTerminalsStatus'));
  assert.equal(st5000.length, 5);
  assert.deepEqual(st5000[0], {
    uri: 'extInput:hdmi?port=1',
    name: 'Console',
    connection: 'connected',
    active: false,
  });
});

test('the source in use: what plays, else the active input, null on a network source', () => {
  const sources = parseSources(list('ht-zf9', 'avContent.getCurrentExternalTerminalsStatus'));
  const tv = parsePlaying(list('ht-zf9', 'avContent.getPlayingContentInfo'));
  assert.deepEqual(tv, {
    uri: 'extInput:tv',
    kind: 'input',
    state: 'PLAYING',
    title: null,
    artist: null,
    album: null,
    durationMs: null,
    positionMs: null,
    artworkUrl: null,
  });
  assert.equal(currentSourceUri(tv, sources), 'extInput:tv');
  const spotify = parsePlaying(list('srs-x77', 'avContent.getPlayingContentInfo'));
  assert.equal(spotify.kind, 'service');
  assert.equal(currentSourceUri(spotify, sources), null);
  // Nothing plays (some models in an idle input): the input marked active.
  assert.equal(currentSourceUri(null, sources), 'extInput:tv');
  // A receiver: the main zone plays.
  const receiver = parsePlaying(list('str-dn1080', 'avContent.getPlayingContentInfo'));
  assert.equal(receiver.uri, 'extInput:hdmi?port=2');
  // Newer models say `kind` instead of `contentKind`.
  assert.equal(parsePlaying([{ uri: 'extInput:tv', kind: 'input' }]).kind, 'input');
});

test('the sound settings: modes, on/off, levels', () => {
  const zf9 = parseSettings(list('ht-zf9', 'audio.getSoundSettings'));
  assert.deepEqual(
    choicesOf(zf9.soundField).map((choice) => choice.label),
    [
      'Standard',
      'ClearAudio+',
      'Movie',
      'Music',
      'Game Studio',
      // Unavailable on this input, kept: the list of a select should not flicker.
      'Sports',
    ],
  );
  assert.equal(zf9.nightMode.value, 'off');
  assert.ok(isOnOff(zf9.nightMode));
  assert.ok(isOnOff(zf9.voice));
  assert.deepEqual(rangeOf(zf9.subwooferLevel), { min: -6, max: 6, step: 1 });

  const st5000 = parseSettings(list('ht-st5000', 'audio.getSoundSettings'));
  assert.ok(!isOnOff(st5000.voice));
  assert.deepEqual(
    choicesOf(st5000.voice).map((choice) => choice.value),
    ['type1', 'type2', 'type3', 'off'],
  );

  const speaker = parseSettings(list('str-dn1080', 'audio.getSpeakerSettings'), 'speaker');
  assert.equal(speaker.subwooferLevel.api, 'speaker');
  assert.equal(speaker.subwooferLevel.value, '-2.5');
  assert.deepEqual(rangeOf(speaker.subwooferLevel), { min: -10, max: 10, step: 0.5 });
  assert.equal(rangeOf(undefined), null);
  assert.ok(!isOnOff(undefined));
});

test('a name typed by a user finds its item', () => {
  const sources = parseSources(list('str-dn1080', 'avContent.getCurrentExternalTerminalsStatus'));
  assert.equal(findByName(sources, 'blu-ray').uri, 'extInput:hdmi?port=1');
  assert.equal(findByName(sources, ' Game ').uri, 'extInput:hdmi?port=2');
  assert.equal(findByName(sources, 'extInput:tv').name, 'TV');
  assert.equal(findByName(sources, 'sacd').name, 'SA-CD/CD');
  assert.equal(findByName(sources, 'Blue').name, 'Bluetooth Audio');
  assert.equal(findByName(sources, 'phono'), null);
  assert.equal(findByName(sources, ''), null);
  const modes = choicesOf(parseSettings(list('ht-zf9', 'audio.getSoundSettings')).soundField);
  const byLabel = (typed) =>
    findByName(
      modes,
      typed,
      (m) => m.label,
      (m) => m.value,
    );
  assert.equal(byLabel('clearaudio+').value, 'clearAudio');
  assert.equal(byLabel('Movie').value, 'movie');
  assert.equal(byLabel('Cinéma'), null);
});
