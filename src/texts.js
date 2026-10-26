// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widgets (src/widgets.js):
// connection status, errors of the commands and scene actions, the report of
// the configuration action. Four languages, the four of the Gladys interface;
// German says "du", Spanish "usted". test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './songpal/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noDevice: {
    en: 'No device yet: search in the Discovery tab, or type its address in the configuration.',
    fr: "Aucun appareil pour l'instant : lancez une recherche dans l'onglet Découverte, ou saisissez son adresse dans la configuration.",
    de: 'Noch kein Gerät: Suche im Tab Erkennung oder gib seine Adresse in der Konfiguration ein.',
    es: 'Todavía no hay ningún dispositivo: busque en la pestaña Descubrimiento o escriba su dirección en la configuración.',
  },
  noneAnswers: {
    en: 'No device answers: check that they are plugged in, with network standby on.',
    fr: 'Aucun appareil ne répond : vérifiez qu’ils sont branchés, avec la veille réseau activée.',
    de: 'Kein Gerät antwortet: Prüfe, ob sie eingesteckt sind und der Netzwerk-Standby an ist.',
    es: 'Ningún dispositivo responde: compruebe que están enchufados y con la espera de red activada.',
  },
  invalidHosts: {
    en: 'Address not understood in the configuration, e.g. 192.168.1.30',
    fr: 'Adresse incomprise dans la configuration, ex. 192.168.1.30',
    de: 'Adresse in der Konfiguration nicht verstanden, z. B. 192.168.1.30',
    es: 'Dirección no válida en la configuración, p. ej. 192.168.1.30',
  },
};

// One short explanation per error kind (src/songpal/client.js), plus the
// problems of the integration itself.
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'does not answer (unplugged, or network standby off)',
    fr: 'ne répond pas (débranché, ou veille réseau désactivée)',
    de: 'antwortet nicht (ausgesteckt, oder Netzwerk-Standby aus)',
    es: 'no responde (desenchufado, o espera de red desactivada)',
  },
  [ERROR_KINDS.NOT_SONGPAL]: {
    en: 'is not a Sony audio device with the Audio Control API',
    fr: "n'est pas un appareil audio Sony avec l'API Audio Control",
    de: 'ist kein Sony-Audiogerät mit der Audio-Control-API',
    es: 'no es un dispositivo de audio Sony con la API Audio Control',
  },
  [ERROR_KINDS.ILLEGAL_STATE]: {
    en: 'refuses it in its current state (standby, source)',
    fr: 'le refuse dans son état actuel (veille, source)',
    de: 'lehnt das im aktuellen Zustand ab (Standby, Quelle)',
    es: 'lo rechaza en su estado actual (espera, fuente)',
  },
  [ERROR_KINDS.UNSUPPORTED]: {
    en: 'cannot do this',
    fr: 'ne sait pas faire cela',
    de: 'kann das nicht',
    es: 'no puede hacer esto',
  },
  [ERROR_KINDS.API]: {
    en: 'refused the request',
    fr: 'a refusé la demande',
    de: 'hat die Anfrage abgelehnt',
    es: 'ha rechazado la solicitud',
  },
  noIdentity: {
    en: 'gives no MAC address nor serial number',
    fr: 'ne donne ni adresse MAC ni numéro de série',
    de: 'nennt weder MAC-Adresse noch Seriennummer',
    es: 'no da dirección MAC ni número de serie',
  },
  notReached: {
    en: 'not reached yet',
    fr: 'pas encore joint',
    de: 'noch nicht erreicht',
    es: 'aún no se ha conectado',
  },
};

