// -----------------------------------------------------------------------------
// The one function that talks HTTP to the devices: a plain request on
// node:http, bounded in time and in size. The Audio Control API is plain HTTP
// on the local network (port 10000), and so is the UPnP description the
// search reads.
//
// The client and the search take this function as a parameter: the tests
// replace it with in-memory devices (test/helpers/fakeSongpal.js).
// -----------------------------------------------------------------------------

import http from 'node:http';

// The largest answers are the settings and source lists: a few dozen KB.
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * @param {string} url absolute http:// URL
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @returns {Promise<{ status: number, headers: Record<string, string|string[]>, body: string }>}
 */
export function httpRequest(
  url,
  { method = 'POST', headers = {}, body, timeoutMs = 5_000, maxBytes = MAX_BODY_BYTES } = {},
) {
  const target = new URL(url);
  if (target.protocol !== 'http:') {
    return Promise.reject(new Error(`Unsupported protocol ${target.protocol}`));
  }
  const payload = body === undefined ? undefined : Buffer.from(body);
  const requestHeaders = {
    ...headers,
    ...(payload ? { 'content-length': payload.length } : {}),
  };

  return new Promise((resolve, reject) => {
    const request = http.request(
      target,
      { method, headers: requestHeaders, timeout: timeoutMs },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            request.destroy(new Error('Response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', reject);
      },
    );
    request.on('timeout', () => {
      const error = new Error(`Timed out after ${timeoutMs} ms`);
      error.code = 'ETIMEDOUT';
      request.destroy(error);
    });
    request.on('error', reject);
    request.end(payload);
  });
}
