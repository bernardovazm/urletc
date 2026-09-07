# Security Policy

urletc is client-only: all data stays in the browser, crypto is native WebCrypto,
untrusted tools run in a null-origin sandbox, and P2P traffic is end-to-end encrypted.

## Reporting a vulnerability

Do not open a public issue for a security vulnerability.

Report privately with the `Report a vulnerability` button on this repository, under
Security then Advisories, or email the maintainers at the address listed in the repository
profile.

Please include:

- affected component (e.g. sandbox boundary, P2P handshake/ratchet, CSP/Trusted Types,
  at-rest store),
- a description and, if possible, a proof-of-concept,
- the browser/OS and app version/commit.

Reports are acknowledged within 72 hours, with a remediation timeline after triage. Please
allow reasonable time for a fix to ship before any public disclosure.

## Scope

In scope: the code in this repository and its deployed static site. Out of scope: the
third-party rendezvous infrastructure the client can use (the public Nostr relays and
public STUN servers named in `src/p2p/session.ts`). These are best-effort and untrusted by
design; the app's security does not depend on them (see `ARCHITECTURE.md`, threat model).

## Handling secrets

There are no server-side secrets in this project. Never commit tokens, private keys, or
`.env` files. `src/p2p/session.ts` carries STUN servers only and `TURN_SERVERS` is empty:
the public demo TURN service it used to name stopped returning relay candidates and was
removed. Adding a TURN server means adding credentials, and any credential committed here
is public by definition.
