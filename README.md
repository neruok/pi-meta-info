# pi-meta-info

A Pi extension package for cross-session file memory: file-scoped notes with a
SHA-256 status.

The extension registers one `meta` tool over the pure core in
`lib/meta/index.ts`. The core imports no Pi API and no model, so every behavior
is checked with plain Node.

Notes are untrusted reference data entering model context. `FRESH` validates a
file-byte observation, not note truth or dependencies. `meta` hashes file bytes
locally and never sends subject contents to the model. Model-visible content is
bounded; complete selected records remain in tool `details`, which Pi uses for
rendering and state, not as model-visible tool text.

This repository is the standalone home of the `meta` extension, extracted from
the `new-coder` Pi profile.

## Install

```sh
pi install npm:@neruok/pi-meta-info
```

This installs the package and activates the extension and its skill in Pi. For
development, you can instead run `npm install` and add the package to a profile
`packages` list as `npm:@neruok/pi-meta-info`.

## Layout

| Path | Purpose |
| --- | --- |
| `meta.ts` | The Pi extension: one `meta` tool. |
| `lib/meta/index.ts` | The pure core: config, index, path containment, the five actions, rendering. |
| `scripts/check-meta.mjs` | Pure-core acceptance checks, without Pi and without a model. |
| `scripts/check-meta-extension.mjs` | Tool registration and boundary checks against the installed Pi runtime. |
| `skills/meta-memory/SKILL.md` | Skill: when and how to record and reuse file memory with the `meta` tool. |
| `.github/workflows/verify.yml` | CI: type check and both acceptance suites. |

## Verify

```sh
npm ci
npm install --global @earendil-works/pi-coding-agent@0.87.1
npm run verify
```

`npm run verify` runs the TypeScript check over `lib/meta/` and both acceptance
suites. The extension check resolves `@earendil-works/pi-coding-agent` from the
global `npm root -g` unless you pass the Pi package directory as its first
argument. It requires Node with TypeScript type stripping (Node 24 needs no
flag).

CI runs these steps on pushes to `main` and on pull requests.

The source of intent is the specification stored in the maintainer workspace's
documentation store (document `pi-meta-info`).
