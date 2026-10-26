# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Gladys 5.3 Music player (needs Gladys 5.3.0 or later): title, artist, album, artwork (when the
  device gives one, reduced when larger than Gladys accepts), duration and position of what plays
  on a network, USB or Bluetooth source, published as one batch on each change, never on a timer.
- The playback state is writable: pause (0), play (1), stop (2). The position is writable on a USB
  track (the device plays it again from there); refused with a clear message elsewhere.
- Manifest `"music": {}`: no catalog, queue or search, no shuffle or repeat.

### Changed

- **Playback** is `2` (stopped, nothing loaded) on an input (HDMI, TV, optical), in standby or when
  the device is unreachable, instead of `0`: a scene waiting for `0` on an input must look for `2`.
- **Mute** becomes the music mute (`music/mute`, same external id) on a device that can pause;
  volume and mute of a player are published with the now playing.
- Devices added with 1.0: search again in the Discovery tab and click **Update** to get the new
  features; scenes and dashboards keep working (same ids).
- **Volume** is in percent of the device's range (Gladys's Music box slides to 100): 32 on a
  0–50 sound bar is now 64. Scenes comparing or setting the volume feature must be adjusted; the
  _Sony Audio: set the sound_ scene action keeps the device's units.
- After **Update** in the Discovery tab, the states of the new features are published at once.
- `@gladysassistant/integration-sdk` 0.16.0.

### Fixed

- `jpeg-js` (artwork reduction) is a production dependency: the 1.1.0 image would not start.
- The position published with a volume change or a pause is the current one, not the last read
  (up to 5 minutes old).
- Play after a stop starts the content again (`setPlayContent`) instead of sending the pause
  toggle; play while buffering sends nothing.
- What played before standby no longer comes back as playing when the device turns on.
- A stopped HDMI input (known by its `parentUri` only) is an input: no pause, no skip.

## [1.0.1] - 2026-10-16

### Added

- Sony sound bars, AV receivers and wireless speakers (Sony Music Center /
  SongPal), on the local network through their Audio Control API.
- Search in the Discovery tab (SSDP through Gladys), or addresses typed in the
  configuration for the devices the search cannot see. Sony Bravia TVs are left
  out.
- One device per product, with the features it has: power, volume, mute,
  source, sound mode, night mode, voice enhancement, subwoofer level, and play,
  pause, previous, next and playback state on network sources (the dashboard
  Music box).
- Real-time updates from the notifications of the devices (WebSocket), and a
  read on the integration's own timer as a fallback.
- Dashboard widgets "Sony Audio remote" and "Sony Audio sources".
- Scene trigger "Sony Audio: source changed", scene actions "Sony Audio: choose
  a source" and "Sony Audio: set the sound".
- "Test the connection" in the Configuration screen.
- English, French, German and Spanish texts and documentation.

[Unreleased]: https://github.com/guim31/gladys-songpal/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/guim31/gladys-songpal/releases/tag/v1.0.1
