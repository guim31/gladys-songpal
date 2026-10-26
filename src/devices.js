// -----------------------------------------------------------------------------
// One Gladys device per Sony product (sound bar, receiver, speaker).
//
// Identity: the MAC address the device gives (`getSystemInformation`), else
// its serial number — never the IP address, which DHCP can change. A device
// is published once it answered at least once; what it said is kept under
// /data for the next starts (src/store.js).
//
// Features (category/type couples of the core table, see
// test/gladys-rules.test.js), only those the device has:
//   - power: switch/binary, writable (on / standby);
//   - volume: music/volume, writable, in percent of the device range;
//   - mute: switch/binary, writable;
//   - source: text/select, writable, the inputs of the device (HDMI, TV,
//     optical, Bluetooth…), plus "Other" while a network source plays;
//   - sound mode: text/select, writable, the sound fields of the device;
//   - night mode: switch/binary, writable;
//   - voice: switch/binary when the setting is on/off, else text/select
//     (the voice levels of the older sound bars);
//   - subwoofer: switch/dimmer, writable, bounds of the device (a second
//     `volume` type would let the core's Music box pick it as the volume);
//   - play, pause, previous, next and playback state: the music couples, as
//     the core's Music box wants them all, when the device can pause;
//   - and then the Gladys 5.3 music player (capabilities/music.md): the
//     playback state becomes writable (0 pause, 1 play, 2 stop), title,
//     artist, album, artwork, duration, position (writable: the seek of a USB
//     track), and the mute becomes music/mute (same external id). No shuffle
//     or repeat: their values are not documented anywhere we could check.
//
// The music features are published by publishNowPlaying (src/music.js), the
// others by publishChangedStates (featureValues).
//
// The devices are published with should_poll: false: the integration reads
// them on its own timer and receives their notifications (src/hub.js).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const DEVICE_TYPE = 'audio';
export const ENDPOINT_PARAM = 'SONGPAL_ENDPOINT';
export const MODEL_PARAM = 'SONGPAL_MODEL';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  POWER: 'power',
  VOLUME: 'volume',
  MUTE: 'mute',
  SOURCE: 'source',
  SOUND_MODE: 'sound_mode',
  NIGHT_MODE: 'night_mode',
  VOICE: 'voice',
  SUBWOOFER: 'subwoofer',
  PLAY: 'play',
  PAUSE: 'pause',
  PREVIOUS: 'previous',
  NEXT: 'next',
  PLAYBACK: 'playback',
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUM: 'album',
  ARTWORK: 'artwork',
  DURATION: 'duration',
  POSITION: 'position',
});

/** Music type → feature key, for publishNowPlaying (the 1.0 ids are kept). */
export const MUSIC_KEYS = Object.freeze({
  playback_state: FEATURE_KEYS.PLAYBACK,
  volume: FEATURE_KEYS.VOLUME,
  mute: FEATURE_KEYS.MUTE,
  title: FEATURE_KEYS.TITLE,
  artist: FEATURE_KEYS.ARTIST,
  album: FEATURE_KEYS.ALBUM,
  artwork: FEATURE_KEYS.ARTWORK,
  duration: FEATURE_KEYS.DURATION,
  position: FEATURE_KEYS.POSITION,
});

// Write-only buttons: they have no state.
export const PUSH_KEYS = new Set([
  FEATURE_KEYS.PLAY,
  FEATURE_KEYS.PAUSE,
  FEATURE_KEYS.PREVIOUS,
  FEATURE_KEYS.NEXT,
]);

// Option value of the source select while no input of the list is in use.
export const OTHER_SOURCE = 'other';

// The setting targets of the API behind the features.
export const SETTING_TARGETS = Object.freeze({
  SOUND_MODE: 'soundField',
  NIGHT_MODE: 'nightMode',
  VOICE: 'voice',
  SUBWOOFER: 'subwooferLevel',
});

