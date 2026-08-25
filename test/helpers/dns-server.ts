/**
 * A DNS server we control, so the test suite can make a name mean one thing
 * on the first query and something else on the second.
 *
 * Hand-rolled wire format, because the whole point of the rebinding test is
 * that nothing between the query and the answer is taken on trust.
 */

import dgram from 'node:dgram'
import { parseIpv4, parseIpv6 } from '../../src/ip.ts'

export type RecordType = 'A' | 'AAAA'

export interface DnsQuery {
  readonly name: string
  readonly type: RecordType
}

export interface DnsServer {
  readonly port: number
  /** Every query received, in order. */
  readonly queries: DnsQuery[]
  queriesFor(type: RecordType): DnsQuery[]
  close(): Promise<void>
}

/**
 * `answer` is called once per query. Return the addresses to answer with, or
 * an empty array for NODATA. It receives the 1-based index of this query for
 * that (name, type) pair, which is how the rebinding fixture flips its answer.
 */
export type AnswerFn = (
  name: string,
  type: RecordType,
  queryIndex: number,
) => readonly string[]

export async function startDnsServer(answer: AnswerFn): Promise<DnsServer> {
  const socket = dgram.createSocket('udp4')
  const queries: DnsQuery[] = []
  const counters = new Map<string, number>()

  socket.on('message', (message, remote) => {
    let parsed: { id: number; name: string; type: number; questionEnd: number }
    try {
      parsed = parseQuery(message)
    } catch {
      return // Malformed query; a real server would SERVFAIL. We stay silent.
    }

    const type: RecordType | null =
      parsed.type === 1 ? 'A' : parsed.type === 28 ? 'AAAA' : null
    if (type === null) {
      socket.send(buildResponse(message, parsed, []), remote.port, remote.address)
      return
    }

    queries.push({ name: parsed.name, type })
    const key = `${parsed.name}|${type}`
    const index = (counters.get(key) ?? 0) + 1
    counters.set(key, index)

    const addresses = answer(parsed.name, type, index)
    const rdata = addresses
      .map((address) => (type === 'A' ? parseIpv4(address) : parseIpv6(address)))
      .filter((bytes): bytes is Uint8Array => bytes !== null)

    socket.send(buildResponse(message, parsed, rdata), remote.port, remote.address)
  })

  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve))
  const port = (socket.address() as { port: number }).port

  return {
    port,
    queries,
    queriesFor: (type) => queries.filter((query) => query.type === type),
    close: () =>
      new Promise<void>((resolve) => {
        socket.close(() => resolve())
      }),
  }
}

function parseQuery(message: Buffer): {
  id: number
  name: string
  type: number
  questionEnd: number
} {
  const id = message.readUInt16BE(0)
  const questionCount = message.readUInt16BE(4)
  if (questionCount < 1) throw new Error('no question')

  const labels: string[] = []
  let offset = 12
  for (;;) {
    const length = message.readUInt8(offset)
    offset += 1
    if (length === 0) break
    if (length > 63) throw new Error('compressed or invalid label in question')
    labels.push(message.subarray(offset, offset + length).toString('ascii'))
    offset += length
  }
  const type = message.readUInt16BE(offset)
  return { id, name: labels.join('.'), type, questionEnd: offset + 4 }
}

function buildResponse(
  query: Buffer,
  parsed: { id: number; type: number; questionEnd: number },
  rdata: readonly Uint8Array[],
): Buffer {
  const header = Buffer.alloc(12)
  header.writeUInt16BE(parsed.id, 0)
  header.writeUInt16BE(0x8180, 2) // response, recursion desired + available, NOERROR
  header.writeUInt16BE(1, 4) // QDCOUNT
  header.writeUInt16BE(rdata.length, 6) // ANCOUNT
  header.writeUInt16BE(0, 8)
  header.writeUInt16BE(0, 10)

  const question = query.subarray(12, parsed.questionEnd)
  const answers = rdata.map((bytes) => {
    const record = Buffer.alloc(12 + bytes.length)
    record.writeUInt16BE(0xc00c, 0) // pointer to the question's name
    record.writeUInt16BE(parsed.type, 2)
    record.writeUInt16BE(1, 4) // class IN
    record.writeUInt32BE(0, 6) // TTL 0 — never let a cache answer for us
    record.writeUInt16BE(bytes.length, 10)
    Buffer.from(bytes).copy(record, 12)
    return record
  })

  return Buffer.concat([header, question, ...answers])
}
