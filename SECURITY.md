# Security Policy

utilscript is a security-first, client-only application: all data stays in the browser,
crypto is native WebCrypto, untrusted tools run in a null-origin sandbox, and P2P traffic
is end-to-end encrypted. We take vulnerability reports seriously.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report privately via GitHub's **Report a vulnerability** button
(Security, then Advisories, then Report a vulnerability) on this repository, or email the
maintainers at the address listed in the repository profile.

Please include:

- affected component (e.g. sandbox boundary, P2P handshake/ratchet, CSP/Trusted Types,
  at-rest store),
- a description and, if possible, a proof-of-concept,
- the browser/OS and app version/commit.

We aim to acknowledge within **72 hours** and to provide a remediation timeline after
triage. Please give us reasonable time to fix and ship before any public disclosure.

## Scope

In scope: the code in this repository and its deployed static site. Out of scope: the
third-party rendezvous infrastructure the client can use (public Nostr relays, the public
OpenRelay TURN pool). These are best-effort and untrusted by design; the app's security
does not depend on them (see `ARCHITECTURE.md`, threat model).

## Handling secrets

There are no server-side secrets in this project. Never commit tokens, private keys, or
`.env` files. The TURN credentials in `src/p2p/session.ts` are the *public* OpenRelay demo
credentials, intentionally shared and rate-limited, not a secret.
