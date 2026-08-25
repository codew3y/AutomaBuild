/**
 * IP parsing and CIDR matching, on bytes.
 *
 * Everything here works on the *binary* address, never on the string form.
 * String comparison is how bypasses get through: `0x7f000001`, `0177.0.0.1`
 * and `2130706433` are all `127.0.0.1` once parsed, and no amount of substring
 * matching finds that reliably.
 *
 * No dependencies. This is the part of the library you are meant to read.
 */

export type IpFamily = 4 | 6

export interface ParsedIp {
  /** 4 bytes for IPv4, 16 for IPv6. */
  readonly bytes: Uint8Array
  readonly family: IpFamily
}

export interface Cidr {
  readonly bytes: Uint8Array
  readonly prefix: number
  readonly family: IpFamily
  /** The original text, for error messages. */
  readonly source: string
}

/**
 * Strict dotted-decimal IPv4. Four parts, 0-255, no leading zeros.
 *
 * Leading zeros are rejected rather than parsed: `0177.0.0.1` is octal to
 * `inet_aton` and decimal to a naive parser, and that disagreement is itself
 * the vulnerability. Callers detect the encoded forms separately (see
 * `detectEncodedIpLiteral`) so the error can name what was attempted.
 */
export function parseIpv4(input: string): Uint8Array | null {
  const parts = input.split('.')
  if (parts.length !== 4) return null
  const bytes = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!
    if (part.length === 0 || part.length > 3) return null
    if (!/^[0-9]+$/.test(part)) return null
    if (part.length > 1 && part.startsWith('0')) return null
    const value = Number(part)
    if (value > 255) return null
    bytes[i] = value
  }
  return bytes
}

/**
 * IPv6, including `::` compression and a trailing embedded IPv4
 * (`::ffff:127.0.0.1`). Surrounding brackets are accepted and stripped.
 */
export function parseIpv6(input: string): Uint8Array | null {
  let text = input
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  // A zone index (%eth0) never belongs in a URL we are about to fetch.
  if (text.includes('%')) return null
  if (text.length === 0) return null

  const doubleColon = text.indexOf('::')
  if (doubleColon !== -1 && text.indexOf('::', doubleColon + 1) !== -1) return null

  const head = doubleColon === -1 ? text : text.slice(0, doubleColon)
  const tail = doubleColon === -1 ? '' : text.slice(doubleColon + 2)

  const headGroups = head.length > 0 ? head.split(':') : []
  const tailGroups = tail.length > 0 ? tail.split(':') : []

  // An embedded IPv4 occupies the final two groups of whichever half holds it.
  const trailing = doubleColon === -1 ? headGroups : tailGroups
  let embedded: Uint8Array | null = null
  const last = trailing[trailing.length - 1]
  if (last !== undefined && last.includes('.')) {
    embedded = parseIpv4(last)
    if (embedded === null) return null
    trailing.pop()
  }

  const embeddedGroups = embedded === null ? 0 : 2
  const total = headGroups.length + tailGroups.length + embeddedGroups
  if (doubleColon === -1 ? total !== 8 : total > 7) return null

  const bytes = new Uint8Array(16)
  let offset = 0
  for (const group of headGroups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
    const value = parseInt(group, 16)
    bytes[offset++] = value >>> 8
    bytes[offset++] = value & 0xff
  }

  // Everything after `::` is right-aligned in the 16-byte buffer.
  if (doubleColon !== -1) {
    offset = 16 - (tailGroups.length * 2 + embeddedGroups * 2)
  }
  for (const group of tailGroups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
    const value = parseInt(group, 16)
    bytes[offset++] = value >>> 8
    bytes[offset++] = value & 0xff
  }
  if (embedded !== null) bytes.set(embedded, offset)

  return bytes
}

/** Parse either family. Returns null for anything that is not an IP literal. */
export function parseIp(input: string): ParsedIp | null {
  if (input.includes(':') || input.startsWith('[')) {
    const bytes = parseIpv6(input)
    return bytes === null ? null : { bytes, family: 6 }
  }
  const bytes = parseIpv4(input)
  return bytes === null ? null : { bytes, family: 4 }
}

/** `::ffff:0:0/96` — an IPv4 address wearing an IPv6 costume. */
export function isIpv4Mapped(bytes: Uint8Array): boolean {
  if (bytes.length !== 16) return false
  for (let i = 0; i < 10; i++) {
    if (bytes[i] !== 0) return false
  }
  return bytes[10] === 0xff && bytes[11] === 0xff
}

