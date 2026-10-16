// -----------------------------------------------------------------------------
// Dashboard widgets (manifest `widgets`, Gladys 5.1+). The core allows four
// buttons per widget, so the remote is split in two widgets a user places
// side by side, each bound to one device (the first one when none is chosen):
//
//   - `remote`: what the device does (state, source, sound mode, volume) and
//     Power, Volume −, Volume +, Mute;
//   - `sources`: four favorite sources, typed by name in the settings
//     ("HDMI 1", "TV"); the first connected inputs by default. One tap turns
//     the device on if needed and switches to it.
//
// The current choice is shown by the check-circle icon, never by the style
// (`primary` is invisible in dark mode, GladysAssistant/Gladys#3153).
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { SETTING_TARGETS, deviceName } from './devices.js';
import { WIDGET_KEYS } from './hub.js';
import { findByName, isOn } from './songpal/model.js';
import { failure, pick } from './texts.js';

// Action keys of the buttons: permanent once published (unique within a
// content, the core drops a button whose key is taken).
export const ACTIONS = Object.freeze({
  POWER: 'power',
  VOLUME_DOWN: 'volume_down',
  VOLUME_UP: 'volume_up',
  MUTE: 'mute',
});
export const SLOT_COUNT = 4;
export const SOURCE_ACTION = (index) => `source_${index}`;

const ACTIVE_ICON = 'check-circle';

export const TEXT = {
  pick: {
    en: 'No Sony audio device yet: search in the Discovery tab of the integration.',
    fr: "Aucun appareil audio Sony pour l'instant : lancez une recherche dans l'onglet Découverte de l'intégration.",
    de: 'Noch kein Sony-Audiogerät: Suche im Tab Erkennung der Integration.',
    es: 'Todavía no hay ningún dispositivo de audio Sony: busque en la pestaña Descubrimiento de la integración.',
  },
  unknown: {
    en: 'This device is not known to the integration any more: choose another one in the widget settings.',
    fr: "Cet appareil n'est plus connu de l'intégration : choisissez-en un autre dans les réglages du widget.",
    de: 'Dieses Gerät kennt die Integration nicht mehr: Wähle ein anderes in den Widget-Einstellungen.',
    es: 'La integración ya no conoce este dispositivo: elija otro en la configuración del widget.',
  },
  noSource: {
    en: 'No source known yet: turn the device on once.',
    fr: "Aucune source connue pour l'instant : allumez l'appareil une fois.",
    de: 'Noch keine Quelle bekannt: Schalte das Gerät einmal ein.',
    es: 'Todavía no se conoce ninguna fuente: encienda el dispositivo una vez.',
  },
  notFound: { en: 'Not found', fr: 'Introuvable', de: 'Nicht gefunden', es: 'No encontrada' },
  on: { en: 'On', fr: 'Allumé', de: 'Ein', es: 'Encendido' },
  standby: { en: 'Standby', fr: 'En veille', de: 'Standby', es: 'En espera' },
  unreachable: {
    en: 'Not answering',
    fr: 'Ne répond pas',
    de: 'Antwortet nicht',
    es: 'No responde',
  },
  waiting: { en: 'Waiting…', fr: 'En attente…', de: 'Warte…', es: 'Esperando…' },
  source: { en: 'Source', fr: 'Source', de: 'Quelle', es: 'Fuente' },
  other: { en: 'Other', fr: 'Autre', de: 'Andere', es: 'Otra' },
  soundMode: { en: 'Sound mode', fr: 'Mode son', de: 'Klangmodus', es: 'Modo de sonido' },
  volume: { en: 'Volume', fr: 'Volume', de: 'Lautstärke', es: 'Volumen' },
  muted: { en: 'Muted', fr: 'Coupé', de: 'Stumm', es: 'Silenciado' },
  turnOn: { en: 'Turn on', fr: 'Allumer', de: 'Einschalten', es: 'Encender' },
  turnOff: { en: 'Standby', fr: 'Veille', de: 'Standby', es: 'Espera' },
  volumeDown: { en: 'Volume −', fr: 'Volume −', de: 'Leiser', es: 'Volumen −' },
  volumeUp: { en: 'Volume +', fr: 'Volume +', de: 'Lauter', es: 'Volumen +' },
  mute: { en: 'Mute', fr: 'Muet', de: 'Stumm', es: 'Silencio' },
};

