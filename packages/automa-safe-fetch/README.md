# automa-safe-fetch

[![CI](https://github.com/codew3y/automa-safe-fetch/actions/workflows/ci.yml/badge.svg)](https://github.com/codew3y/automa-safe-fetch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/automa-safe-fetch)](https://www.npmjs.com/package/automa-safe-fetch)
[![dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](https://www.npmjs.com/package/automa-safe-fetch?activeTab=dependencies)

An HTTP client for applications that fetch URLs supplied by their users — without letting those users reach the inside of your network.

> **Status:** on npm, published from CI with provenance. Part of the [AutomaBuild](https://github.com/codew3y/AutomaBuild) workflow-automation platform (component A of four).
>
> Zero runtime dependencies. Node >= 20.6.

---

## The problem

The moment your application lets a user type in a URL — a webhook destination, an avatar to import, an RSS feed, a "call this API" step — you have handed an attacker a request generator that runs inside your infrastructure.

They will not type `http://evil.com`. They will type:

```
http://169.254.169.254/latest/meta-data/       # your cloud server's credentials
http://localhost:5432/                          # your database
http://10.0.0.7/admin                            # a service that trusts internal traffic
```

This is **Server-Side Request Forgery (SSRF)** — ranked API7 in the [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0xa7-server-side-request-forgery/).

And blocking those obvious strings is not enough, because all of the following also reach `127.0.0.1`:

```
http://2130706433/          decimal
http://0x7f000001/          hexadecimal
http://0177.0.0.1/          octal
http://[::ffff:127.0.0.1]/  IPv4-mapped IPv6
http://127.0.0.1.nip.io/    a public domain that resolves to loopback
```

The hardest case is **DNS rebinding**. An attacker controls the DNS for their own domain. You look it up, get a harmless public IP, decide it is safe — and by the time your HTTP client opens the socket a moment later, the same name resolves to `169.254.169.254`. You validated one address and connected to another.

Node's built-in `fetch` does not protect against any of this. The [upstream issue](https://github.com/nodejs/undici/issues/2019) has been open since March 2023.

## What this does

- Parses and normalises the URL, rejecting non-HTTP schemes, embedded credentials, and odd ports
- Resolves **every** A and AAAA record and validates each against the blocked ranges below
- **Connects to the validated IP address directly**, passing the hostname only as SNI and the `Host` header — so the DNS answer cannot change between the check and the connection. This closes the rebinding window.
- Re-runs the whole validation on **every redirect hop**, with a hop cap. Redirects are off by default.
- Caps response size with a streaming abort, so a malicious server cannot exhaust memory

### Blocked by default

Ranges follow [RFC 6890](https://www.rfc-editor.org/rfc/rfc6890), the special-purpose address registry.

| | Ranges |
|---|---|
| IPv4 | `0.0.0.0/8` `10.0.0.0/8` `100.64.0.0/10` `127.0.0.0/8` `169.254.0.0/16` `172.16.0.0/12` `192.0.0.0/24` `192.0.2.0/24` `192.168.0.0/16` `198.18.0.0/15` `198.51.100.0/24` `203.0.113.0/24` `224.0.0.0/4` `240.0.0.0/4` |
| IPv6 | `::/128` `::1/128` `::ffff:0:0/96` `64:ff9b::/96` `100::/64` `2001:db8::/32` `fc00::/7` `fe80::/10` `ff00::/8` |
| Cloud metadata | `169.254.169.254` (AWS/GCP/Azure), `fd00:ec2::254` (AWS over IPv6) |
| Hostnames | `localhost`, `*.local`, `*.internal`, `*.home.arpa`, `metadata.google.internal`, `metadata.goog`, `metadata.amazonaws.com`, `instance-data` |

Ports are also allow-listed: `80`, `443`, `8080`, `8443` by default.

Every one of these is overridable — `allowedRanges` punches a hole through the deny-list for a range you genuinely mean to reach, and is checked first.

## Install

```bash
npm install automa-safe-fetch
```

## Usage

```ts
import { createSafeFetch, SsrfBlockedError, getConnectionInfo } from 'automa-safe-fetch'

const safeFetch = createSafeFetch({
  maxRedirects: 0,                     // default: do not follow redirects at all
  maxResponseBytes: 10 * 1024 * 1024,  // streaming cap, aborts mid-body
  timeoutMs: 30_000,                   // whole operation, redirects included
})

try {
  const res = await safeFetch('https://api.example.com/data')
  console.log(res.status, await res.text())

  // Log this. Detection needs the address you actually connected to.
  console.log(getConnectionInfo(res)?.resolvedIp)
} catch (err) {
  if (err instanceof SsrfBlockedError) {
    console.warn(`blocked: ${err.reason}`, {
      hostname: err.hostname,
      resolvedIp: err.resolvedIp,   // present whenever DNS got far enough
      matchedRange: err.matchedRange,
      hop: err.hop,                 // which redirect refused; 0 is the caller's URL
    })
  }
}
```

The returned value is a standard `Response`, so `.text()`, `.json()`, `.arrayBuffer()` and `.body` all work as usual.

### Options

| Option | Default | |
|---|---|---|
| `maxRedirects` | `0` | A redirect is a URL the *server* chose. Each hop is revalidated from scratch. |
| `maxResponseBytes` | `10 MiB` | Enforced as bytes arrive, and pre-emptively from `Content-Length`. |
| `timeoutMs` | `30_000` | Covers the whole operation, not just the connect. |
| `allowedPorts` | `80, 443, 8080, 8443` | |
| `allowedRanges` | none | CIDRs permitted even if a blocked range matches. Checked first. |
| `extraBlockedRanges` | none | Added to the defaults — your own internal ranges belong here. |
| `blockedRanges` | the table above | Replaces the defaults entirely. |
| `extraBlockedHostnames` | none | Your internal domains belong here. |
| `dnsServers` | system | |
| `resolver` | built-in | Injectable, so a test can drive DNS. |
| `onConnect` | none | Called with `ConnectionInfo` for every connection. |

All of `maxRedirects`, `maxResponseBytes` and `timeoutMs` can also be overridden per request.

### Errors

| Class | |
|---|---|
| `SsrfBlockedError` | The request resolved somewhere it must not reach. Carries `reason`, `hostname`, `resolvedIp`, `matchedRange`, `hop`. |
| `ResponseTooLargeError` | Body exceeded the cap; the connection was torn down. |
| `TooManyRedirectsError` | Chain longer than `maxRedirects` (including a redirect when they are disabled). |
| `SafeFetchTimeoutError` | Deadline expired. |

`reason` is one of `scheme-not-allowed`, `userinfo-in-url`, `port-not-allowed`, `malformed-url`, `ip-literal-encoded`, `blocked-hostname`, `dns-resolution-failed`, `no-addresses`, `blocked-range`, `ipv4-mapped-ipv6`, `metadata-endpoint`, `unpinned-resolution`. These are stable — switch on them, alert on them.

Address checks run *before* the port check, deliberately. Both would refuse the request, but `metadata-endpoint` is the reason worth paging someone over, and a port rule running first would hide it behind `port-not-allowed`.

## What this is not

**This is a defence-in-depth layer, not a security boundary.** OWASP is explicit that address deny-lists are bypass-prone. The durable control for untrusted-URL fetching is network topology: run the fetcher in a subnet with no route to anything internal, force egress through a proxy, and require IMDSv2 with a hop limit of 1. Use this library *and* do that. If you can only do one, do the network isolation.

Specific things it deliberately does not do:

- **No egress proxy or network isolation.** That is infrastructure, and it is the layer that actually holds.
- **No decompression-bomb defence.** The size cap counts bytes on the wire, and the client asks for `identity` encoding so that number is meaningful. If you override `accept-encoding`, the cap no longer bounds what you decompress.
- **No retries, backoff, or circuit breaking.**
- **No authentication or credential handling**, beyond dropping `Authorization` and `Cookie` when a server redirects you to another origin.
- **`allowedRanges` is a loaded gun.** It is checked before everything else. Whatever you put there is reachable.

One residual gap worth naming: validation happens per request, so a name that passes now could rebind before a *later* request. That is handled by revalidating every time — there is no caching of a verdict — but it does mean a long-lived response stream is only ever as trustworthy as the address it was pinned to at the start.

## Testing

The test suite is the point of this project.

```bash
npm test              # 84 tests, hermetic — no network
npm run test:online   # opt-in: proves real public requests still work
```

It runs a DNS server the suite owns, which answers with an allowed address on the first query and the metadata endpoint on every one after. The rebinding test then asserts three things: the body came from the intended origin, the connection landed on the validated address, and **exactly one** DNS query was made for the whole request. That last assertion is the one that matters — a second query would mean the HTTP stack re-resolved, which is precisely the window this library exists to close. It is checked by counting packets at a server we control, not by reading the code and hoping.

The rest covers every encoding in the table, both IPv4-mapped IPv6 forms, a name with one public and one private A record, redirect chains that turn private at hop 1 and at hop 2, `Authorization` stripping across an origin change, and a 32 MB response aborted at a 256 KB cap.

The TLS tests generate throwaway certificates with `openssl` at run time and prove the certificate is verified against the *hostname* over a socket opened to the pinned IP — the failure mode where pinning silently discards the server's identity. They skip themselves if `openssl` is not on PATH.

`npm run test:online` is separate on purpose: a library that blocks everything passes the entire bypass corpus and is useless.

## Reporting a bypass

Privately, through [GitHub's private vulnerability reporting](https://github.com/codew3y/automa-safe-fetch/security). See [SECURITY.md](SECURITY.md) for what counts and what is out of scope.

## License

MIT