// `MUSIC_PLAYBACK_STATE` of the core.
export const PLAYBACK_STATE = Object.freeze({ PAUSED: 0, PLAYING: 1, IDLE: 2, BUFFERING: 3 });

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.POWER]: 'Power',
    [FEATURE_KEYS.VOLUME]: 'Volume',
    [FEATURE_KEYS.MUTE]: 'Mute',
    [FEATURE_KEYS.SOURCE]: 'Source',
    [FEATURE_KEYS.SOUND_MODE]: 'Sound mode',
    [FEATURE_KEYS.NIGHT_MODE]: 'Night mode',
    [FEATURE_KEYS.VOICE]: 'Voice enhancement',
    [FEATURE_KEYS.SUBWOOFER]: 'Subwoofer level',
    [FEATURE_KEYS.PLAY]: 'Play',
    [FEATURE_KEYS.PAUSE]: 'Pause',
    [FEATURE_KEYS.PREVIOUS]: 'Previous',
    [FEATURE_KEYS.NEXT]: 'Next',
    [FEATURE_KEYS.PLAYBACK]: 'Playback',
    [FEATURE_KEYS.TITLE]: 'Title',
    [FEATURE_KEYS.ARTIST]: 'Artist',
    [FEATURE_KEYS.ALBUM]: 'Album',
    [FEATURE_KEYS.ARTWORK]: 'Artwork',
    [FEATURE_KEYS.DURATION]: 'Duration',
    [FEATURE_KEYS.POSITION]: 'Position',
  },
  fr: {
    [FEATURE_KEYS.POWER]: 'Marche / veille',
    [FEATURE_KEYS.VOLUME]: 'Volume',
    [FEATURE_KEYS.MUTE]: 'Muet',
    [FEATURE_KEYS.SOURCE]: 'Source',
    [FEATURE_KEYS.SOUND_MODE]: 'Mode son',
    [FEATURE_KEYS.NIGHT_MODE]: 'Mode nuit',
    [FEATURE_KEYS.VOICE]: 'Amélioration des voix',
    [FEATURE_KEYS.SUBWOOFER]: 'Niveau du caisson',
    [FEATURE_KEYS.PLAY]: 'Lecture',
    [FEATURE_KEYS.PAUSE]: 'Pause',
    [FEATURE_KEYS.PREVIOUS]: 'Précédent',
    [FEATURE_KEYS.NEXT]: 'Suivant',
    [FEATURE_KEYS.PLAYBACK]: 'Lecture en cours',
    [FEATURE_KEYS.TITLE]: 'Titre',
    [FEATURE_KEYS.ARTIST]: 'Artiste',
    [FEATURE_KEYS.ALBUM]: 'Album',
    [FEATURE_KEYS.ARTWORK]: 'Pochette',
    [FEATURE_KEYS.DURATION]: 'Durée',
    [FEATURE_KEYS.POSITION]: 'Position',
  },
  de: {
    [FEATURE_KEYS.POWER]: 'Ein / Standby',
    [FEATURE_KEYS.VOLUME]: 'Lautstärke',
    [FEATURE_KEYS.MUTE]: 'Stumm',
    [FEATURE_KEYS.SOURCE]: 'Quelle',
    [FEATURE_KEYS.SOUND_MODE]: 'Klangmodus',
    [FEATURE_KEYS.NIGHT_MODE]: 'Nachtmodus',
    [FEATURE_KEYS.VOICE]: 'Sprachverbesserung',
    [FEATURE_KEYS.SUBWOOFER]: 'Subwoofer-Pegel',
    [FEATURE_KEYS.PLAY]: 'Wiedergabe',
    [FEATURE_KEYS.PAUSE]: 'Pause',
    [FEATURE_KEYS.PREVIOUS]: 'Zurück',
    [FEATURE_KEYS.NEXT]: 'Weiter',
    [FEATURE_KEYS.PLAYBACK]: 'Wiedergabestatus',
    [FEATURE_KEYS.TITLE]: 'Titel',
    [FEATURE_KEYS.ARTIST]: 'Interpret',
    [FEATURE_KEYS.ALBUM]: 'Album',
    [FEATURE_KEYS.ARTWORK]: 'Cover',
    [FEATURE_KEYS.DURATION]: 'Dauer',
    [FEATURE_KEYS.POSITION]: 'Position',
  },
  es: {
    [FEATURE_KEYS.POWER]: 'Encendido / espera',
    [FEATURE_KEYS.VOLUME]: 'Volumen',
    [FEATURE_KEYS.MUTE]: 'Silencio',
    [FEATURE_KEYS.SOURCE]: 'Fuente',
    [FEATURE_KEYS.SOUND_MODE]: 'Modo de sonido',
    [FEATURE_KEYS.NIGHT_MODE]: 'Modo nocturno',
    [FEATURE_KEYS.VOICE]: 'Mejora de voz',
    [FEATURE_KEYS.SUBWOOFER]: 'Nivel del subwoofer',
    [FEATURE_KEYS.PLAY]: 'Reproducir',
    [FEATURE_KEYS.PAUSE]: 'Pausa',
    [FEATURE_KEYS.PREVIOUS]: 'Anterior',
    [FEATURE_KEYS.NEXT]: 'Siguiente',
    [FEATURE_KEYS.PLAYBACK]: 'Reproducción',
    [FEATURE_KEYS.TITLE]: 'Título',
    [FEATURE_KEYS.ARTIST]: 'Artista',
    [FEATURE_KEYS.ALBUM]: 'Álbum',
    [FEATURE_KEYS.ARTWORK]: 'Carátula',
    [FEATURE_KEYS.DURATION]: 'Duración',
    [FEATURE_KEYS.POSITION]: 'Posición',
  },
};