// Toasts after a tap (≤ 200 characters).
export const DONE_TEXT = {
  en: {
    turningOn: (name) => `Turning ${name} on…`,
    turnedOff: (name) => `${name} in standby.`,
    selected: (name) => `Source: ${name}.`,
  },
  fr: {
    turningOn: (name) => `Allumage de ${name}…`,
    turnedOff: (name) => `${name} en veille.`,
    selected: (name) => `Source : ${name}.`,
  },
  de: {
    turningOn: (name) => `${name} wird eingeschaltet…`,
    turnedOff: (name) => `${name} im Standby.`,
    selected: (name) => `Quelle: ${name}.`,
  },
  es: {
    turningOn: (name) => `Encendiendo ${name}…`,
    turnedOff: (name) => `${name} en espera.`,
    selected: (name) => `Fuente: ${name}.`,
  },
};

const t = (text, language) => pick(text, language);
const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const done = (render) =>
  Object.fromEntries(Object.entries(DONE_TEXT).map(([lang, text]) => [lang, render(text)]));

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

/** The record a widget shows, or the content to show instead. */
function recordFor(hub, settings, language) {
  if (hub.records.size === 0) {
    return { content: message(TEXT.pick, language) };
  }
  const record = hub.view(settings?.device);
  return record ? { record } : { content: message(TEXT.unknown, language) };
}

/** The record a widget button acts on. */
function actionRecord(hub, settings) {
  const record = hub.view(settings?.device);
  if (!record) {
    throw failure(hub.language, hub.records.size === 0 ? 'noDevice' : 'unknownDevice');
  }
  return record;
}

const active = (record) => record.snapshot.reachable !== false && isOn(record.snapshot.power);

/** The first status row: the device and its state. */
function deviceRow(record, language) {
  const label = fit(deviceName(record), 40);
  if (record.snapshot.reachable === false) {
    return {
      label,
      icon: 'speaker',
      value: t(TEXT.unreachable, language),
      color: WIDGET_COLORS.WARNING,
    };
  }
  if (active(record)) {
    return { label, icon: 'speaker', value: t(TEXT.on, language), color: WIDGET_COLORS.SUCCESS };
  }
  if (record.snapshot.power) {
    return {
      label,
      icon: 'speaker',
      value: t(TEXT.standby, language),
      color: WIDGET_COLORS.NEUTRAL,
    };
  }
  return { label, icon: 'clock', value: t(TEXT.waiting, language), color: WIDGET_COLORS.NEUTRAL };
}

/** The name of the source in use. */
export function sourceName(record, language) {
  const uri = record.snapshot.sourceUri;
  const source = record.caps.sources.find((item) => item.uri === uri);
  return source ? source.name : t(TEXT.other, language);
}

// --- remote ----------------------------------------------------------------------

function remoteContent(record, language) {
  const items = [deviceRow(record, language)];
  const on = active(record);
  const volume = record.snapshot.volume;
  if (on) {
    if (record.snapshot.sourceKnown) {
      items.push({
        label: t(TEXT.source, language),
        icon: 'log-in',
        value: fit(sourceName(record, language), 40),
        color: WIDGET_COLORS.INFO,
      });
    }
    const modeValue = record.snapshot.settings?.[SETTING_TARGETS.SOUND_MODE]?.value;
    const mode = record.caps.soundModes.find((item) => item.value === modeValue);
    if (mode) {
      items.push({
        label: t(TEXT.soundMode, language),
        icon: 'sliders',
        value: fit(mode.label, 40),
        color: WIDGET_COLORS.NEUTRAL,
      });
    }
    if (volume) {
      items.push({
        label: t(TEXT.volume, language),
        icon: volume.mute ? 'volume-x' : 'volume-2',
        value: volume.mute ? t(TEXT.muted, language) : volume.volume,
        color: volume.mute ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
      });
    }
  }
  return {
    ttl_seconds: on ? 30 : 120,
    components: [
      { type: 'status', items },
      {
        type: 'button',
        label: t(on ? TEXT.turnOff : TEXT.turnOn, language),
        icon: 'power',
        style: 'secondary',
        action: { key: ACTIONS.POWER, params: { on: !on } },
      },
      {
        type: 'button',
        label: t(TEXT.volumeDown, language),
        icon: 'volume-1',
        style: 'secondary',
        action: { key: ACTIONS.VOLUME_DOWN },
      },
      {
        type: 'button',
        label: t(TEXT.volumeUp, language),
        icon: 'volume-2',
        style: 'secondary',
        action: { key: ACTIONS.VOLUME_UP },
      },
      {
        type: 'button',
        label: t(TEXT.mute, language),
        icon: volume?.mute ? ACTIVE_ICON : 'volume-x',
        style: 'secondary',
        action: { key: ACTIONS.MUTE },
      },
    ],
  };
}

