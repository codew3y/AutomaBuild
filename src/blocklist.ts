/**
 * What is refused by default, and the machinery for overriding it.
 *
 * Ranges follow RFC 6890 (the authoritative special-purpose address registry)
 * plus the cloud metadata endpoints, which are ordinary link-local addresses
 * that happen to hand out credentials.
 *
 * Read this list sceptically. OWASP is explicit that deny-lists are
 * bypass-prone; this one is a defence-in-depth layer, not a boundary.
 */

import { type Cidr, cidrContains, parseCidr, unwrapIpv4Mapped } from './ip.ts'

export const DEFAULT_BLOCKED_IPV4: readonly string[] = [
  '0.0.0.0/8', // "this network" — 0 is shorthand for 0.0.0.0, which routes to localhost on Linux
  '10.0.0.0/8', // RFC1918 private
  '100.64.0.0/10', // CGNAT — routinely forgotten, routinely reachable
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, and therefore 169.254.169.254 (AWS/GCP/Azure metadata)
  '172.16.0.0/12', // RFC1918 private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1
  '192.168.0.0/16', // RFC1918 private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, includes 255.255.255.255 broadcast
]

export const DEFAULT_BLOCKED_IPV6: readonly string[] = [
  '::/128', // unspecified
  '::1/128', // loopback
  '::ffff:0:0/96', // IPv4-mapped — the classic bypass; see note in validateAddress
  '64:ff9b::/96', // NAT64, which translates straight back to IPv4
  '100::/64', // discard-only
  '2001:db8::/32', // documentation
  'fc00::/7', // unique local (ULA)
  'fe80::/10', // link-local
  'ff00::/8', // multicast
  'fd00:ec2::254/128', // AWS IMDS over IPv6 on Nitro
]

/**
 * Hostnames refused before DNS is even consulted.
 *
 * A leading dot means "this name and anything under it".
 */
export const DEFAULT_BLOCKED_HOSTNAMES: readonly string[] = [
  'localhost',
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  'metadata.google.internal',
  'metadata.goog',
  'metadata.amazonaws.com',
  'instance-data',
  'instance-data.ec2.internal',
]

/** Hostnames whose whole purpose is to reach the credential endpoint. */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata.amazonaws.com',
  'instance-data',
  'instance-data.ec2.internal',
])

/** Addresses that are the metadata endpoint, rather than merely private. */
const METADATA_ADDRESSES = new Set(['169.254.169.254', 'fd00:ec2::254'])

export interface Blocklist {
  readonly blocked: readonly Cidr[]
  readonly allowed: readonly Cidr[]
  readonly blockedHostnames: readonly string[]
}

function compile(ranges: readonly string[], label: string): Cidr[] {
  return ranges.map((range) => {
    const cidr = parseCidr(range)
    if (cidr === null) {
      throw new TypeError(`Invalid CIDR in ${label}: ${JSON.stringify(range)}`)
    }
    return cidr
  })
}

export interface BlocklistOptions {
  /** Replaces the default ranges entirely. Omit to keep the defaults. */
  blockedRanges?: readonly string[]
  /** Added to whichever ranges are in force. */
  extraBlockedRanges?: readonly string[]
  /**
   * Ranges permitted even if a blocked range also matches.
   *
   * This is the deliberate escape hatch — a private range you genuinely do
   * mean to reach, or a test fixture. It is checked first and it wins.
   */
  allowedRanges?: readonly string[]
  /** Replaces the default hostname rules entirely. */
  blockedHostnames?: readonly string[]
  extraBlockedHostnames?: readonly string[]
}

export function createBlocklist(options: BlocklistOptions = {}): Blocklist {
  const base =
    options.blockedRanges ?? [...DEFAULT_BLOCKED_IPV4, ...DEFAULT_BLOCKED_IPV6]
  const blocked = compile(
    [...base, ...(options.extraBlockedRanges ?? [])],
    'blockedRanges',
  )
  const allowed = compile(options.allowedRanges ?? [], 'allowedRanges')
  const hostnames = [
    ...(options.blockedHostnames ?? DEFAULT_BLOCKED_HOSTNAMES),
    ...(options.extraBlockedHostnames ?? []),
  ].map((name) => name.toLowerCase())
  return { blocked, allowed, blockedHostnames: hostnames }
}

export type AddressVerdict =
  | { allowed: true }
  | {
      allowed: false
      reason: 'blocked-range' | 'ipv4-mapped-ipv6' | 'metadata-endpoint'
      matchedRange: string
    }

/**
 * Decide whether a single resolved address may be connected to.
 *
 * IPv4-mapped IPv6 gets special handling: `::ffff:127.0.0.1` is reported as
 * `ipv4-mapped-ipv6` rather than a plain range match, because the interesting
 * fact for whoever reads the log is that someone tried the costume, not that
 * `::ffff:0:0/96` is on a list.
 */
export function validateAddress(
  list: Blocklist,
  address: Uint8Array,
  addressText: string,
): AddressVerdict {
  for (const cidr of list.allowed) {
    if (cidrContains(cidr, address)) return { allowed: true }
  }

  if (METADATA_ADDRESSES.has(addressText)) {
    return {
      allowed: false,
      reason: 'metadata-endpoint',
      matchedRange: addressText,
    }
  }

  const unwrapped = unwrapIpv4Mapped(address)
  if (unwrapped !== null) {
    // Explicitly allowing the embedded v4 address is the only way through.
    for (const cidr of list.allowed) {
      if (cidrContains(cidr, unwrapped)) return { allowed: true }
    }
    return {
      allowed: false,
      reason: 'ipv4-mapped-ipv6',
      matchedRange: '::ffff:0:0/96',
    }
  }

  for (const cidr of list.blocked) {
    if (cidrContains(cidr, address)) {
      return {
        allowed: false,
        reason: METADATA_ADDRESSES.has(addressText)
          ? 'metadata-endpoint'
          : 'blocked-range',
        matchedRange: cidr.source,
      }
    }
  }

  return { allowed: true }
}

export interface HostnameVerdict {
  blocked: boolean
  /** True when the name exists to reach a credential endpoint. */
  isMetadata: boolean
  matched?: string
}

export function validateHostname(
  list: Blocklist,
  hostname: string,
): HostnameVerdict {
  const name = hostname.toLowerCase().replace(/\.$/, '')
  for (const rule of list.blockedHostnames) {
    const matches = rule.startsWith('.')
      ? name === rule.slice(1) || name.endsWith(rule)
      : name === rule
    if (matches) {
      return {
        blocked: true,
        isMetadata: METADATA_HOSTNAMES.has(name),
        matched: rule,
      }
    }
  }
  return { blocked: false, isMetadata: false }
}
