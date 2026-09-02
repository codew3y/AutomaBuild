# Security policy

## Reporting a vulnerability

Please report security issues **privately**, through GitHub's private vulnerability reporting: open the [Security tab](https://github.com/codew3y/automa-safe-fetch/security) and choose *Report a vulnerability*. That opens a channel visible only to the maintainers.

Please do not open a public issue for a suspected bypass.

I will acknowledge a report within 7 days. This is a personal project, not a funded one — there is no bug bounty, and no guaranteed remediation window beyond a good-faith effort.

## What counts as a vulnerability here

A bypass. Concretely: any input that causes `automa-safe-fetch` to open a connection to an address in the blocked ranges, when that address was not explicitly permitted via `allowedRanges`. Examples of what I want to hear about:

- An address encoding the parser normalises differently from the operating system's resolver
- A path where the connected address differs from the validated one — anything that reopens the DNS-rebinding window
- A redirect, or a chain of them, that reaches a blocked address
- A parser disagreement: `url.ts` accepting a host that the HTTP stack then interprets as a different host

If you have a bypass, the most useful report is a failing test case in the shape of the ones in `test/bypass-corpus.test.ts`.

## What does not count

Some things are refused on purpose, and are documented in the README:

- **The deny-list is not exhaustive, and cannot be.** OWASP is explicit that address deny-lists are bypass-prone. This library is a defence-in-depth layer, not a security boundary. A range that is reachable but not on the list is a gap worth reporting; the existence of gaps is not itself the finding.
- **`allowedRanges` reaching a private address.** That option exists to do exactly that, and it is checked first.
- **Decompression bombs.** Explicitly out of scope. The size cap counts bytes on the wire, and the client requests `identity` encoding so that number means something. Overriding `accept-encoding` moves that risk to the caller.
- **Anything requiring control of the calling application's configuration.** If an attacker can set `blockedRanges`, they have already won by another route.
- **SSRF that the network would have prevented.** Not a defence this library claims to provide — see below.

## A note on threat model

The durable control for fetching untrusted URLs is network topology: run the fetcher where there is nothing internal to reach, force egress through a proxy that revalidates from a position where "internal" means nothing, and require IMDSv2 with a hop limit of 1.

This library is the layer you add *on top of* that, for the case where a bug lets something through anyway. If you are relying on it as your only control, the most valuable security work available to you is not reading this file — it is changing that.

## Supported versions

The latest published minor version. Given the project's stage, fixes go to `main` and a new release; there is no backporting.
