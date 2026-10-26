// -----------------------------------------------------------------------------
// The Gladys 5.3 music player (capabilities/music.md): what a Sony device
// plays, as publishNowPlaying wants it, and its artwork.
//
// What the Audio Control API gives (`getPlayingContentInfo` and the
// `notifyPlayingContentInfo` notification, real answers in test/fixtures):
//   - stateInfo.state: PLAYING, PAUSED, STOPPED;
//   - title, artist, albumName, durationMsec, positionMsec: on a network, USB
//     or Bluetooth source only. An input (HDMI, TV, optical) has none: the
//     device plays whatever the TV sends, nothing is "loaded";
//   - content.thumbnailUrl: the artwork, on a few sources (Cast, Spotify,
//     radio), rarely.
// No catalog, queue or search the API documents well enough: `"music": {}`.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { MAX_ARTWORK_DOWNLOAD, prepareArtwork, readLimited } from './artwork-resize.js';
import { PLAYBACK_STATE, volumeToPercent } from './devices.js';

const logger = createLogger({ name: 'songpal-music' });

const STATES = {
  PLAYING: PLAYBACK_STATE.PLAYING,
  PAUSED: PLAYBACK_STATE.PAUSED,
  STOPPED: PLAYBACK_STATE.IDLE,
  BUFFERING: PLAYBACK_STATE.BUFFERING,
  // Fast forward or rewind: the track still plays.
  FORWARDING: PLAYBACK_STATE.PLAYING,
  REWINDING: PLAYBACK_STATE.PLAYING,
};

/**
 * What plays is an input (HDMI, TV, optical…): nothing loaded on the player.
 * A stopped HDMI input comes with its `parentUri` only (HT-ZF9).
 */
export const isInput = (playing) =>
  playing?.kind === 'input' ||
  /^extInput:/.test(playing?.uri ?? '') ||
  /^extInput:/.test(playing?.parentUri ?? '');

/**
 * The position of what plays at `now`, in ms: the device's sample
 * (`positionMs`, taken at `sampledAt`) moved on while it plays. Null when the
 * device gave none.
 */
export function positionAt(playing, now) {
  const positionMs = playing?.positionMs ?? null;
  if (positionMs === null) {
    return null;
  }
  let position = positionMs;
  if (playbackStateOf(playing) === PLAYBACK_STATE.PLAYING && playing.sampledAt) {
    position += Math.max(0, now - playing.sampledAt);
  }
  return playing.durationMs ? Math.min(position, playing.durationMs) : position;
}

/** The playback state of what plays (an input or an unknown state: idle). */
export function playbackStateOf(playing) {
  if (!playing || isInput(playing)) {
    return PLAYBACK_STATE.IDLE;
  }
  return STATES[playing.state] ?? PLAYBACK_STATE.IDLE;
}

const NOTHING = Object.freeze({
  playback_state: PLAYBACK_STATE.IDLE,
  title: '',
  artist: '',
  album: '',
  artwork_url: null,
  duration: 0,
  position: 0,
});

/**
 * The now playing of a device, for publishNowPlaying; null when there is
 * nothing to say (never read yet). In standby, unreachable or on an input:
 * idle, every text cleared. A device that did not give its position (a
 * stream, some sources) gets the one the integration counts (`counted`, in
 * seconds): a 0 published while playing would be republished at each read.
 * A position the device gave is moved on to `now`: a sample minutes old,
 * republished as is, would move the progress bar back.
 * @param {object} record a hub record ({ snapshot, caps })
 * @param {number} [counted]
 * @param {number} [now]
 */