// Errors of the commands, scene actions and widget buttons: thrown, the
// message shown by Gladys. `{name}` and `{value}` are replaced.
export const ACTION_TEXT = {
  en: {
    noDevice: 'No Sony audio device yet: search in the Discovery tab.',
    unknownDevice: 'This device is not known to the integration any more: choose another one.',
    failed: '{name} {value}.',
    unknownSource: '"{value}" is not a source of {name}.',
    otherSource: 'Choose one of the sources of the list.',
    unknownSoundMode: '"{value}" is not a sound mode of {name}.',
    unknownVoice: '"{value}" is not a voice setting of {name}.',
    noFeature: '{name} has no such setting.',
    notOn: '{name} did not turn on.',
    noPlayback: '{name}: the current source cannot be paused or skipped.',
    noSeek: '{name}: only a USB track can be moved within.',
    badPlaybackState: 'Choose pause (0), play (1) or stop (2).',
  },
  fr: {
    noDevice:
      "Aucun appareil audio Sony pour l'instant : lancez une recherche dans l'onglet Découverte.",
    unknownDevice: "Cet appareil n'est plus connu de l'intégration : choisissez-en un autre.",
    failed: '{name} {value}.',
    unknownSource: '« {value} » n’est pas une source de {name}.',
    otherSource: 'Choisissez une des sources de la liste.',
    unknownSoundMode: '« {value} » n’est pas un mode son de {name}.',
    unknownVoice: '« {value} » n’est pas un réglage des voix de {name}.',
    noFeature: "{name} n'a pas ce réglage.",
    notOn: "{name} ne s'est pas allumé.",
    noPlayback: '{name} : la source actuelle ne se met pas en pause et ne se saute pas.',
    noSeek: '{name} : seul un morceau sur clé USB permet de se déplacer.',
    badPlaybackState: 'Choisissez pause (0), lecture (1) ou arrêt (2).',
  },
  de: {
    noDevice: 'Noch kein Sony-Audiogerät: Suche im Tab Erkennung.',
    unknownDevice: 'Dieses Gerät kennt die Integration nicht mehr: Wähle ein anderes.',
    failed: '{name} {value}.',
    unknownSource: '„{value}“ ist keine Quelle von {name}.',
    otherSource: 'Wähle eine der Quellen der Liste.',
    unknownSoundMode: '„{value}“ ist kein Klangmodus von {name}.',
    unknownVoice: '„{value}“ ist keine Spracheinstellung von {name}.',
    noFeature: '{name} hat diese Einstellung nicht.',
    notOn: '{name} hat sich nicht eingeschaltet.',
    noPlayback: '{name}: Die aktuelle Quelle lässt sich nicht pausieren oder überspringen.',
    noSeek: '{name}: Nur in einem Titel vom USB-Stick kannst du springen.',
    badPlaybackState: 'Wähle Pause (0), Wiedergabe (1) oder Stopp (2).',
  },
  es: {
    noDevice:
      'Todavía no hay ningún dispositivo de audio Sony: busque en la pestaña Descubrimiento.',
    unknownDevice: 'La integración ya no conoce este dispositivo: elija otro.',
    failed: '{name} {value}.',
    unknownSource: '«{value}» no es una fuente de {name}.',
    otherSource: 'Elija una de las fuentes de la lista.',
    unknownSoundMode: '«{value}» no es un modo de sonido de {name}.',
    unknownVoice: '«{value}» no es un ajuste de voz de {name}.',
    noFeature: '{name} no tiene este ajuste.',
    notOn: '{name} no se ha encendido.',
    noPlayback: '{name}: la fuente actual no se puede pausar ni saltar.',
    noSeek: '{name}: solo una pista en una memoria USB permite desplazarse.',
    badPlaybackState: 'Elija pausa (0), reproducción (1) o parada (2).',
  },
};

// The report of the "Test the connection" action, one line per device.
export const REPORT_TEXT = {
  en: {
    none: 'No device yet: search in the Discovery tab, or type an address above.',
    on: 'on',
    standby: 'in standby',
    volume: 'volume',
    muted: 'muted',
    notifications: 'live updates on',
    noNotifications: 'live updates off (read every {value} s)',
    invalid: 'address not understood: {value}',
  },
  fr: {
    none: 'Aucun appareil pour l’instant : lancez une recherche dans l’onglet Découverte, ou saisissez une adresse ci-dessus.',
    on: 'allumé',
    standby: 'en veille',
    volume: 'volume',
    muted: 'muet',
    notifications: 'mises à jour en direct',
    noNotifications: 'pas de mises à jour en direct (lu toutes les {value} s)',
    invalid: 'adresse incomprise : {value}',
  },
  de: {
    none: 'Noch kein Gerät: Suche im Tab Erkennung oder gib oben eine Adresse ein.',
    on: 'an',
    standby: 'im Standby',
    volume: 'Lautstärke',
    muted: 'stumm',
    notifications: 'Live-Aktualisierung an',
    noNotifications: 'keine Live-Aktualisierung (alle {value} s gelesen)',
    invalid: 'Adresse nicht verstanden: {value}',
  },
  es: {
    none: 'Todavía no hay ningún dispositivo: busque en la pestaña Descubrimiento o escriba una dirección arriba.',
    on: 'encendido',
    standby: 'en espera',
    volume: 'volumen',
    muted: 'silenciado',
    notifications: 'actualizaciones en directo',
    noNotifications: 'sin actualizaciones en directo (leído cada {value} s)',
    invalid: 'dirección no válida: {value}',
  },
};

/** The text of a multi-language object in a language (English otherwise). */
export const pick = (table, language) => table?.[language] ?? table?.en ?? '';

/** Replace `{name}` and `{value}` in a text. */
export const fill = (template, { name = '', value = '' } = {}) =>
  template.replaceAll('{name}', name).replaceAll('{value}', String(value));

/**
 * An Error whose message is shown to the user, in the configured language.
 * @param {string} language
 * @param {string} key of ACTION_TEXT
 * @param {{ name?: string, value?: string|number }} [values]
 */
export function failure(language, key, values) {
  const table = ACTION_TEXT[language] ?? ACTION_TEXT.en;
  const error = new Error(fill(table[key], values));
  error.userFacing = true;
  return error;
}

/** The user-facing explanation of a client error, about a named device. */
export function deviceFailure(language, name, err) {
  const explanation = pick(ERROR_TEXT[err?.kind] ?? ERROR_TEXT.api, language);
  return failure(language, 'failed', { name, value: explanation });
}
