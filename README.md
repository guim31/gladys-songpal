# Sony Audio for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for the **Sony sound bars, AV
receivers and wireless speakers** that work with the Sony Music Center app (formerly SongPal):
HT-A7000, HT-A5000, HT-ST5000, HT-ZF9, HT-XF9000, HT-NT5, STR-DN1080, STR-AN1000, SRS-X77,
SRS-X99, SRS-ZR7… Local only, through the **Audio Control API** of the devices
(`http://<ip>:10000/sony/…`), with their real-time notifications over WebSocket.

> **Developed without the hardware: feedback welcome.** Everything was built from the Sony API
> reference and tested against fake devices; please tell what works, and what does not, in an
> [issue](https://github.com/guim31/gladys-songpal/issues) with the model of your device (the
> output of `scripts/probe.mjs` helps, see below).

Not affiliated with Sony (see [Disclaimer](#disclaimer)). Sony Bravia TVs, which speak the same
API, are left to the [Sony Bravia TV](https://github.com/guim31/gladys-sony-bravia) integration.

## Features

- **Search** in the Discovery tab: SSDP (`urn:schemas-sony-com:service:ScalarWebAPI:1`) through
  the mediated discovery of the Gladys core; an address can be typed for a device the search
  cannot see.
- **One device per product**, with only the features it has: power (on / standby), volume and
  mute, source (the inputs of the device, with their names), sound mode, night mode, voice
  enhancement (on/off, or the levels of the older sound bars), subwoofer level; play, pause,
  previous, next and the playback state for the dashboard **Music** box, on network sources.
- **Gladys 5.3 Music player** (Gladys ≥ 5.3.0): title, artist, album, artwork (when the device
  gives one), duration and position of what plays on a network, USB or Bluetooth source; the
  playback state becomes writable (pause, play, stop), the position too (on a USB track), and the
  mute becomes the music mute. See below.
- **Real time**: the notifications the device pushes (power, volume, settings, source) are applied
  at once; the device is read again on the container's own timer, every 5 minutes while the
  notifications work, at the configured interval (10 s to 5 min) otherwise.
- **Dashboard widgets**: _Sony Audio remote_ (state, source, sound mode, volume; Power, Volume −,
  Volume +, Mute) and _Sony Audio sources_ (four favorite sources in one tap).
- **Scene trigger** _source changed_ (the TV over HDMI, a console, the remote…), with the new and
  the previous source; **scene actions** _choose a source_ and _set the sound_ (mode, night, voice,
  volume in one step), both turning the device on first.
- English, French, German and Spanish everywhere.

## Gladys 5.3 Music player

From 1.1.0, a device that can pause is a real player in the core's **Music** widget (to use
first; the _Sony Audio remote_ widget stays for the source and the sound mode). What the Audio
Control API gives (`getPlayingContentInfo`, `notifyPlayingContentInfo`):

| Gladys (`music/…`)         | Sony API                                                      | Notes                                                                               |
| -------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `playback_state`           | `stateInfo.state` PLAYING / PAUSED / STOPPED                  | an input (HDMI, TV, optical), standby or unreachable: `IDLE` (2), texts cleared     |
| write 0 / 1 / 2            | `pausePlayingContent` (toggles) / same / `stopPlayingContent` | refused on an input                                                                 |
| `title`, `artist`, `album` | `title`, `artist`, `albumName`                                | network, USB, Bluetooth sources only                                                |
| `artwork`                  | `content.thumbnailUrl`                                        | rare (Cast, Spotify, radio); > 300 KB reduced in plain JS (`src/artwork-resize.js`) |
| `duration`, `position`     | `durationMsec`, `positionMsec`                                | no position given: counted by the integration, frozen while paused                  |
| write `position`           | `setPlayContent` 1.2 `{ uri, positionMsec }`                  | a USB track (`storage:` URI) only: the API has no seek method; refused elsewhere    |
| `mute`, `volume`           | `getVolumeInformation`, `setAudioMute`                        | same external ids as 1.0 (`mute` converted from `switch/binary` in place)           |

The music features go through `publishNowPlaying` (one batch per change, the position as a sample,
never on a timer). Manifest `"music": {}`: no catalog, queue or search (the API's
`getContentList` is undocumented per source and model), no shuffle or repeat
(`getPlaybackModeSettings` targets `shuffleType` / `repeatType` exist, but no real answer with
their values could be found).

**Devices added with 1.0**: search again in the Discovery tab and click **Update**: the new
features are added, the old ones keep their ids. On an input the playback state is now `2`
(was `0`).

## Requirements

- Gladys **5.1.0** or later.
- The device on the same network as Gladys, set up once with the Sony Music Center app, with
  **network standby** on (otherwise it leaves the network in standby and cannot be turned on).

## Installation

1. In Gladys, open **Integrations** → **Install from GitHub** and enter the address of this
   repository: `https://github.com/guim31/gladys-songpal` (or install **Sony Audio** from the
   catalog once it is listed).
2. Turn your device on, open the **Discovery** tab of the integration, search, and add the devices
   found.
3. Optional: in **Configuration**, type the address of a device the search does not find, then
   click **Test the connection**.

The user guide is in [`docs/en.md`](docs/en.md) (also in [French](docs/fr.md),
[German](docs/de.md) and [Spanish](docs/es.md)); Gladys links it from the Configuration screen.

## How it works

- **Audio Control API**: JSON-RPC over `POST http://<ip>:10000/sony/<service>` (`guide`, `system`,
  `audio`, `avContent`), no authentication. `guide.getSupportedApiInfo` lists the services, the
  versions of each method and the notifications of the device: each method is called in the
  newest version both sides know, so one code serves sound bars, receivers and speakers of several
  generations.
- **Notifications**: one outgoing WebSocket per service (`ws://<ip>:10000/sony/<service>`),
  subscribed with `switchNotifications`; retried after 10 s, doubled up to 5 min, at once when a
  read succeeds again. Node's built-in WebSocket client: no runtime dependency beyond the SDK.
- **Search**: the core sends the M-SEARCH and relays the raw answers; the integration reads the
  UPnP description of each device (only from the address that answered), its
  `X_ScalarWebAPI_DeviceInfo` block, and leaves out the TVs (`videoScreen` service).
- **Identity**: the wired MAC address, else the Wi-Fi one, else the serial number — never the IP
  address. A device found at a new address keeps its Gladys device. `/data/songpal-state.json`
  keeps the address, identity, capabilities and lists of each device, so it exists at startup even
  when it does not answer.
- The devices are published with `should_poll: false` (GladysAssistant/Gladys#3198): the
  container reads them on its own timer, and `onPoll` only triggers the same read. Only changes are
  sent to Gladys (`publishChangedStates`, heartbeat every 6 hours), everything again when a device
  is added or Gladys reconnects.
- A command that needs the device on (choosing a source in standby) turns it on and waits for it;
  the core waits 5 s for a feature command, so it is acknowledged after 4 s and goes on.

## Checked, and what was not

The tests (`npm test`) run the integration against the SDK's fake Gladys and in-memory devices of
four families (a 2018 and a 2017 sound bar, a speaker, a receiver) and a Bravia TV, built in the
shapes of the Sony API reference (`test/fixtures/songpal/`): conformity of every device with the
Gladys core (`test/gladys-rules.test.js`), the four languages, the search, every command,
notification, widget and scene action, standby, an unplugged device, a new IP address, a restart
from `/data`. One test runs the whole integration over real HTTP and WebSocket on the loopback
interface (`test/helpers/songpalServer.js`, the fake device behind a `ws` server).

**Music player (1.1.0)**: the now playing is tested with the real `notifyPlayingContentInfo` of
an HT-ZF9 playing a USB track, browsing a folder (`kind: "directory"`), back on an input, and HDMI
stopped (python-songpal logs quoted in rytilahti/python-songpal#52 and home-assistant/core#26776:
`test/fixtures/songpal/ht-zf9-notifications.json`), in the tests and over real sockets (the real
`src/app.js`, its HTTP client and WebSocket against the fake HT-ZF9 served by
`test/helpers/songpalServer.js`, a 2.9 MB cover served by a real HTTP server behind a redirect,
reduced to 95 KB). **Never on a real device**: whether `pausePlayingContent` resumes from
`STOPPED`, the seek through `setPlayContent` with `positionMsec`, and `content.thumbnailUrl`
outside python-songpal's documentation are not verified on hardware.

**Not checked**: a real Sony device and a real Gladys. The exact answers of each model, the
setting names (`soundField`, `nightMode`, `voice`, `subwooferLevel`), whether `pausePlayingContent`
toggles play and pause on every model, the WebSocket behaviour of the oldest models and the SSDP
answers come from the documentation and from open-source projects, not from the hardware.

To check a device without Gladys (read only, nothing changed on the device, MAC addresses masked):

```bash
node scripts/probe.mjs 192.168.1.30 --listen 30
```

## Limitations

- The device must stay on the network in standby (network standby / quick start) to be turned
  on from Gladys: there is no Wake-on-LAN.
- Main zone only on a receiver; no multi-room groups, presets, browsing of the network services,
  equalizer bands nor speaker levels other than the subwoofer.
- Play and pause only on network and USB sources; an HDMI or TV input cannot be paused.
- Feature names are frozen at creation by Gladys (pick the language before adding a device); a
  setting that appears later (a device added in standby, a firmware update) shows an "Update"
  button in the Discovery tab.

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
node test/helpers/songpalServer.js   # a fake HT-ZF9 on port 10000 (SONGPAL_FIXTURE=str-dn1080…)
npx -y github:GladysAssistant/integration-store .   # store checks
```

See [`CLAUDE.md`](CLAUDE.md) for the architecture and the rules of the repository.

## Credits

- Protocol: the Sony **Audio Control API** reference (developer.sony.com); its use read in
  [python-songpal](https://github.com/rytilahti/python-songpal) by Teemu Rytilahti and
  contributors (GPL-3.0, read only: this is an independent implementation) and in the Home
  Assistant [`songpal`](https://github.com/home-assistant/core/tree/dev/homeassistant/components/songpal)
  integration (Apache-2.0), notably the swallowed error 40000 and the TV exclusion.
- Structure, tests and conventions from the other integrations of guim31 (Sony Bravia TV,
  Subsonic, Ping & Wake-on-LAN, WLED), and the official
  [JavaScript template](https://github.com/GladysAssistant/integration-template-js).

## Disclaimer

Not affiliated with, endorsed by or sponsored by Sony. Sony, SongPal and Sony Music Center are
trademarks of Sony Group Corporation.

## License

[Apache-2.0](LICENSE)