/** The 4 embedded bytes of an IPv4-mapped IPv6 address, or null. */
export function unwrapIpv4Mapped(bytes: Uint8Array): Uint8Array | null {
  if (!isIpv4Mapped(bytes)) return null
  return bytes.slice(12, 16)
}

export function ipToString(bytes: Uint8Array): string {
  if (bytes.length === 4) return Array.from(bytes).join('.')

  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) {
    groups.push((((bytes[i]! << 8) | bytes[i + 1]!) >>> 0).toString(16))
  }

  // Compress the longest run of zero groups into `::`.
  let bestStart = -1
  let bestLength = 0
  let runStart = -1
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === '0') {
      if (runStart === -1) runStart = i
      continue
    }
    if (runStart !== -1) {
      const length = i - runStart
      if (length > bestLength) {
        bestStart = runStart
        bestLength = length
      }
      runStart = -1
    }
  }
  if (bestLength < 2) return groups.join(':')
  const head = groups.slice(0, bestStart).join(':')
  const tail = groups.slice(bestStart + bestLength).join(':')
  return `${head}::${tail}`
}

export function parseCidr(input: string): Cidr | null {
  const slash = input.lastIndexOf('/')
  if (slash === -1) {
    const bare = parseIp(input)
    if (bare === null) return null
    return {
      bytes: bare.bytes,
      prefix: bare.family === 4 ? 32 : 128,
      family: bare.family,
      source: input,
    }
  }
  const address = parseIp(input.slice(0, slash))
  const prefixText = input.slice(slash + 1)
  if (address === null || !/^[0-9]{1,3}$/.test(prefixText)) return null
  const prefix = Number(prefixText)
  if (prefix > (address.family === 4 ? 32 : 128)) return null
  return { bytes: address.bytes, prefix, family: address.family, source: input }
}

/** Byte-wise prefix comparison. Families must match; no implicit conversion. */
export function cidrContains(cidr: Cidr, address: Uint8Array): boolean {
  if (cidr.bytes.length !== address.length) return false
  const wholeBytes = cidr.prefix >>> 3
  for (let i = 0; i < wholeBytes; i++) {
    if (cidr.bytes[i] !== address[i]) return false
  }
  const remainingBits = cidr.prefix & 7
  if (remainingBits === 0) return true
  const mask = (0xff << (8 - remainingBits)) & 0xff
  return (cidr.bytes[wholeBytes]! & mask) === (address[wholeBytes]! & mask)
}

export type EncodedIpForm = 'decimal' | 'hexadecimal' | 'octal' | 'shorthand'

/**
 * Detect an IPv4 literal written in a non-dotted-decimal form.
 *
 * WHATWG `URL` already normalises these — `new URL('http://0x7f000001/')` has
 * hostname `127.0.0.1` — so the blocklist catches them regardless. We detect
 * them anyway, on the raw input, so the rejection can say *which* trick was
 * tried. That distinction matters to whoever reads the alert at 03:00.
 */
export function detectEncodedIpLiteral(rawHost: string): EncodedIpForm | null {
  const host = rawHost.trim()
  if (host.length === 0 || host.includes(':')) return null

  if (/^0[xX][0-9a-fA-F]+$/.test(host)) return 'hexadecimal'
  if (/^[0-9]+$/.test(host)) {
    if (host === '0') return 'shorthand'
    if (/^0[0-7]+$/.test(host)) return 'octal'
    return 'decimal'
  }

  const parts = host.split('.')
  if (parts.length < 2 || parts.length > 4) return null

  let sawHex = false
  let sawOctal = false
  for (const part of parts) {
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      sawHex = true
      continue
    }
    if (/^0[0-7]+$/.test(part)) {
      sawOctal = true
      continue
    }
    // Any label that is not purely numeric means this is a real hostname.
    if (!/^[0-9]+$/.test(part)) return null
  }

  if (sawHex) return 'hexadecimal'
  if (sawOctal) return 'octal'
  // All-numeric with fewer than four parts is still an inet_aton shorthand
  // (`10.1` is 10.0.0.1). Four plain parts is ordinary dotted decimal.
  return parts.length < 4 ? 'shorthand' : null
}
