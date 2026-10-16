# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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

[Unreleased]: https://github.com/guim31/gladys-songpal/commits/main
