/**
 * The bypass corpus.
 *
 * One test per known bypass. Each names the trick, so a failure tells you
 * which bypass regressed rather than that "a test broke".
 *
 * Nothing here touches the network: URL-shape and literal-address cases are
 * refused before DNS, and the name-based cases are answered by a DNS server
 * the test owns.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSafeFetch, SsrfBlockedError, type BlockReason } from '../src/index.ts'
import { startDnsServer, type DnsServer } from './helpers/dns-server.ts'

interface Case {
  readonly label: string
  readonly url: string
  readonly reason: BlockReason
}

/** Cases decided from the URL alone — no DNS server required. */
const OFFLINE_CASES: readonly Case[] = [
  { label: '127.0.0.1 — loopback, literal', url: 'http://127.0.0.1/', reason: 'blocked-range' },
  { label: '2130706433 — decimal encoding', url: 'http://2130706433/', reason: 'ip-literal-encoded' },
  { label: '0x7f000001 — hex encoding', url: 'http://0x7f000001/', reason: 'ip-literal-encoded' },
  { label: '0177.0.0.1 — octal encoding', url: 'http://0177.0.0.1/', reason: 'ip-literal-encoded' },
  { label: '0 — shorthand for 0.0.0.0', url: 'http://0/', reason: 'ip-literal-encoded' },
  { label: '[::1] — IPv6 loopback', url: 'http://[::1]/', reason: 'blocked-range' },
  {
    label: '[::ffff:127.0.0.1] — IPv4-mapped IPv6',
    url: 'http://[::ffff:127.0.0.1]/',
    reason: 'ipv4-mapped-ipv6',
  },
  {
    label: '[::ffff:7f00:1] — IPv4-mapped, hex form',
    url: 'http://[::ffff:7f00:1]/',
    reason: 'ipv4-mapped-ipv6',
  },
  {
    label: '169.254.169.254 — AWS/GCP/Azure metadata',
    url: 'http://169.254.169.254/latest/meta-data/',
    reason: 'metadata-endpoint',
  },
  {
    label: '[fd00:ec2::254] — AWS metadata over IPv6',
    url: 'http://[fd00:ec2::254]/latest/meta-data/',
    reason: 'metadata-endpoint',
  },
  { label: '10.0.0.1 — RFC1918', url: 'http://10.0.0.1/', reason: 'blocked-range' },
  { label: '172.16.0.1 — RFC1918', url: 'http://172.16.0.1/', reason: 'blocked-range' },
  { label: '192.168.1.1 — RFC1918', url: 'http://192.168.1.1/', reason: 'blocked-range' },
  { label: '100.64.0.1 — CGNAT, commonly forgotten', url: 'http://100.64.0.1/', reason: 'blocked-range' },
  {
    label: 'user:pass@127.0.0.1 — credentials in URL',
    url: 'http://user:pass@127.0.0.1/',
    reason: 'userinfo-in-url',
  },
  { label: 'file:// scheme', url: 'file:///etc/passwd', reason: 'scheme-not-allowed' },
  { label: 'gopher:// scheme', url: 'gopher://127.0.0.1:70/', reason: 'scheme-not-allowed' },
  { label: 'localhost by name', url: 'http://localhost/', reason: 'blocked-hostname' },
  {
    label: 'metadata.google.internal — metadata by name',
    url: 'http://metadata.google.internal/computeMetadata/v1/',
    reason: 'metadata-endpoint',
  },
  { label: 'a *.internal name', url: 'http://vault.internal/', reason: 'blocked-hostname' },
  { label: 'a *.local name', url: 'http://printer.local/', reason: 'blocked-hostname' },
  { label: 'an unlisted port', url: 'http://example.com:22/', reason: 'port-not-allowed' },
]

describe('bypass corpus — decided from the URL, before DNS', () => {
  const safeFetch = createSafeFetch()

  for (const testCase of OFFLINE_CASES) {
    it(`blocks ${testCase.label}`, async () => {
      let caught: unknown
      try {
        await safeFetch(testCase.url)
      } catch (thrown) {
        caught = thrown
      }
      assert.ok(
        caught instanceof SsrfBlockedError,
        `${testCase.url} was not blocked (got ${caught === undefined ? 'a response' : String(caught)})`,
      )
      assert.equal(caught.reason, testCase.reason)
      assert.ok(caught.message.length > 0, 'the error must explain itself')
    })
  }
})