export function nowPlayingOf(record, counted = 0, now = Date.now()) {
  const { snapshot, caps } = record;
  if (snapshot.reachable === false || (snapshot.power && snapshot.power !== 'active')) {
    return { ...NOTHING };
  }
  if (snapshot.power !== 'active') {
    return null;
  }
  const nowPlaying = {};
  if (caps.volume && snapshot.volume) {
    nowPlaying.volume = volumeToPercent(snapshot.volume.volume, caps.volume);
    nowPlaying.mute = snapshot.volume.mute ? 1 : 0;
  }
  const playing = snapshot.playing;
  if (!playing) {
    // Not read (a method that failed): what was published stays.
    return Object.keys(nowPlaying).length > 0 ? nowPlaying : null;
  }
  if (isInput(playing)) {
    return { ...NOTHING, ...nowPlaying };
  }
  const durationMs = playing.durationMs ?? null;
  const positionMs = positionAt(playing, now);
  const duration = durationMs === null ? 0 : Math.round(durationMs / 1000);
  let position = positionMs === null ? Math.max(0, Math.floor(counted)) : positionMs / 1000;
  if (duration > 0) {
    position = Math.min(position, duration);
  }
  return {
    playback_state: playbackStateOf(playing),
    title: playing.title ?? '',
    artist: playing.artist ?? '',
    album: playing.album ?? '',
    artwork_url: playing.artworkUrl ?? null,
    duration,
    position: Math.round(position),
    ...nowPlaying,
  };
}

/**
 * The position the integration counts for a device that does not give one:
 * from the start of the track, frozen while paused. `clock` is kept on the
 * record; `now` is Date.now(), the clock the SDK extrapolates with.
 * @returns {number} seconds
 */
export function countPosition(record, now = Date.now()) {
  const playing = record.snapshot.playing;
  const key = playing ? [playing.uri, playing.title, playing.artist, playing.album].join('|') : '';
  const running = playbackStateOf(playing) === PLAYBACK_STATE.PLAYING;
  const clock = record.clock;
  if (!clock || clock.key !== key) {
    record.clock = { key, base: 0, since: running ? now : null };
    return 0;
  }
  if (clock.since !== null && !running) {
    clock.base += (now - clock.since) / 1000;
    clock.since = null;
  } else if (clock.since === null && running) {
    clock.since = now;
  }
  return clock.base + (clock.since === null ? 0 : (now - clock.since) / 1000);
}

// --- Artwork -------------------------------------------------------------------

const ARTWORK_TIMEOUT_MS = 10_000;
const PREPARED_ARTWORKS = 20;
const REDIRECTS = 3;

/** Loopback or unspecified: never fetched (the container itself). */
function isLocalHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // URL writes [::ffff:127.0.0.1] as [::ffff:7f00:1].
  return /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1?|::ffff:127\..*|::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4})$/.test(
    host,
  );
}

/**
 * The bytes of an artwork URL: http(s) only, redirects followed (3 at most),
 * size and time bounded.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function downloadArtwork(
  url,
  { fetchImpl = fetch, timeoutMs = ARTWORK_TIMEOUT_MS } = {},
) {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; hop <= REDIRECTS; hop += 1) {
    const target = new URL(current);
    if (!['http:', 'https:'].includes(target.protocol)) {
      throw new Error('not an http(s) URL');
    }
    if (isLocalHost(target.hostname)) {
      throw new Error('a local address');
    }
    const response = await fetchImpl(target.href, { redirect: 'manual', signal });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel?.().catch(() => {});
      current = new URL(location, target).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error(`HTTP ${response.status}`);
    }
    return readLimited(response.body, MAX_ARTWORK_DOWNLOAD);
  }
  throw new Error('too many redirects');
}

/**
 * onMusicGetArtwork: the image of a key handed out by artworkKey, made small
 * enough for the core (300 KB, 4096 px) when it is not.
 * @param {object} gladys
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export function createArtworkHandler(gladys, { fetchImpl } = {}) {
  const prepared = new Map();
  return async (key) => {
    const known = prepared.get(key);
    if (known) {
      return known;
    }
    const url = gladys.artworkUrls?.get(key);
    if (!url) {
      throw new Error(`Unknown artwork ${key}`);
    }
    let base64;
    try {
      base64 = (await prepareArtwork(await downloadArtwork(url, { fetchImpl }))).toString('base64');
    } catch (err) {
      logger.debug(`Artwork ${key} not served (${err.message})`);
      throw new Error(`Artwork not available: ${err.message}`, { cause: err });
    }
    prepared.set(key, base64);
    while (prepared.size > PREPARED_ARTWORKS) {
      prepared.delete(prepared.keys().next().value);
    }
    return base64;
  };
}
