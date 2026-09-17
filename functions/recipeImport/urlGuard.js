'use strict';

/**
 * SSRF protection for user-supplied URLs.
 *
 * The pipeline hands these URLs to yt-dlp, ffmpeg and to direct HTTP fetches.
 * Any of them can be pointed at whatever the instance itself can reach, which
 * in a cloud function means the metadata server and the rest of the private
 * network. So every URL is checked twice: once as written, and once after DNS
 * resolution, because a public-looking hostname with an A record of
 * 169.254.169.254 is the classic way past a string check.
 *
 * The resolved addresses are returned so callers that follow redirects can
 * re-check the final target rather than trusting the original.
 */

const dns = require('dns');
const { promisify } = require('util');

const { ALLOWED_PROTOCOLS, ALLOW_PRIVATE_NETWORK } = require('./config');
const { InvalidUrlError, UnsafeUrlError } = require('./errors');

const dnsLookup = promisify(dns.lookup);

/** Hostnames that never resolve to a legitimate import target. */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'metadata.google.internal.',
]);

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localdomain', '.home.arpa'];

/**
 * IPv4 ranges that are loopback, private, link-local, carrier-grade NAT,
 * benchmarking, multicast or reserved. Everything outside this list is a
 * routable public address.
 */
const BLOCKED_IPV4_CIDRS = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // RFC6598 CGNAT (includes some provider metadata)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (169.254.169.254 = cloud metadata)
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved / broadcast
];

const BLOCKED_IPV6_PREFIXES = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['2001:db8::', 32], // documentation
];

function ipv4ToBigInt(value) {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  let result = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = (result << 8n) | BigInt(octet);
  }
  return result;
}

function bigIntToIpv4(value) {
  const octets = [];
  let rest = value & 0xffffffffn;
  for (let i = 3; i >= 0; i -= 1) {
    octets[i] = Number((rest >> BigInt(i * 8)) & 0xffn);
  }
  return octets.join('.');
}

function isIpv4Literal(value) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
}

/**
 * Expand an IPv6 literal to 16 bytes as a BigInt, handling `::` compression
 * and a trailing embedded IPv4 address (`::ffff:127.0.0.1`).
 */
function ipv6ToBigInt(input) {
  let value = String(input).trim().toLowerCase();
  if (!value.includes(':')) return null;

  // Embedded IPv4 tail becomes two 16-bit groups.
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToBigInt(tail);
    if (v4 === null) return null;
    value = `${value.slice(0, lastColon + 1)}${((v4 >> 16n) & 0xffffn).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }

  const [headRaw, tailRaw, extra] = value.split('::');
  if (extra !== undefined) return null;

  const expand = (groups) => {
    if (groups.length > 8) return null;
    return groups.map((group) => {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      return BigInt(`0x${group}`);
    });
  };

  let groups;
  if (tailRaw === undefined) {
    groups = expand(headRaw.split(':'));
    if (!groups || groups.some((g) => g === null)) return null;
    if (groups.length !== 8) return null;
  } else {
    const head = headRaw === '' ? [] : headRaw.split(':');
    const tail = tailRaw === '' ? [] : tailRaw.split(':');
    const headGroups = expand(head);
    const tailGroups = expand(tail);
    if (!headGroups || !tailGroups) return null;
    if (headGroups.some((g) => g === null) || tailGroups.some((g) => g === null)) return null;
    const fill = 8 - headGroups.length - tailGroups.length;
    if (fill < 0) return null;
    groups = [...headGroups, ...Array(fill).fill(0n), ...tailGroups];
  }

  let result = 0n;
  for (const group of groups) result = (result << 16n) | group;
  return result;
}

function matchesCidr(value, base, prefix, bits) {
  if (prefix <= 0) return true;
  const shift = BigInt(bits - prefix);
  const mask = (1n << BigInt(prefix)) - 1n;
  return ((value >> shift) & mask) === ((base >> shift) & mask);
}

function isBlockedIpv4(value) {
  const numeric = typeof value === 'bigint' ? value : ipv4ToBigInt(String(value));
  if (numeric === null) return true; // unparseable is not safe
  for (const [base, prefix] of BLOCKED_IPV4_CIDRS) {
    const baseNumeric = ipv4ToBigInt(base);
    if (baseNumeric === null) continue;
    if (matchesCidr(numeric, baseNumeric, prefix, 32)) return true;
  }
  return false;
}

function isBlockedIpv6(value) {
  const numeric = typeof value === 'bigint' ? value : ipv6ToBigInt(String(value));
  if (numeric === null) return true;

  for (const [base, prefix] of BLOCKED_IPV6_PREFIXES) {
    const baseNumeric = ipv6ToBigInt(base);
    if (baseNumeric === null) continue;
    if (matchesCidr(numeric, baseNumeric, prefix, 128)) return true;
  }

  // IPv4-compatible / mapped forms (::ffff:127.0.0.1, ::127.0.0.1) collapse to
  // their IPv4 meaning, so run the IPv4 rules on the low 32 bits whenever the
  // high 96 bits are empty or the mapped prefix.
  const high = numeric >> 32n;
  if (high === 0n || high === 0xffffn) {
    if (isBlockedIpv4(numeric & 0xffffffffn)) return true;
  }
  return false;
}

function isBlockedIpAddress(address) {
  const cleaned = String(address || '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .trim();
  if (!cleaned) return true;
  if (cleaned.includes(':')) return isBlockedIpv6(cleaned);
  if (isIpv4Literal(cleaned)) return isBlockedIpv4(cleaned);
  return true;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (isIpv4Literal(host) || host.includes(':')) return isBlockedIpAddress(host);
  return false;
}

/**
 * Parse and policy-check a URL as written, without touching the network.
 *
 * Returns the parsed WHATWG URL. Throws InvalidUrlError for things that are not
 * URLs and UnsafeUrlError for URLs that are well-formed but forbidden.
 */
function assertSafeUrlShape(rawUrl, options = {}) {
  const allowedProtocols = options.allowedProtocols || ALLOWED_PROTOCOLS;

  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new InvalidUrlError('URL is required and must be a non-empty string.');
  }

  let candidate = rawUrl.trim();
  // Match the existing scraper: a bare "example.com/recipe" means https.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
      throw new InvalidUrlError('URL must use http:// or https://.');
    }
    candidate = `https://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (err) {
    throw new InvalidUrlError(
      `URL could not be parsed: ${err instanceof Error ? err.message : 'invalid'}`,
      { url: candidate },
    );
  }

  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!allowedProtocols.includes(protocol)) {
    throw new UnsafeUrlError(
      `Protocol "${protocol}" is not allowed for recipe imports.`,
      { protocol, allowed: allowedProtocols },
    );
  }

  // user:pass@ in a URL is a redirect/credential-smuggling vector.
  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError('URLs containing credentials are not allowed.', {});
  }

  if (!parsed.hostname) {
    throw new UnsafeUrlError('URL has no hostname.', {});
  }

  if (isBlockedHostname(parsed.hostname)) {
    throw new UnsafeUrlError(
      'That host is not reachable from the recipe importer.',
      { hostname: parsed.hostname },
    );
  }

  return parsed;
}