const remote = {
  async get(hub, { settings, language = 'en' }) {
    const { record, content } = recordFor(hub, settings, language);
    return content ?? remoteContent(record, language);
  },

  async action(hub, { actionKey, params = {}, settings }) {
    const record = actionRecord(hub, settings);
    const name = deviceName(record);
    switch (actionKey) {
      case ACTIONS.POWER: {
        const on = params.on === true;
        await hub.setPower(record, on);
        return { message: done((text) => (on ? text.turningOn(name) : text.turnedOff(name))) };
      }
      case ACTIONS.VOLUME_DOWN:
        await hub.stepVolume(record, -1);
        return undefined;
      case ACTIONS.VOLUME_UP:
        await hub.stepVolume(record, 1);
        return undefined;
      case ACTIONS.MUTE:
        await hub.setMute(record, !record.snapshot.volume?.mute);
        return undefined;
      default:
        throw new Error(`Unknown action ${actionKey}`);
    }
  },
};

// --- sources ---------------------------------------------------------------------

/**
 * The sources of a widget: the names typed in its settings, resolved among
 * the inputs of the device; the first connected inputs when none is typed.
 * @returns {{ sources: Array<{ uri: string, name: string }>, missing: string[] }}
 */
export function resolveSources(record, settings = {}) {
  const typed = Array.from({ length: SLOT_COUNT }, (_, index) =>
    typeof settings?.[`source_${index + 1}`] === 'string'
      ? settings[`source_${index + 1}`].trim()
      : '',
  ).filter(Boolean);
  const all = record.caps.sources;
  if (typed.length === 0) {
    const live = record.snapshot.sources ?? [];
    const connected = all.filter((source) =>
      live.some((item) => item.uri === source.uri && item.connection !== 'disconnected'),
    );
    return { sources: (connected.length ? connected : all).slice(0, SLOT_COUNT), missing: [] };
  }
  const sources = [];
  const missing = [];
  for (const query of typed) {
    const source = findByName(all, query);
    if (source && !sources.includes(source)) {
      sources.push(source);
    } else if (!source) {
      missing.push(query);
    }
  }
  return { sources, missing };
}

const sourcesWidget = {
  async get(hub, { settings, language = 'en' }) {
    const { record, content } = recordFor(hub, settings, language);
    if (content) {
      return content;
    }
    const { sources, missing } = resolveSources(record, settings);
    const components = [{ type: 'status', items: [deviceRow(record, language)] }];
    if (sources.length === 0 && missing.length === 0) {
      components.push({ type: 'text', variant: 'caption', text: t(TEXT.noSource, language) });
    }
    if (missing.length > 0) {
      components.push({
        type: 'text',
        variant: 'caption',
        text: fit(
          `${t(TEXT.notFound, language)}${language === 'fr' ? ' : ' : ': '}${missing.join(', ')}`,
          80,
        ),
      });
    }
    const current = active(record) ? record.snapshot.sourceUri : null;
    sources.forEach((source, index) => {
      components.push({
        type: 'button',
        label: fit(source.name, 24),
        icon: source.uri === current ? ACTIVE_ICON : 'log-in',
        style: 'secondary',
        action: { key: SOURCE_ACTION(index + 1), params: { uri: source.uri } },
      });
    });
    return { ttl_seconds: active(record) ? 30 : 300, components };
  },

  async action(hub, { params = {}, settings }) {
    const record = actionRecord(hub, settings);
    const source = await hub.selectSource(record, String(params.uri ?? ''));
    return { message: done((text) => text.selected(source.name)) };
  },
};

export const WIDGETS = {
  [WIDGET_KEYS.REMOTE]: remote,
  [WIDGET_KEYS.SOURCES]: sourcesWidget,
};