// Labels of the options that are not a value of the device.
export const DEVICE_TEXT = {
  otherSource: {
    en: 'Other (network, app)',
    fr: 'Autre (réseau, appli)',
    de: 'Andere (Netzwerk, App)',
    es: 'Otra (red, aplicación)',
  },
};

const text = (table, language) => table[language] ?? table.en;

/** The capabilities kept for a device: what decides its features. */
export function emptyCapabilities() {
  return {
    volume: null, // { min, max }
    sources: [], // [{ uri, name }]
    soundModes: [], // [{ value, label }]
    nightMode: false,
    voice: null, // 'binary' | 'select'
    voiceChoices: [], // [{ value, label }] when 'select'
    subwoofer: null, // { api, min, max, step }
    playback: false,
  };
}

export const deviceIds = (gladys, platformId) => gladys.externalIds(DEVICE_TYPE, platformId);

/** The platform id of one of this integration's device external ids, or null. */
export function platformIdOf(gladys, externalId) {
  const prefix = gladys.externalId(`${DEVICE_TYPE}:`);
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const rest = externalId.slice(prefix.length);
  return rest && !rest.includes(':') ? rest : null;
}

/** Name of the device in Gladys: its UPnP name, else Sony and the model. */
export function deviceName(record) {
  if (record.friendlyName) {
    return record.friendlyName.slice(0, 60);
  }
  return record.info?.model ? `Sony ${record.info.model}` : `Sony ${record.identity.platformId}`;
}

const binary = (key, history = true) => ({
  key,
  definition: {
    category: DEVICE_FEATURE_CATEGORIES.SWITCH,
    type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
    read_only: false,
    has_feedback: true,
    keep_history: history,
    min: 0,
    max: 1,
  },
});

const select = (key) => ({
  key,
  definition: {
    category: DEVICE_FEATURE_CATEGORIES.TEXT,
    type: DEVICE_FEATURE_TYPES.TEXT.SELECT,
    read_only: false,
    has_feedback: true,
    keep_history: false,
    min: 0,
    max: 0,
  },
});

// A music feature of the 5.3 player: writable ones confirm their writes.
const music = (key, type, { writable = false, max = 0, unit } = {}) => ({
  key,
  definition: {
    category: DEVICE_FEATURE_CATEGORIES.MUSIC,
    type,
    read_only: !writable,
    has_feedback: writable,
    keep_history: false,
    min: 0,
    max,
    ...(unit ? { unit } : {}),
  },
});

// Longest track or stream position published, in seconds (a day).
const LONG = 24 * 60 * 60;

const push = (key, type) => ({
  key,
  definition: {
    category: DEVICE_FEATURE_CATEGORIES.MUSIC,
    type,
    read_only: false,
    has_feedback: false,
    keep_history: false,
    min: 0,
    max: 1,
  },
});

const options = (choices) =>
  choices.map((choice, index) => ({ value: choice.value, label: choice.label, sort_order: index }));

/** The source options: the inputs, then "Other". */
export function sourceOptions(caps, language) {
  return options([
    ...caps.sources.map((source) => ({ value: source.uri, label: source.name })),
    { value: OTHER_SOURCE, label: text(DEVICE_TEXT.otherSource, language) },
  ]);
}

