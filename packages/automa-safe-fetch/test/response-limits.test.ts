/**
 * Layer 3: the response itself is hostile input.
 *
 * The cap has to abort the stream, not buffer and then measure — by the time
 * you can measure a buffered body you have already spent the memory.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSafeFetch,
  ResponseTooLargeError,
  SafeFetchTimeoutError,
} from '../src/index.ts'
import { startDnsServer, type DnsServer } from './helpers/dns-server.ts'
import { startHttpServer, type TestServer } from './helpers/http-server.ts'

describe('response size cap', () => {
  let origin: TestServer
  let dns: DnsServer
  let bytesWritten = 0

  before(async () => {
    origin = await startHttpServer((request, response) => {
      const path = request.url ?? '/'

      if (path === '/declared-large') {
        // Honest Content-Length: we can refuse before reading a single byte.
        response.writeHead(200, { 'content-length': String(50 * 1024 * 1024) })
        response.end(Buffer.alloc(1024))
        return
      }

      if (path === '/chunked-large') {
        // No Content-Length. The only defence is counting as it arrives.
        response.writeHead(200, { 'transfer-encoding': 'chunked' })
        bytesWritten = 0
        const chunk = Buffer.alloc(64 * 1024, 0x61)
        const pump = (): void => {
          while (bytesWritten < 32 * 1024 * 1024) {
            bytesWritten += chunk.byteLength
            if (!response.write(chunk)) {
              response.once('drain', pump)
              return
            }
          }
          response.end()
        }
        pump()
        return
      }

      if (path === '/slow') {
        response.writeHead(200)
        response.write('start')
        // Never ends. The timeout is the only way out.
        return
      }

      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('small enough')
    })

    dns = await startDnsServer((_name, type) => (type === 'A' ? ['127.0.0.1'] : []))
  })

  after(async () => {
    await origin.close()
    await dns.close()
  })

  const makeFetch = (overrides: { maxResponseBytes?: number; timeoutMs?: number } = {}) =>
    createSafeFetch({
      dnsServers: [`127.0.0.1:${dns.port}`],
      allowedPorts: [origin.port],
      allowedRanges: ['127.0.0.1/32'],
      ...overrides,
    })

  it('refuses a response whose declared length exceeds the cap', async () => {
    const safeFetch = makeFetch({ maxResponseBytes: 1024 })
    await assert.rejects(
      () => safeFetch(`http://origin.test:${origin.port}/declared-large`),
      ResponseTooLargeError,
    )
  })

  it('aborts a chunked response mid-stream once the cap is passed', async () => {
    const cap = 256 * 1024
    const safeFetch = makeFetch({ maxResponseBytes: cap })
    const response = await safeFetch(`http://origin.test:${origin.port}/chunked-large`)

    await assert.rejects(() => response.arrayBuffer(), ResponseTooLargeError)

    // The server was writing 32 MB. If we had buffered before measuring, it
    // would all be in memory by now.
    assert.ok(
      bytesWritten < 32 * 1024 * 1024,
      'the connection was not torn down early — the cap buffered instead of aborting',
    )
  })

  it('lets a response under the cap through untouched', async () => {
    const safeFetch = makeFetch({ maxResponseBytes: 1024 })
    const response = await safeFetch(`http://origin.test:${origin.port}/fine`)
    assert.equal(await response.text(), 'small enough')
  })

  it('does not ask for compression, so the cap counts bytes the caller sees', async () => {
    // A gzipped body can expand past the cap after it has been accepted.
    // Requesting identity keeps the measurement honest.
    const safeFetch = makeFetch()
    const response = await safeFetch(`http://origin.test:${origin.port}/fine`)
    await response.text()
    assert.equal(origin.hits.at(-1)?.url, '/fine')
  })
})

describe('timeouts', () => {
  let origin: TestServer
  let dns: DnsServer

  before(async () => {
    origin = await startHttpServer((request, response) => {
      if ((request.url ?? '') === '/hang') {
        response.writeHead(200)
        response.write('waiting')
        return // never ends
      }
      response.writeHead(200)
      response.end('done')
    })
    dns = await startDnsServer((_name, type) => (type === 'A' ? ['127.0.0.1'] : []))
  })

  after(async () => {
    await origin.close()
    await dns.close()
  })

  it('gives up on a server that never finishes', async () => {
    const safeFetch = createSafeFetch({
      dnsServers: [`127.0.0.1:${dns.port}`],
      allowedPorts: [origin.port],
      allowedRanges: ['127.0.0.1/32'],
      timeoutMs: 300,
    })
    const response = await safeFetch(`http://origin.test:${origin.port}/hang`)
    await assert.rejects(() => response.text(), SafeFetchTimeoutError)
  })

  it('honours an AbortSignal from the caller', async () => {
    const safeFetch = createSafeFetch({
      dnsServers: [`127.0.0.1:${dns.port}`],
      allowedPorts: [origin.port],
      allowedRanges: ['127.0.0.1/32'],
    })
    const controller = new AbortController()
    const pending = safeFetch(`http://origin.test:${origin.port}/hang`, {
      signal: controller.signal,
    }).then(
      (response) => response.text(),
      (error: unknown) => {
        throw error
      },
    )
    setTimeout(() => controller.abort(), 100)
    await assert.rejects(() => pending)
  })
})
