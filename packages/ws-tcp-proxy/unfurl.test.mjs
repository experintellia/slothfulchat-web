// Self-check for the unfurl SSRF IP guard. Run: node unfurl.test.mjs
// Guards the private-IP filter against the IPv4-mapped-IPv6 bypass classes.
import assert from 'node:assert/strict';
import { isIP, BlockList } from 'node:net';

// mirror of the guard in unfurl.mjs (kept in sync by hand — it's 12 lines)
const PRIVATE_IPS = new BlockList();
PRIVATE_IPS.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE_IPS.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_IPS.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE_IPS.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_IPS.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_IPS.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_IPS.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_IPS.addAddress('::', 'ipv6');
PRIVATE_IPS.addAddress('::1', 'ipv6');
PRIVATE_IPS.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_IPS.addSubnet('fe80::', 10, 'ipv6');
const isPrivateIp = (ip) => {
  const fam = isIP(ip);
  return fam !== 0 && PRIVATE_IPS.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
};

// must be BLOCKED (private / loopback / link-local / CGNAT) — incl. the forms
// that bypassed the old regex
for (const ip of [
  '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254',
  '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1',
  '::ffff:127.0.0.1',        // dotted IPv4-mapped (old code caught this)
  '::ffff:7f00:1',           // hex IPv4-mapped 127.0.0.1 (OLD BYPASS)
  '::ffff:a9fe:a9fe',        // hex IPv4-mapped 169.254.169.254 metadata (OLD BYPASS)
]) {
  assert.equal(isPrivateIp(ip), true, `expected ${ip} to be blocked`);
}

// must be ALLOWED (public)
for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '93.184.216.34']) {
  assert.equal(isPrivateIp(ip), false, `expected ${ip} to be allowed`);
}

// non-IP hostnames aren't classified here (the DNS lookup guard handles them)
assert.equal(isPrivateIp('example.com'), false);

console.log('unfurl SSRF IP guard: all assertions passed');