/** A device volume as the percent Gladys shows (capabilities/music.md: 0–100). */
export function volumeToPercent(volume, range) {
  const { min, max } = range;
  if (!(max > min)) {
    return 0;
  }
  const clamped = Math.min(max, Math.max(min, volume));
  return Math.round(((clamped - min) / (max - min)) * 100);
}

/** A percent written from Gladys as a device volume. */
export function percentToVolume(percent, range) {
  const { min, max } = range;
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.round(min + (clamped / 100) * (max - min));
}

/** The features of a device, in display order, from its capabilities. */
export function featureList(caps, language) {
  const features = [binary(FEATURE_KEYS.POWER)];
  if (caps.volume) {
    features.push({
      key: FEATURE_KEYS.VOLUME,
      definition: {
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.VOLUME,
        read_only: false,
        has_feedback: true,
        keep_history: false,
        // In percent, as the core's Music box shows it (a slider to 100):
        // the device's own scale (0–50 on a HT-ZF9) is converted.
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
      },
    });
    // Music mute on a player (Gladys 5.3), a switch on a device that only has
    // a volume (the same external id: Gladys converts it in place).
    features.push(
      caps.playback
        ? music(FEATURE_KEYS.MUTE, DEVICE_FEATURE_TYPES.MUSIC.MUTE, { writable: true, max: 1 })
        : binary(FEATURE_KEYS.MUTE, false),
    );
  }
  if (caps.sources.length > 0) {
    features.push({ ...select(FEATURE_KEYS.SOURCE), options: sourceOptions(caps, language) });
  }
  if (caps.soundModes.length > 0) {
    features.push({ ...select(FEATURE_KEYS.SOUND_MODE), options: options(caps.soundModes) });
  }
  if (caps.nightMode) {
    features.push(binary(FEATURE_KEYS.NIGHT_MODE));
  }
  if (caps.voice === 'binary') {
    features.push(binary(FEATURE_KEYS.VOICE));
  } else if (caps.voice === 'select' && caps.voiceChoices.length > 0) {
    features.push({ ...select(FEATURE_KEYS.VOICE), options: options(caps.voiceChoices) });
  }
  if (caps.subwoofer) {
    features.push({
      key: FEATURE_KEYS.SUBWOOFER,
      definition: {
        category: DEVICE_FEATURE_CATEGORIES.SWITCH,
        type: DEVICE_FEATURE_TYPES.SWITCH.DIMMER,
        read_only: false,
        has_feedback: true,
        keep_history: false,
        min: caps.subwoofer.min,
        max: caps.subwoofer.max,
      },
    });
  }
  if (caps.playback) {
    features.push(
      push(FEATURE_KEYS.PLAY, DEVICE_FEATURE_TYPES.MUSIC.PLAY),
      push(FEATURE_KEYS.PAUSE, DEVICE_FEATURE_TYPES.MUSIC.PAUSE),
      push(FEATURE_KEYS.PREVIOUS, DEVICE_FEATURE_TYPES.MUSIC.PREVIOUS),
      push(FEATURE_KEYS.NEXT, DEVICE_FEATURE_TYPES.MUSIC.NEXT),
      music(FEATURE_KEYS.PLAYBACK, DEVICE_FEATURE_TYPES.MUSIC.PLAYBACK_STATE, {
        writable: true,
        max: 2,
      }),
      music(FEATURE_KEYS.TITLE, DEVICE_FEATURE_TYPES.MUSIC.TITLE),
      music(FEATURE_KEYS.ARTIST, DEVICE_FEATURE_TYPES.MUSIC.ARTIST),
      music(FEATURE_KEYS.ALBUM, DEVICE_FEATURE_TYPES.MUSIC.ALBUM),
      music(FEATURE_KEYS.ARTWORK, DEVICE_FEATURE_TYPES.MUSIC.ARTWORK),
      music(FEATURE_KEYS.DURATION, DEVICE_FEATURE_TYPES.MUSIC.DURATION, {
        max: LONG,
        unit: DEVICE_FEATURE_UNITS.SECONDS,
      }),
      music(FEATURE_KEYS.POSITION, DEVICE_FEATURE_TYPES.MUSIC.POSITION, {
        writable: true,
        max: LONG,
        unit: DEVICE_FEATURE_UNITS.SECONDS,
      }),
    );
  }
  return features;
}

