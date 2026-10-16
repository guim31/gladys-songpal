// -----------------------------------------------------------------------------
// Search of the Discovery tab: Sony devices that announce the Audio Control
// API over UPnP/SSDP (`urn:schemas-sony-com:service:ScalarWebAPI:1`).
//
// The integration container sits on a bridge network and never sees SSDP: the
// core sends the M-SEARCH and relays the raw answers (mediated discovery,
// manifest `network_discovery`). Each answer points to a UPnP description,
// read over HTTP (unicast crosses the bridge), whose
// `X_ScalarWebAPI_DeviceInfo` block gives the API base URL and its services.
// Bravia TVs announce the same API, with a `videoScreen` service: they are
// left to the Sony Bravia integration.
// (Adapted from guim31/gladys-ping-wol; the description fields as read by the
// Home Assistant `songpal` integration, Apache-2.0.)
// -----------------------------------------------------------------------------

import { isIPv4 } from 'node:net';
import { parseEndpoint } from '../config.js';

export const SSDP_SEARCH_TARGET = 'urn:schemas-sony-com:service:ScalarWebAPI:1';
export const SCAN_TIMEOUT_SECONDS = 5;
export const MAX_CANDIDATES = 16;
const DESCRIPTION_TIMEOUT_MS = 3000;
const DESCRIPTION_MAX_BYTES = 128 * 1024;

/** Headers of one raw SSDP answer, keys lower-cased. */
export function parseSsdpHeaders(text) {
  const headers = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at > 0) {
      const key = line.slice(0, at).trim().toLowerCase();
      if (!(key in headers)) {
        headers[key] = line.slice(at + 1).trim();
      }
    }
  }
  return headers;
}

/** The description URL, only when the answering address serves it. */
function sameHostLocation(location, address) {
  try {
    const url = new URL(location);
    return url.protocol === 'http:' && url.hostname === address ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * One candidate per answering address, from `scanNetwork('ssdp')`.
 * @param {Array<{ source_ip: string, headers: string }>} results
 * @returns {Array<{ address: string, location: string|null, usn: string|null }>}
 */
export function ssdpCandidates(results) {
  const byAddress = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    const address = result?.source_ip;
    if (typeof address !== 'string' || !isIPv4(address)) {
      continue;
    }
    const headers = parseSsdpHeaders(result.headers);
    // The core asked for this target only; other answers are noise.
    if (headers.st && headers.st !== SSDP_SEARCH_TARGET) {
      continue;
    }
    const location = headers.location ? sameHostLocation(headers.location, address) : null;
    const known = byAddress.get(address);
    if (known) {
      known.location ??= location;
      continue;
    }
    if (byAddress.size >= MAX_CANDIDATES) {
      continue;
    }
    byAddress.set(address, { address, location, usn: headers.usn ?? null });
  }
  return [...byAddress.values()];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] === '#') {
        const code =
          entity[1] === 'x' || entity[1] === 'X'
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1));
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : '';
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/[\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The text of every `<tag>` (any namespace prefix) of a document. */
function readAll(xml, tag) {
  const pattern = new RegExp(`<(?:[\\w-]+:)?${tag}>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'gi');
  return [...String(xml ?? '').matchAll(pattern)].map((match) => decodeXml(match[1]));
}

const readOne = (xml, tag) => readAll(xml, tag).find(Boolean) ?? null;

/**
 * The fields of a UPnP description this integration uses.
 * @returns {{ friendlyName, manufacturer, modelName, udn, baseUrl, services: string[] }}
 */
export function parseDescription(xml) {
  const block = String(xml ?? '').match(
    /<(?:[\w-]+:)?X_ScalarWebAPI_DeviceInfo[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?X_ScalarWebAPI_DeviceInfo>/i,
  );
  const info = block ? block[1] : null;
  return {
    friendlyName: readOne(xml, 'friendlyName'),
    manufacturer: readOne(xml, 'manufacturer'),
    modelName: readOne(xml, 'modelName'),
    udn: readOne(xml, 'UDN'),
    baseUrl: info ? readOne(info, 'X_ScalarWebAPI_BaseURL') : null,
    services: info ? readAll(info, 'X_ScalarWebAPI_ServiceType') : [],
  };
}

/** A TV (Bravia): its API has a screen. */
export const isTelevision = (description) =>
  description.services.some((service) => ['videoScreen', 'video'].includes(service));

/**
 * The API endpoint of a candidate: the description's base URL, only when it
 * points to the very address that answered (never elsewhere on the network),
 * else the default `http://<address>:10000/sony`.
 */
export function endpointOf(candidate, description) {
  const fallback = parseEndpoint(candidate.address);
  const announced = description?.baseUrl ? parseEndpoint(description.baseUrl) : null;
  if (announced && new URL(announced).hostname === candidate.address) {
    return announced;
  }
  return fallback;
}

/**
 * Fetch one description, bounded in time and size.
 * @param {Function} request HTTP seam (src/songpal/http.js)
 */
export async function fetchDescription(request, location) {
  const response = await request(location, {
    method: 'GET',
    timeoutMs: DESCRIPTION_TIMEOUT_MS,
    maxBytes: DESCRIPTION_MAX_BYTES,
  });
  if (response.status < 200 || response.status >= 300) {
    return null;
  }
  return parseDescription(response.body);
}
