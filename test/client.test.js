// -----------------------------------------------------------------------------
// The JSON-RPC client: the request it sends, the versions it picks from the
// API description of each family, and what each failure becomes.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ERROR_KINDS,
  SongpalClient,
  compareVersions,
  parseApiInfo,
} from '../src/songpal/client.js';
import { FakeSongpal, createNetwork, fixture } from './helpers/fakeSongpal.js';

const ENDPOINT = 'http://192.0.2.30:10000/sony';

test('a call is a JSON-RPC POST to the service', async () => {
  const sent = [];
  const client = new SongpalClient({
    endpoint: `${ENDPOINT}/`,
    request: async (url, options) => {
      sent.push({ url, ...options });
      return { status: 200, headers: {}, body: '{"id":1,"result":[{"status":"active"}]}' };
    },
  });
  assert.deepEqual(await client.getPowerStatus(), { status: 'active' });
  assert.equal(sent[0].url, `${ENDPOINT}/system`);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(sent[0].body), {
    method: 'getPowerStatus',
    id: 1,
    params: [],
    version: '1.1',
  });
});

test('the API description of each family', () => {
  const zf9 = parseApiInfo(fixture('ht-zf9').responses['guide.getSupportedApiInfo'].result);
  assert.deepEqual(Object.keys(zf9), ['guide', 'system', 'audio', 'avContent']);
  assert.deepEqual(zf9.audio.apis.getVolumeInformation, ['1.1']);
  assert.deepEqual(
    zf9.system.notifications.map((n) => n.name),
    ['notifyPowerStatus', 'notifySettingsUpdate', 'notifySWUpdateInfo', 'notifyStorageStatus'],
  );
  assert.deepEqual(zf9.audio.protocols, ['xhrpost:jsonizer', 'websocket:jsonizer']);
  assert.deepEqual(parseApiInfo(null), {});
  assert.deepEqual(parseApiInfo([[{ apis: [] }, null, 'x']]), {});
  assert.ok(compareVersions('1.10', '1.9') > 0);
  assert.equal(compareVersions('1.0', '1'), 0);
});

test('each method is called in the newest version both sides know', async () => {
  const receiver = new FakeSongpal('str-dn1080');
  const network = createNetwork([receiver]);
  const client = new SongpalClient({
    endpoint: 'http://192.0.2.33:10000/sony',
    request: network.request,
  });
  // Before the description: the newest known version.
  assert.equal(client.versionOf('system', 'getSystemInformation'), '1.4');
  await client.readApiInfo();
  // The receiver lists 1.0 to 1.3 only.
  assert.equal(client.versionOf('system', 'getSystemInformation'), '1.3');
  assert.equal(client.versionOf('avContent', 'getPlayingContentInfo'), '1.2');
  assert.equal(client.versionOf('audio', 'getSpeakerSettings'), '1.0');
  assert.equal(client.versionOf('audio', 'getCustomEqualizerSettings'), '1.0');
  assert.equal(client.versionOf('videoScreen', 'setSceneSetting'), null);
  assert.equal(client.supports('audio', 'getSpeakerSettings'), true);
  assert.equal(client.supports('audio', 'getBassLevel'), false);
  const identity = await client.getSystemInformation();
  assert.equal(identity.serialNumber, '1234567');
  assert.equal(receiver.calls.at(-1).version, '1.3');

  // A method the device lacks is refused before any request.
  const before = receiver.calls.length;
  await assert.rejects(
    client.invoke('videoScreen', 'setSceneSetting', () => []),
    {
      kind: ERROR_KINDS.UNSUPPORTED,
    },
  );
  assert.equal(receiver.calls.length, before);
});

test('the commands send the params of their version', async () => {
  const bar = new FakeSongpal('ht-zf9');
  const network = createNetwork([bar]);
  const client = new SongpalClient({ endpoint: ENDPOINT, request: network.request });
  await client.readApiInfo();
  await client.setVolume('', 21);
  await client.setMute('', true);
  await client.setSetting('sound', 'nightMode', 'on');
  await client.setSetting('speaker', 'rearspeakerLevel', '2');
  await client.setPlayContent('extInput:hdmi?port=2');
  await client.setPower(false);
  // Already in standby: the device answers 40000, not an error.
  await client.setPower(false);
  const sent = bar.calls.slice(1).map(({ method, params, version }) => [method, params, version]);
  assert.deepEqual(sent, [
    ['setAudioVolume', [{ output: '', volume: '21' }], '1.1'],
    ['setAudioMute', [{ output: '', mute: 'on' }], '1.1'],
    ['setSoundSettings', [{ settings: [{ target: 'nightMode', value: 'on' }] }], '1.1'],
    ['setSpeakerSettings', [{ settings: [{ target: 'rearspeakerLevel', value: '2' }] }], '1.0'],
    ['setPlayContent', [{ output: '', uri: 'extInput:hdmi?port=2' }], '1.2'],
    ['setPowerStatus', [{ status: 'off' }], '1.1'],
    ['setPowerStatus', [{ status: 'off' }], '1.1'],
  ]);
});

test('every failure has a kind, never a secret nor the body', async () => {
  const answer =
    (body, status = 200) =>
    async () => ({ status, headers: {}, body });
  const kindOf = async (request) => {
    const client = new SongpalClient({ endpoint: ENDPOINT, request });
    try {
      await client.getPowerStatus();
      return null;
    } catch (err) {
      return [err.kind, err.code];
    }
  };
  const refused = async () => {
    const error = new Error('connect ECONNREFUSED 192.0.2.30:10000');
    error.code = 'ECONNREFUSED';
    throw error;
  };
  assert.deepEqual(await kindOf(refused), [ERROR_KINDS.UNREACHABLE, null]);
  assert.deepEqual(await kindOf(answer('<html>router</html>')), [ERROR_KINDS.NOT_SONGPAL, null]);
  assert.deepEqual(await kindOf(answer('{"id":1,"error":[7,"Illegal State"]}')), [
    ERROR_KINDS.ILLEGAL_STATE,
    7,
  ]);
  assert.deepEqual(await kindOf(answer('{"id":1,"error":[12,"No Such Method"]}')), [
    ERROR_KINDS.UNSUPPORTED,
    12,
  ]);
  assert.deepEqual(await kindOf(answer('{"id":1,"error":[40001,"Busy"]}')), [
    ERROR_KINDS.API,
    40001,
  ]);
  assert.deepEqual(await kindOf(answer('Not Found', 404)), [ERROR_KINDS.NOT_SONGPAL, null]);

  const client = new SongpalClient({ endpoint: ENDPOINT, request: refused });
  await assert.rejects(client.getPowerStatus(), (err) => {
    assert.equal(err.message, 'system.getPowerStatus: no answer (ECONNREFUSED)');
    return true;
  });
  // A TV answers the description without the services of a sound bar.
  const notAudio = new SongpalClient({
    endpoint: ENDPOINT,
    request: answer('{"id":1,"result":[[{"service":"guide","apis":[]}]]}'),
  });
  await assert.rejects(notAudio.readApiInfo(), { kind: ERROR_KINDS.NOT_SONGPAL });
});
