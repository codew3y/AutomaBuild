/**
 * TLS through the pin.
 *
 * This is where a pinning HTTP client goes quietly wrong. Connecting to a
 * validated IP while verifying the certificate against *that IP* would look
 * like it works — no error, traffic flows — and would have thrown the server's
 * identity away. The certificate has to be checked against the hostname, over
 * a socket opened to an address the hostname no longer controls.
 *
 * Both tests run in a child process, because trust has to be established via
 * NODE_EXTRA_CA_CERTS before the runtime starts. They are spawned
 * asynchronously on purpose: the DNS server the child queries lives in this
 * process, and `spawnSync` would block the event loop that serves it.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { spawn } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import { startDnsServer, type DnsServer } from './helpers/dns-server.ts'
import { createSelfSignedCert, opensslAvailable, type Certificate } from './helpers/tls-fixture.ts'

const SKIP = opensslAvailable() ? false : 'openssl not on PATH'

interface TlsServer {
  port: number
  close: () => Promise<void>
}

async function startTlsServer(cert: Certificate, body: string): Promise<TlsServer> {
  const server = https.createServer(
    { cert: cert.certPem, key: cert.keyPem },
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(body)
    },
  )
  // A rejected handshake surfaces on the client; the server must not die of it.
  server.on('tlsClientError', () => {})
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

interface ChildOutcome {
  ok: boolean
  status?: number
  body?: string
  resolvedIp?: string
  code?: string
  message?: string
}

/** Run one safe-fetch request in a child that trusts `caPath`, and report what happened. */
function fetchInChild(args: {
  url: string
  port: number
  dnsPort: number
  caPath: string
}): Promise<ChildOutcome> {
  const script = `
    import { createSafeFetch, getConnectionInfo } from './src/index.ts'
    const safeFetch = createSafeFetch({
      dnsServers: ['127.0.0.1:${args.dnsPort}'],
      allowedPorts: [${args.port}],
      allowedRanges: ['127.0.0.1/32'],
      timeoutMs: 10000,
    })
    try {
      const res = await safeFetch(${JSON.stringify(args.url)})
      const body = await res.text()
      console.log(JSON.stringify({
        ok: true,
        status: res.status,
        body,
        resolvedIp: getConnectionInfo(res)?.resolvedIp,
      }))
    } catch (error) {
      console.log(JSON.stringify({
        ok: false,
        code: error.code ?? error.name,
        message: error.message,
      }))
    }
  `

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: args.caPath },
      cwd: process.cwd(),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${code}: ${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()) as ChildOutcome)
      } catch {
        reject(new Error(`unparseable child output: ${stdout} ${stderr}`))
      }
    })
  })
}

describe('TLS identity survives the pin', { skip: SKIP }, () => {
  let matching: Certificate
  let mismatched: Certificate
  let matchingServer: TlsServer
  let mismatchedServer: TlsServer
  let dns: DnsServer

  before(async () => {
    matching = createSelfSignedCert('pinned.test')
    mismatched = createSelfSignedCert('somewhere-else.test')
    matchingServer = await startTlsServer(matching, 'over TLS, pinned')
    mismatchedServer = await startTlsServer(mismatched, 'should never be read')
    dns = await startDnsServer((_name, type) => (type === 'A' ? ['127.0.0.1'] : []))
  })

  after(async () => {
    await matchingServer.close()
    await mismatchedServer.close()
    await dns.close()
    matching.dispose()
    mismatched.dispose()
  })

  it('verifies the certificate against the hostname, not the pinned IP', async () => {
    // The decisive one. The certificate names `pinned.test` and nothing else;
    // the socket was opened to 127.0.0.1. Success is only possible if the
    // hostname survived the pin and was used as the TLS identity. Had the IP
    // been used instead, this would fail ERR_TLS_CERT_ALTNAME_INVALID.
    const outcome = await fetchInChild({
      url: `https://pinned.test:${matchingServer.port}/`,
      port: matchingServer.port,
      dnsPort: dns.port,
      caPath: matching.certPath,
    })

    assert.ok(outcome.ok, `request failed: ${outcome.code} ${outcome.message}`)
    assert.equal(outcome.status, 200)
    assert.equal(outcome.body, 'over TLS, pinned')
    assert.equal(outcome.resolvedIp, '127.0.0.1', 'connected somewhere unvalidated')
  })

  it('rejects a trusted certificate that names a different host', async () => {
    // The guard against the previous test passing because verification is off.
    // This certificate is trusted, so the chain check succeeds and the name
    // check is what refuses it.
    const outcome = await fetchInChild({
      url: `https://pinned.test:${mismatchedServer.port}/`,
      port: mismatchedServer.port,
      dnsPort: dns.port,
      caPath: mismatched.certPath,
    })

    assert.equal(outcome.ok, false, 'a certificate for another host was accepted')
    assert.equal(outcome.code, 'ERR_TLS_CERT_ALTNAME_INVALID')
  })
})