/**
 * Resolve the host and check every address it points at.
 *
 * This is the check that stops `evil.example.com -> 169.254.169.254`.
 */
async function assertSafeResolvedUrl(parsed, options = {}) {
  const allowPrivate =
    options.allowPrivateNetwork !== undefined
      ? options.allowPrivateNetwork
      : ALLOW_PRIVATE_NETWORK;

  if (allowPrivate) {
    return { url: parsed, addresses: [] };
  }

  const lookup = options.lookup || dnsLookup;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // An IP literal needs no DNS round trip.
  if (isIpv4Literal(hostname) || hostname.includes(':')) {
    if (isBlockedIpAddress(hostname)) {
      throw new UnsafeUrlError(
        'That IP address is private, loopback, link-local or otherwise internal.',
        { hostname },
      );
    }
    return { url: parsed, addresses: [hostname] };
  }

  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new UnsafeUrlError(
      `Hostname could not be resolved: ${err instanceof Error ? err.message : 'lookup failed'}`,
      { hostname },
    );
  }

  const list = Array.isArray(records) ? records : [records].filter(Boolean);
  if (list.length === 0) {
    throw new UnsafeUrlError('Hostname resolved to no addresses.', { hostname });
  }

  const addresses = list.map((record) => (typeof record === 'string' ? record : record.address));
  const blocked = addresses.filter((address) => isBlockedIpAddress(address));

  if (blocked.length > 0) {
    throw new UnsafeUrlError(
      'That hostname resolves to an internal address and will not be fetched.',
      { hostname, blockedCount: blocked.length },
    );
  }

  return { url: parsed, addresses };
}

/**
 * One-call guard: shape check + DNS check.
 *
 * @returns {Promise<{url: URL, href: string, hostname: string, addresses: string[]}>}
 */
async function guardUrl(rawUrl, options = {}) {
  const parsed = assertSafeUrlShape(rawUrl, options);
  const { addresses } = await assertSafeResolvedUrl(parsed, options);
  return {
    url: parsed,
    href: parsed.toString(),
    hostname: parsed.hostname,
    addresses,
  };
}

module.exports = {
  BLOCKED_HOSTNAMES,
  BLOCKED_HOST_SUFFIXES,
  BLOCKED_IPV4_CIDRS,
  BLOCKED_IPV6_PREFIXES,
  ipv4ToBigInt,
  ipv6ToBigInt,
  isBlockedIpv4,
  isBlockedIpv6,
  isBlockedIpAddress,
  isBlockedHostname,
  assertSafeUrlShape,
  assertSafeResolvedUrl,
  guardUrl,
};