describe('bypass corpus — decided after DNS', () => {
  let dns: DnsServer
  let safeFetch: ReturnType<typeof createSafeFetch>

  before(async () => {
    dns = await startDnsServer((name, type) => {
      if (type === 'AAAA') {
        return name === 'v6-loopback.test' ? ['::1'] : []
      }
      switch (name) {
        // A public domain whose A record points at loopback. nip.io does this
        // for real; here we answer for it ourselves so the test stays offline.
        case '127.0.0.1.nip.io':
          return ['127.0.0.1']
        case 'metadata-by-cname.test':
          return ['169.254.169.254']
        case 'split-answer.test':
          // One address we allow, one we do not. The request must still fail.
          return ['198.51.100.7', '10.0.0.1']
        case 'v6-loopback.test':
          return []
        case 'empty.test':
          return []
        default:
          return ['198.51.100.7']
      }
    })

    safeFetch = createSafeFetch({
      dnsServers: [`127.0.0.1:${dns.port}`],
      // 198.51.100.0/24 is TEST-NET-2 and blocked by default; treat it as the
      // stand-in for "a legitimate public address" so the fixtures can use it.
      allowedRanges: ['198.51.100.0/24'],
    })
  })

  after(async () => {
    await dns.close()
  })

  const expectBlocked = async (url: string, reason: BlockReason): Promise<SsrfBlockedError> => {
    try {
      await safeFetch(url)
      assert.fail(`${url} was not blocked`)
    } catch (thrown) {
      assert.ok(thrown instanceof SsrfBlockedError, `expected SsrfBlockedError, got ${thrown}`)
      assert.equal(thrown.reason, reason)
      return thrown
    }
  }

  it('reports the address, not the port, when both rules would refuse', async () => {
    // Ordering is deliberate. A port rule would also block this, but
    // "someone reached for the metadata endpoint" is the signal worth paging
    // on, and a port-first check would hide it behind "port not permitted".
    const strict = createSafeFetch({ allowedPorts: [443] })
    await assert.rejects(
      () => strict('http://169.254.169.254:8080/latest/meta-data/'),
      (error: unknown) => {
        assert.ok(error instanceof SsrfBlockedError)
        assert.equal(error.reason, 'metadata-endpoint')
        return true
      },
    )
  })

  it('blocks 127.0.0.1.nip.io — a public domain resolving to loopback', async () => {
    const error = await expectBlocked('http://127.0.0.1.nip.io/', 'blocked-range')
    assert.equal(error.resolvedIp, '127.0.0.1')
    assert.equal(error.matchedRange, '127.0.0.0/8')
  })

  it('blocks a name resolving to the metadata endpoint', async () => {
    const error = await expectBlocked('http://metadata-by-cname.test/', 'metadata-endpoint')
    assert.equal(error.resolvedIp, '169.254.169.254')
  })

  it('blocks a name with two A records, one public and one private', async () => {
    // The attack is that you validate the first answer and connect to the
    // second. One bad address poisons the whole name.
    const error = await expectBlocked('http://split-answer.test/', 'blocked-range')
    assert.equal(error.resolvedIp, '10.0.0.1')
  })

  it('blocks a name whose AAAA record is loopback', async () => {
    const error = await expectBlocked('http://v6-loopback.test/', 'blocked-range')
    assert.equal(error.resolvedIp, '::1')
  })

  it('refuses a name with no records at all', async () => {
    await expectBlocked('http://empty.test/', 'no-addresses')
  })

  it('reports the resolved IP on every post-DNS block, for the audit log', async () => {
    const error = await expectBlocked('http://127.0.0.1.nip.io/', 'blocked-range')
    assert.ok(error.resolvedIp, 'resolvedIp must be present — layer 4 needs it')
    assert.equal(error.hostname, '127.0.0.1.nip.io')
    assert.equal(error.hop, 0)
  })
})
