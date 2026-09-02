import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cidrContains,
  detectEncodedIpLiteral,
  ipToString,
  isIpv4Mapped,
  parseCidr,
  parseIp,
  parseIpv4,
  parseIpv6,
  unwrapIpv4Mapped,
} from '../src/ip.ts'

describe('parseIpv4', () => {
  it('accepts dotted decimal', () => {
    assert.deepEqual(Array.from(parseIpv4('192.168.1.1')!), [192, 168, 1, 1])
    assert.deepEqual(Array.from(parseIpv4('0.0.0.0')!), [0, 0, 0, 0])
    assert.deepEqual(Array.from(parseIpv4('255.255.255.255')!), [255, 255, 255, 255])
  })

  it('rejects leading zeros, because they are octal to inet_aton', () => {
    assert.equal(parseIpv4('0177.0.0.1'), null)
    assert.equal(parseIpv4('01.2.3.4'), null)
  })

  it('rejects wrong part counts and out-of-range octets', () => {
    for (const bad of ['1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.-1', '', 'a.b.c.d']) {
      assert.equal(parseIpv4(bad), null, `${bad} must not parse`)
    }
  })
})

describe('parseIpv6', () => {
  it('round-trips compressed and expanded forms', () => {
    assert.equal(ipToString(parseIpv6('::1')!), '::1')
    assert.equal(ipToString(parseIpv6('::')!), '::')
    assert.equal(
      ipToString(parseIpv6('2001:0db8:0000:0000:0000:ff00:0042:8329')!),
      '2001:db8::ff00:42:8329',
    )
    assert.equal(ipToString(parseIpv6('fd00:ec2::254')!), 'fd00:ec2::254')
  })

  it('accepts brackets and embedded IPv4', () => {
    assert.equal(ipToString(parseIpv6('[::1]')!), '::1')
    assert.deepEqual(parseIpv6('::ffff:127.0.0.1'), parseIpv6('::ffff:7f00:1'))
  })

  it('rejects a zone index, two :: runs, and bad groups', () => {
    for (const bad of ['fe80::1%eth0', '::1::2', 'gggg::1', '1:2:3:4:5:6:7', '']) {
      assert.equal(parseIpv6(bad), null, `${bad} must not parse`)
    }
  })
})

describe('IPv4-mapped IPv6', () => {
  it('recognises and unwraps the costume', () => {
    const mapped = parseIp('::ffff:127.0.0.1')!
    assert.equal(isIpv4Mapped(mapped.bytes), true)
    assert.equal(ipToString(unwrapIpv4Mapped(mapped.bytes)!), '127.0.0.1')
  })

  it('does not see a mapping where there is none', () => {
    assert.equal(isIpv4Mapped(parseIp('2001:db8::1')!.bytes), false)
    assert.equal(unwrapIpv4Mapped(parseIp('::1')!.bytes), null)
  })
})

describe('cidrContains', () => {
  it('matches on prefix boundaries, not string prefixes', () => {
    const cgnat = parseCidr('100.64.0.0/10')!
    assert.equal(cidrContains(cgnat, parseIp('100.64.0.0')!.bytes), true)
    assert.equal(cidrContains(cgnat, parseIp('100.127.255.255')!.bytes), true)
    assert.equal(cidrContains(cgnat, parseIp('100.128.0.0')!.bytes), false)
    assert.equal(cidrContains(cgnat, parseIp('100.63.255.255')!.bytes), false)
  })

  it('handles a /7 that no string comparison would get right', () => {
    const ula = parseCidr('fc00::/7')!
    assert.equal(cidrContains(ula, parseIp('fc00::1')!.bytes), true)
    assert.equal(cidrContains(ula, parseIp('fd00:ec2::254')!.bytes), true)
    assert.equal(cidrContains(ula, parseIp('fe00::1')!.bytes), false)
  })

  it('never matches across families', () => {
    const v4 = parseCidr('10.0.0.0/8')!
    assert.equal(cidrContains(v4, parseIp('::1')!.bytes), false)
  })

  it('treats a bare address as a host route', () => {
    const host = parseCidr('169.254.169.254')!
    assert.equal(host.prefix, 32)
    assert.equal(cidrContains(host, parseIp('169.254.169.254')!.bytes), true)
    assert.equal(cidrContains(host, parseIp('169.254.169.253')!.bytes), false)
  })

  it('rejects malformed CIDRs rather than guessing', () => {
    for (const bad of ['10.0.0.0/33', '::/129', 'not-an-ip/8', '10.0.0.0/']) {
      assert.equal(parseCidr(bad), null, `${bad} must not parse`)
    }
  })
})

describe('detectEncodedIpLiteral', () => {
  it('names the encoding that was attempted', () => {
    assert.equal(detectEncodedIpLiteral('2130706433'), 'decimal')
    assert.equal(detectEncodedIpLiteral('0x7f000001'), 'hexadecimal')
    assert.equal(detectEncodedIpLiteral('0177.0.0.1'), 'octal')
    assert.equal(detectEncodedIpLiteral('0'), 'shorthand')
    assert.equal(detectEncodedIpLiteral('10.1'), 'shorthand')
  })

  it('leaves ordinary hostnames and dotted decimal alone', () => {
    for (const ordinary of ['example.com', '127.0.0.1.nip.io', '127.0.0.1', 'a.b.c.d']) {
      assert.equal(detectEncodedIpLiteral(ordinary), null, ordinary)
    }
  })
})
