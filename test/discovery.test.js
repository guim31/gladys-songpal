// -----------------------------------------------------------------------------
// The search: the raw SSDP answers the core relays, the UPnP descriptions,
// and the endpoint of each candidate.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  endpointOf,
  fetchDescription,
  isTelevision,
  parseDescription,
  parseSsdpHeaders,
  ssdpCandidates,
} from '../src/songpal/discovery.js';
import { fixture } from './helpers/fakeSongpal.js';
import { SSDP_RESULTS } from './helpers/world.js';

test('one candidate per answering address, the description only from it', () => {
  const candidates = ssdpCandidates(SSDP_RESULTS);
  assert.deepEqual(
    candidates.map((candidate) => [candidate.address, candidate.location]),
    [
      ['192.0.2.30', 'http://192.0.2.30:52323/dmr.xml'],
      ['192.0.2.31', 'http://192.0.2.31:52323/dmr.xml'],
      ['192.0.2.32', 'http://192.0.2.32:54380/description.xml'],
      ['192.0.2.33', 'http://192.0.2.33:61000/dd.xml'],
      ['192.0.2.40', 'http://192.0.2.40:52323/dmr.xml'],
      // Its description is on another host: not followed.
      ['192.0.2.50', null],
    ],
  );
  assert.deepEqual(ssdpCandidates(null), []);
  assert.equal(
    parseSsdpHeaders('HTTP/1.1 200 OK\r\nLocation: http://x/\r\nLOCATION: y').location,
    'http://x/',
  );
});

test('the description of a sound bar gives its API, a TV is recognized', () => {
  const bar = parseDescription(fixture('ht-zf9').description);
  assert.deepEqual(bar, {
    friendlyName: 'Living room sound bar',
    manufacturer: 'Sony Corporation',
    modelName: 'HT-ZF9',
    udn: 'uuid:00000000-0000-1010-8000-00005e005330',
    baseUrl: 'http://192.0.2.30:10000/sony',
    services: ['guide', 'system', 'audio', 'avContent'],
  });
  assert.equal(isTelevision(bar), false);
  assert.equal(isTelevision(parseDescription(fixture('bravia-tv').description)), true);
  // Without the Sony block: no API base URL.
  const plain = parseDescription(
    '<root><device><friendlyName>A &amp; B</friendlyName></device></root>',
  );
  assert.equal(plain.friendlyName, 'A & B');
  assert.equal(plain.baseUrl, null);
  assert.deepEqual(plain.services, []);
});

test('the endpoint: the announced one on the same host, else the default', () => {
  const bar = parseDescription(fixture('ht-zf9').description);
  assert.equal(endpointOf({ address: '192.0.2.30' }, bar), 'http://192.0.2.30:10000/sony');
  // A description that points to another host is not followed.
  assert.equal(endpointOf({ address: '192.0.2.77' }, bar), 'http://192.0.2.77:10000/sony');
  assert.equal(endpointOf({ address: '192.0.2.77' }, null), 'http://192.0.2.77:10000/sony');
});

test('a description is fetched with a GET, bounded', async () => {
  const seen = [];
  const request = async (url, options) => {
    seen.push({ url, ...options });
    return url.endsWith('dmr.xml')
      ? { status: 200, headers: {}, body: fixture('ht-zf9').description }
      : { status: 404, headers: {}, body: '' };
  };
  const description = await fetchDescription(request, 'http://192.0.2.30:52323/dmr.xml');
  assert.equal(description.modelName, 'HT-ZF9');
  assert.equal(seen[0].method, 'GET');
  assert.ok(seen[0].timeoutMs <= 5000 && seen[0].maxBytes <= 256 * 1024);
  assert.equal(await fetchDescription(request, 'http://192.0.2.30:52323/none.xml'), null);
});