/**
 * The discovered device of a record (identified at least once).
 * @param {object} gladys
 * @param {object} record { identity, info, friendlyName, endpoint, caps }
 * @param {string} language
 */
export function buildDevice(gladys, record, language) {
  const ids = deviceIds(gladys, record.identity.platformId);
  const names = NAMES[language] ?? NAMES.en;
  const params = [{ name: ENDPOINT_PARAM, value: record.endpoint }];
  if (record.info?.model) {
    params.push({ name: MODEL_PARAM, value: record.info.model });
  }
  return {
    name: deviceName(record),
    external_id: ids.device,
    model: record.info?.model ?? undefined,
    should_poll: false,
    params,
    features: featureList(record.caps, language).map(({ key, definition, options: list }) => ({
      name: names[key],
      external_id: ids.feature(key),
      ...definition,
      ...(list ? { supported_options: list } : {}),
    })),
  };
}

/**
 * The states of a record's features, from its last reading. A feature the
 * reading says nothing about (standby, unknown input) gets no state.
 * @returns {Array<{ key: string, externalId: string, state?: number, text?: string }>}
 */
export function featureValues(gladys, record) {
  const ids = deviceIds(gladys, record.identity.platformId);
  const { snapshot, caps } = record;
  const values = [];
  const add = (key, value) => {
    if (value === null || value === undefined) {
      return;
    }
    values.push({
      key,
      externalId: ids.feature(key),
      ...(typeof value === 'string' ? { text: value } : { state: value }),
    });
  };
  const has = new Set(featureList(caps, 'en').map((feature) => feature.key));

  if (snapshot.reachable === false) {
    add(FEATURE_KEYS.POWER, 0);
    return values;
  }
  if (snapshot.power) {
    add(FEATURE_KEYS.POWER, snapshot.power === 'active' ? 1 : 0);
  }
  if (snapshot.power !== 'active') {
    // In standby the other reads mean nothing (or fail): nothing to say.
    return values;
  }
  // A player's volume and mute go through publishNowPlaying (src/music.js).
  if (has.has(FEATURE_KEYS.VOLUME) && snapshot.volume && !caps.playback) {
    add(FEATURE_KEYS.VOLUME, volumeToPercent(snapshot.volume.volume, caps.volume));
    add(FEATURE_KEYS.MUTE, snapshot.volume.mute ? 1 : 0);
  }
  if (has.has(FEATURE_KEYS.SOURCE) && snapshot.sourceKnown) {
    const uri = snapshot.sourceUri;
    add(
      FEATURE_KEYS.SOURCE,
      uri && caps.sources.some((source) => source.uri === uri) ? uri : OTHER_SOURCE,
    );
  }
  const settings = snapshot.settings ?? {};
  const setting = (target) => settings[target]?.value ?? null;
  if (has.has(FEATURE_KEYS.SOUND_MODE)) {
    const value = setting(SETTING_TARGETS.SOUND_MODE);
    add(
      FEATURE_KEYS.SOUND_MODE,
      caps.soundModes.some((mode) => mode.value === value) ? value : null,
    );
  }
  const onOff = (value) => (value === null ? null : value.toLowerCase() === 'on' ? 1 : 0);
  if (has.has(FEATURE_KEYS.NIGHT_MODE)) {
    add(FEATURE_KEYS.NIGHT_MODE, onOff(setting(SETTING_TARGETS.NIGHT_MODE)));
  }
  if (has.has(FEATURE_KEYS.VOICE)) {
    const value = setting(SETTING_TARGETS.VOICE);
    if (caps.voice === 'binary') {
      add(FEATURE_KEYS.VOICE, onOff(value));
    } else {
      add(FEATURE_KEYS.VOICE, caps.voiceChoices.some((c) => c.value === value) ? value : null);
    }
  }
  if (has.has(FEATURE_KEYS.SUBWOOFER)) {
    const raw = setting(SETTING_TARGETS.SUBWOOFER);
    const level = raw === null ? NaN : Number(raw);
    if (Number.isFinite(level)) {
      const { min, max } = caps.subwoofer;
      add(FEATURE_KEYS.SUBWOOFER, Math.min(max, Math.max(min, level)));
    }
  }
  return values;
}
