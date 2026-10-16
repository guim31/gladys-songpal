#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Read-only probe of a real Sony audio device, with the integration's own
// client: what it answers, what the integration would make of it.
//
//   node scripts/probe.mjs 192.168.1.30            # reads, then listens 15 s
//   node scripts/probe.mjs 192.168.1.30 --listen 60
//   node scripts/probe.mjs 192.168.1.30 --raw      # also every raw answer
//
// It only calls `get…` methods and `switchNotifications` (which turns on the
// notifications of its own socket, nothing on the device): no setting, no
// power, no volume is changed. The MAC addresses and the serial number are
// masked, the titles of what plays are not printed: the output can be pasted
// in an issue as is.
// -----------------------------------------------------------------------------

import { parseEndpoint } from '../src/config.js';
import { featureList } from '../src/devices.js';
import { SongpalClient } from '../src/songpal/client.js';
import {
  choicesOf,
  currentSourceUri,
  isOnOff,
  parseIdentity,
  parseInterface,
  parsePlaying,
  parsePower,
  parseSettings,
  parseSources,
  parseVolume,
  rangeOf,
} from '../src/songpal/model.js';
import { Notifier, subscriptionsOf } from '../src/songpal/notifier.js';

const args = process.argv.slice(2);
const address = args.find((arg) => !arg.startsWith('--'));
const raw = args.includes('--raw');
const listenIndex = args.indexOf('--listen');
const listenSeconds = listenIndex >= 0 ? Number(args[listenIndex + 1]) || 15 : 15;

const endpoint = parseEndpoint(address ?? '');
if (!endpoint) {
  console.error('Usage: node scripts/probe.mjs <ip address> [--listen <seconds>] [--raw]');
  process.exit(2);
}

const mask = (value) =>
  typeof value === 'string' && value.length > 4
    ? `${'•'.repeat(value.length - 4)}${value.slice(-4)}`
    : value;

const client = new SongpalClient({ endpoint });
const line = (label, value) => console.log(`${label.padEnd(26)} ${value}`);

async function step(label, fn) {
  try {
    const value = await fn();
    return value;
  } catch (err) {
    line(label, `ERROR ${err.kind ?? ''} ${err.message}`);
    return null;
  }
}

console.log(`Probing ${endpoint}\n`);
const services = await step('guide.getSupportedApiInfo', () => client.readApiInfo());
if (!services) {
  process.exit(1);
}
for (const [name, info] of Object.entries(services)) {
  line(
    `service ${name}`,
    `${Object.keys(info.apis).length} methods, protocols ${info.protocols.join(', ')}`,
  );
  if (info.notifications.length) {
    line('', `notifications ${info.notifications.map((n) => `${n.name}@${n.version}`).join(', ')}`);
  }
  if (raw) {
    line(
      '',
      Object.entries(info.apis)
        .map(([m, v]) => `${m}@${v.join('/')}`)
        .join(' '),
    );
  }
}
if (services.videoScreen) {
  console.log('\nA TV (videoScreen service): the integration leaves it to Sony Bravia TV.');
}

const info = parseInterface(
  (await step('getInterfaceInformation', () => client.getInterfaceInformation())) ?? {},
);
line('model', `${info.model} (${info.product}, ${info.category})`);
const sysinfo = (await step('getSystemInformation', () => client.getSystemInformation())) ?? {};
const identity = parseIdentity(sysinfo);
line(
  'identity',
  identity
    ? `${identity.platformId.slice(0, 4)}${mask(identity.platformId.slice(4))}`
    : 'NONE (no MAC, no serial)',
);
line('firmware', identity?.firmware ?? '?');

const power = parsePower((await step('getPowerStatus', () => client.getPowerStatus())) ?? {});
line('power', power);
if (power !== 'active') {
  console.log('\nThe device is not on: turn it on (not in standby) for the other reads.');
}

