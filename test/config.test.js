import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, hostOf, normalizeConfig, parseEndpoint } from '../src/config.js';

test('an address becomes the base URL of the API', () => {
  assert.equal(parseEndpoint('192.0.2.30'), 'http://192.0.2.30:10000/sony');
  assert.equal(parseEndpoint(' 192.0.2.30:10000 '), 'http://192.0.2.30:10000/sony');
  assert.equal(parseEndpoint('http://192.0.2.30:10000/sony/'), 'http://192.0.2.30:10000/sony');
  assert.equal(parseEndpoint('soundbar.home.arpa'), 'http://soundbar.home.arpa:10000/sony');
  assert.equal(parseEndpoint('http://192.0.2.30:8080'), 'http://192.0.2.30:8080/sony');
  for (const bad of [
    '',
    '   ',
    'https://192.0.2.30',
    'ftp://192.0.2.30',
    'http://a:b@192.0.2.30',
    null,
  ]) {
    assert.equal(parseEndpoint(bad), null, String(bad));
  }
  assert.equal(hostOf('http://192.0.2.30:10000/sony'), '192.0.2.30');
});

test('the configuration is normalized, defaults included', () => {
  assert.deepEqual(normalizeConfig(), {
    hosts: [],
    invalidHosts: [],
    pollIntervalMs: 30_000,
    volumeStep: 2,
    language: 'fr',
  });
  assert.equal(DEFAULT_CONFIG.language, 'fr');
  const config = normalizeConfig({
    hosts: '192.0.2.30, 192.0.2.31;192.0.2.30 http://x:y@192.0.2.9 ',
    poll_interval: '300',
    volume_step: 5,
    language: 'de',
  });
  assert.deepEqual(config.hosts, ['http://192.0.2.30:10000/sony', 'http://192.0.2.31:10000/sony']);
  assert.deepEqual(config.invalidHosts, ['http://x:y@192.0.2.9']);
  assert.equal(config.pollIntervalMs, 300_000);
  assert.equal(config.volumeStep, 5);
  assert.equal(config.language, 'de');
  // Unknown values fall back to the defaults.
  const fallback = normalizeConfig({ poll_interval: '7', volume_step: '9', language: 'it' });
  assert.equal(fallback.pollIntervalMs, 30_000);
  assert.equal(fallback.volumeStep, 2);
  assert.equal(fallback.language, 'fr');
  // At most ten addresses.
  const many = Array.from({ length: 15 }, (_, i) => `192.0.2.${i + 1}`).join(',');
  assert.equal(normalizeConfig({ hosts: many }).hosts.length, 10);
});
