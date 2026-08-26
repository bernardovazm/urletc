# Contributing

## Prerequisites

Node 20.19 or newer, plus Python 3.10 or newer for the end to end tests only. Install from
the committed lockfile with `npm ci`; use `npm install` only when changing dependencies.

## Before opening a pull request

Run the full set. CI runs the same on every push and pull request.

```bash
npm run typecheck && npm run lint && npm run format:check && npm run build && npm run e2e
```

`npm run e2e` creates a Python virtualenv at `.venv-e2e/` on first run and installs
Playwright with Chromium. It builds, boots `vite preview` on port 5199 under the production
CSP, runs the console suite against it, then tears down. `E2E_NO_SERVER=1` with `E2E_BASE`
targets an already-running instance.

Headless Chromium cannot cover heavy WebAssembly or WebRTC, so these stay manual: model
loading, clipboard auto read, live caption accuracy, real cameras and microphones, and two
browsers connecting to each other.

## Conventions

- TypeScript strict with `verbatimModuleSyntax`, so use `import type`.
- Prefer `Uint8Array<ArrayBuffer>` for crypto buffers.
- DOM is built with the `el()` and `button()` helpers in `src/shell/ui.ts`. No framework.
- No `innerHTML` from strings and no inline styles. Style with a class in
  `src/styles/tokens.css`; per-property CSSOM setters are fine.
- A tool module is cached per URL and shared across every card that mounts it, so keep
  per-instance state in a container-keyed `WeakMap`, never in module-level variables.
- Keep functions small. Comment where the intent is not obvious, which in practice means
  security rationale.

## Security invariants

Before changing the shell, P2P, workshop or crypto layers, read the invariants in
[`ARCHITECTURE.md`](./ARCHITECTURE.md) section 9.1 and state in your pull request how the
change affects them. ESLint enforces some; the rest are review-gated.

Report vulnerabilities privately through [`SECURITY.md`](./SECURITY.md), never a public
issue.

## Conduct

Harassment is not welcome in issues or reviews and will be removed.
