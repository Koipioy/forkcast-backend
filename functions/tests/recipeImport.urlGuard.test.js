'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  assertSafeResolvedUrl,
  assertSafeUrlShape,
  guardUrl,
  isBlockedHostname,
  isBlockedIpAddress,
  ipv4ToBigInt,
  ipv6ToBigInt,
} = require('../recipeImport/urlGuard');

test('blocks loopback, private, link-local and metadata addresses', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // GCE / AWS / Azure metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.5',
  ];
  for (const address of blocked) {
    assert.strictEqual(isBlockedIpAddress(address), true, `${address} should be blocked`);
  }
});

test('allows routable public addresses', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1']) {
    assert.strictEqual(isBlockedIpAddress(address), false, `${address} should be allowed`);
  }
});

test('blocks IPv6 loopback, unique-local, link-local and IPv4-mapped forms', () => {
  const blocked = ['::1', 'fe80::1', 'fc00::1', 'fd12::34', '::', '[::ffff:127.0.0.1]', '::ffff:10.0.0.1'];
  for (const address of blocked) {
    assert.strictEqual(isBlockedIpAddress(address), true, `${address} should be blocked`);
  }
  assert.strictEqual(isBlockedIpAddress('2001:4860:4860::8888'), false);
});

test('ipv6 parser handles compression and embedded IPv4', () => {
  assert.strictEqual(ipv6ToBigInt('::1'), 1n);
  assert.strictEqual(ipv6ToBigInt('::'), 0n);
  assert.strictEqual(ipv6ToBigInt('2001:db8::1'), 0x20010db8000000000000000000000001n);
  assert.strictEqual(ipv6ToBigInt('::ffff:7f00:1'), 0xffff7f000001n);
  assert.strictEqual(ipv4ToBigInt('127.0.0.1'), 2130706433n);
  assert.strictEqual(ipv6ToBigInt('not:an:ipv6'), null);
});

test('rejects non-http protocols and credential-bearing URLs', () => {
  assert.throws(() => assertSafeUrlShape('ftp://example.com/video.mp4'), /UNSAFE_URL|not allowed/);
  assert.throws(() => assertSafeUrlShape('file:///etc/passwd'), /not allowed/);
  assert.throws(() => assertSafeUrlShape('https://user:pass@example.com'), /credentials/);
  assert.throws(() => assertSafeUrlShape('   '), /required/);
  assert.throws(() => assertSafeUrlShape('definitely not a url'), /could not be parsed/);
});

test('blocks internal hostnames and blocked name suffixes', () => {
  assert.strictEqual(isBlockedHostname('localhost'), true);
  assert.strictEqual(isBlockedHostname('metadata.google.internal'), true);
  assert.strictEqual(isBlockedHostname('db.internal'), true);
  assert.strictEqual(isBlockedHostname('printer.local'), true);
  assert.strictEqual(isBlockedHostname('www.allrecipes.com'), false);
});

test('bare hostnames default to https, matching the existing scraper', () => {
  const parsed = assertSafeUrlShape('example.com/recipe/1');
  assert.strictEqual(parsed.protocol, 'https:');
  assert.strictEqual(parsed.hostname, 'example.com');
});

test('rejects a public hostname whose DNS answer is a metadata address', async () => {
  const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
  const parsed = assertSafeUrlShape('https://evil.example.com/watch');
  await assert.rejects(
    () => assertSafeResolvedUrl(parsed, { lookup }),
    (err) => err.code === 'UNSAFE_URL',
  );
});

test('accepts a hostname that resolves only to public addresses', async () => {
  const lookup = async () => [{ address: '142.250.80.46', family: 4 }];
  const parsed = assertSafeUrlShape('https://www.youtube.com/watch?v=abc');
  const result = await assertSafeResolvedUrl(parsed, { lookup });
  assert.deepStrictEqual(result.addresses, ['142.250.80.46']);
});

test('guardUrl combines the shape check and the DNS check', async () => {
  const lookup = async () => [{ address: '151.101.1.143', family: 4 }];
  const result = await guardUrl('https://www.pinterest.com/pin/12345/', { lookup });
  assert.strictEqual(result.hostname, 'www.pinterest.com');
  assert.strictEqual(result.addresses.length, 1);
});

test('a lookup failure is a rejection, not a pass', async () => {
  const lookup = async () => {
    throw new Error('ENOTFOUND');
  };
  const parsed = assertSafeUrlShape('https://nowhere.invalid/x');
  await assert.rejects(() => assertSafeResolvedUrl(parsed, { lookup }), /could not be resolved/);
});
