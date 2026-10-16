// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// The features already cover "turn on", "set the volume", "choose a source in
// the list". These actions take what a scene author types instead ("HDMI 1",
// "TV", "Cinema", the names the device shows) and do several things in one
// step, the device turned on first and awaited (longer than the 5 s a device
// command may take): the "movie night" of a scene. They return what they did
// for the next actions of the scene. Gladys applies the field defaults to
// scene actions.
// -----------------------------------------------------------------------------

import { SETTING_TARGETS, deviceName } from './devices.js';
import { failure } from './texts.js';

// Values of the on/off selects of `set_sound`: "unchanged" leaves the setting.
export const SWITCH_CHOICES = Object.freeze({ UNCHANGED: 'unchanged', ON: 'on', OFF: 'off' });

const typed = (value) => (typeof value === 'string' ? value.trim() : '');

export const SCENE_ACTIONS = {
  async select_source(hub, { fields = {} }) {
    const record = hub.target(fields.device || null);
    const source = await hub.selectSource(record, typed(fields.source));
    return { source: source.name };
  },

  async set_sound(hub, { fields = {} }) {
    const record = hub.target(fields.device || null);
    await hub.ensureOn(record);
    const outputs = { sound_mode: '', volume: record.snapshot.volume?.volume ?? 0 };
    if (typed(fields.sound_mode)) {
      const mode = await hub.setSoundMode(record, typed(fields.sound_mode));
      outputs.sound_mode = mode.label;
    } else {
      const value = record.snapshot.settings?.[SETTING_TARGETS.SOUND_MODE]?.value;
      outputs.sound_mode = record.caps.soundModes.find((mode) => mode.value === value)?.label ?? '';
    }
    const night = fields.night_mode ?? SWITCH_CHOICES.UNCHANGED;
    if (night !== SWITCH_CHOICES.UNCHANGED) {
      if (!record.caps.nightMode) {
        throw failure(hub.language, 'noFeature', { name: deviceName(record) });
      }
      await hub.setSetting(
        record,
        SETTING_TARGETS.NIGHT_MODE,
        night === SWITCH_CHOICES.ON ? 'on' : 'off',
      );
    }
    const voice = fields.voice ?? SWITCH_CHOICES.UNCHANGED;
    if (voice !== SWITCH_CHOICES.UNCHANGED) {
      if (!record.caps.voice) {
        throw failure(hub.language, 'noFeature', { name: deviceName(record) });
      }
      await hub.setVoiceSwitch(record, voice === SWITCH_CHOICES.ON);
    }
    if (fields.volume !== undefined && fields.volume !== null && fields.volume !== '') {
      outputs.volume = await hub.setVolume(record, Number(fields.volume));
    }
    return outputs;
  },
};
