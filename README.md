# automa-safe-fetch

An HTTP client for applications that fetch URLs supplied by their users — without letting those users reach the inside of your network.

> **Status:** in development. Part of the [AutomaBuild](https://github.com/codew3y/AutomaBuild) workflow-automation platform (component A of four).

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

| | Ranges |
|---|---|
| IPv4 | `0.0.0.0/8` `10.0.0.0/8` `100.64.0.0/10` `127.0.0.0/8` `169.254.0.0/16` `172.16.0.0/12` `192.0.0.0/24` `192.168.0.0/16` `224.0.0.0/4` `240.0.0.0/4` |
| IPv6 | `::/128` `::1/128` `::ffff:0:0/96` `fc00::/7` `fe80::/10` `ff00::/8` |
| Cloud metadata | `169.254.169.254` (AWS/GCP/Azure), `fd00:ec2::254`, `metadata.google.internal` |
| Hostnames | `localhost`, `*.internal`, `*.local` |

## Usage

```ts
// API sketch — subject to change until v0.1.0
import { createSafeFetch } from 'automa-safe-fetch'

const safeFetch = createSafeFetch({
  maxRedirects: 0,
  maxResponseBytes: 10 * 1024 * 1024,
  timeoutMs: 30_000,
})

const res = await safeFetch('https://api.example.com/data')
// throws SsrfBlockedError if the URL resolves anywhere private
```

## What this is not

**This is a defence-in-depth layer, not a security boundary.** OWASP is explicit that address deny-lists are bypass-prone. The durable control for untrusted-URL fetching is network topology: run the fetcher in a subnet with no route to anything internal, force egress through a proxy, and require IMDSv2 with a hop limit of 1. Use this library *and* do that. If you can only do one, do the network isolation.

## Testing

The test suite is the point of this project. It runs a controlled DNS server that answers with a public address on the first query and a loopback address on the second, and asserts that the pinned connection holds. It covers every encoding above, redirect chains into private space, and IPv6 mappings.

```bash
npm test
```

## License

MIT