const caps = {
  volume: null,
  sources: [],
  soundModes: [],
  nightMode: false,
  voice: null,
  voiceChoices: [],
  subwoofer: null,
  playback: client.supports('avContent', 'pausePlayingContent'),
};
const volumes = await step('getVolumeInformation', () => client.getVolumeInformation());
if (volumes) {
  const volume = parseVolume(volumes);
  line(
    'volume',
    volume
      ? `${volume.volume} (${volume.min}–${volume.max}, step ${volume.step}), mute ${volume.mute}, output "${volume.output}"`
      : 'none',
  );
  if (volume) {
    caps.volume = { min: volume.min, max: volume.max };
  }
  if (volumes.length > 1) {
    line('', `${volumes.length} outputs: ${volumes.map((v) => v.output).join(', ')}`);
  }
}
const terminals = await step('getCurrentExternalTerminalsStatus', () =>
  client.getExternalTerminals(),
);
const sources = terminals ? parseSources(terminals) : [];
caps.sources = sources.map(({ uri, name }) => ({ uri, name }));
for (const source of sources) {
  line(
    '  source',
    `${source.name} — ${source.uri} (${source.connection}${source.active ? ', active' : ''})`,
  );
}
const playing = await step('getPlayingContentInfo', () => client.getPlayingContentInfo());
if (playing) {
  const main = parsePlaying(playing);
  line(
    'playing',
    `${main?.kind} ${main?.uri} ${main?.state} → source ${currentSourceUri(main, sources) ?? 'other'}`,
  );
}
const settings = {
  ...(client.supports('audio', 'getSpeakerSettings')
    ? parseSettings(
        (await step('getSpeakerSettings', () => client.getSpeakerSettings())) ?? [],
        'speaker',
      )
    : {}),
  ...parseSettings(
    (await step('getSoundSettings', () => client.getSoundSettings())) ?? [],
    'sound',
  ),
};
for (const setting of Object.values(settings)) {
  const range = rangeOf(setting);
  const choices = choicesOf(setting)
    .map((c) => c.value)
    .join('/');
  line(
    `  ${setting.api} setting`,
    `${setting.target} (${setting.type}) = ${setting.value} ${range ? `[${range.min}…${range.max} step ${range.step}]` : `[${choices}]`}`,
  );
}
caps.soundModes = choicesOf(settings.soundField);
caps.nightMode = isOnOff(settings.nightMode);
if (settings.voice) {
  caps.voice = isOnOff(settings.voice)
    ? 'binary'
    : choicesOf(settings.voice).length > 1
      ? 'select'
      : null;
  caps.voiceChoices = caps.voice === 'select' ? choicesOf(settings.voice) : [];
}
const sub = rangeOf(settings.subwooferLevel);
caps.subwoofer = sub ? { api: settings.subwooferLevel.api, ...sub } : null;

console.log('\nFeatures the integration would create:');
for (const feature of featureList(caps, 'en')) {
  console.log(
    `  ${feature.key.padEnd(12)} ${feature.definition.category}/${feature.definition.type}${feature.options ? ` (${feature.options.length} options)` : ''}`,
  );
}

const subscriptions = subscriptionsOf(services);
if (subscriptions.length === 0 || typeof globalThis.WebSocket !== 'function') {
  console.log('\nNo notification socket (no WebSocket on this device or this Node).');
  process.exit(0);
}
console.log(
  `\nListening to the notifications for ${listenSeconds} s: use the remote or the Sony app now.`,
);
const notifier = new Notifier({
  endpoint,
  subscriptions,
  onEvent: (name, params, service) => {
    const summary =
      name === 'notifyVolumeInformation'
        ? `volume ${params.volume} mute ${params.mute}`
        : name === 'notifySettingsUpdate'
          ? `${params.apiMappingUpdate?.target} = ${params.apiMappingUpdate?.currentValue}`
          : name === 'notifyPlayingContentInfo'
            ? `${params.contentKind ?? params.kind} ${params.uri} ${params.stateInfo?.state ?? ''}`
            : name === 'notifyPowerStatus'
              ? params.status
              : '';
    line(`  ${service}`, `${name} ${summary}`);
  },
  onStatus: (connected) => line('  sockets', connected ? 'all subscribed' : 'not all subscribed'),
});
notifier.start();
setTimeout(() => {
  notifier.stop();
  process.exit(0);
}, listenSeconds * 1000);
