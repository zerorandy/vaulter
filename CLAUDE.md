# CLAUDE.md

This file is the persistent context for Claude Code when working on Vaulter.
Read this fully before making any changes.

---

## What Vaulter is

Vaulter is an npm library for server-side, framework-agnostic file storage on
any S3-compatible provider (Backblaze B2, Cloudflare R2, AWS S3, MinIO, Wasabi).

The core pattern: **private bucket + server proxy**. The bucket is never
publicly accessible; all media is served through a proxy endpoint that the
user mounts in their framework. The database stores object keys, never URLs.

Origin: extracted from a SvelteKit + Backblaze B2 production codebase. The
original implementation lives in `docs/origin-architecture.md` — read it for
context on why the design is the way it is.

---

## Design principles (non-negotiable)

1. **Framework-agnostic.** The library never imports from SvelteKit, Next,
   Express, etc. The HTTP handler uses Web standard `Request`/`Response`.

2. **Function-call DX.** No classes for the public API. The user calls
   `upload(file, folder)`, not `new VaulterClient().upload(...)`.

3. **ESM-only.** `"type": "module"` in package.json. No CommonJS build.
   No `require()`. Imports use explicit `.js` extensions (NodeNext resolution).

4. **TypeScript source, JS + .d.ts published.** Users get full type
   information without needing TypeScript in their project.

5. **S3-compatible only.** The library doesn't try to abstract over
   non-S3 backends. It uses `@aws-sdk/client-s3` and exposes S3 semantics.

6. **Errors in English, JSDoc/comments in Spanish OK.** Public-facing
   strings (error messages, README) are English. Internal comments can
   be Spanish — the maintainer's working language.

7. **Adapter pattern for the cleanup queue.** Vaulter does NOT depend on
   Prisma, Drizzle, or any database. The user implements a 4-method
   `QueueAdapter` interface. Example adapter for Prisma lives in `examples/`.

---

## Public API surface

```ts
// Core (from 'vaulter')
init(config)                    // register global config singleton
defineConfig(config)            // identity helper for user's vaulter.config.ts
upload(file, folder, opts?)     // returns key
uploadMany(files, folder, opts?) // returns key[]
remove(key, opts?)
download(key, range?, opts?)    // returns S3 GetObjectCommandOutput
toMediaUrl(key)                 // returns string | null
UrlBuilder                      // type: (proxyUrl: string, key: string) => string
urlBuilders                     // built-in catalog: { simple }

// Handler (from 'vaulter/handler')
createMediaHandler({ authorize })  // returns (request: Request) => Promise<Response>

// Queue (from 'vaulter/queue')
createCleanupQueue({ adapter, maxAttempts })
createCleanupRunner(queue)
QueueAdapter         // interface user implements
QueueItem            // type returned by adapter

// Errors (from 'vaulter/errors')
VaulterError
VaulterConfigError
VaulterUploadError
VaulterDeleteError
VaulterDownloadError
```

All functions accept an optional `opts.config` to override the singleton —
needed for testing and multi-tenant scenarios.

---

## Project structure

vaulter/
├── CLAUDE.md
├── README.md
├── LICENSE
├── package.json
├── tsconfig.json
├── .gitignore
├── .npmignore
│
├── src/
│   ├── index.ts        # re-exports public API for the '.' entrypoint
│   ├── config.ts       # defineConfig, init, resolveConfig, types
│   ├── client.ts       # internal S3Client factory (NOT exported)
│   ├── storage.ts      # upload, uploadMany, remove, download, toMediaUrl
│   ├── handler.ts      # createMediaHandler
│   ├── queue.ts        # createCleanupQueue, createCleanupRunner, adapter types
│   └── errors.ts       # error classes
│
├── docs/
│   └── origin-architecture.md  # the SvelteKit + B2 source design doc
│
└── examples/
├── prisma-adapter.ts        # reference QueueAdapter implementation
├── sveltekit-handler.ts
├── nextjs-handler.ts
├── astro-handler.ts
└── express-handler.ts

**`src/` is flat by design.** For a library of ~7 files, nested folders add
noise without value.

**`client.ts` is internal.** Not re-exported from `index.ts`. The user never
touches `S3Client` directly — that breaks the "just call functions" principle.

---

## Locked-in technical decisions

These were debated and resolved in the planning phase. Do not relitigate
without explicit user request.

| Decision | Choice | Why |
|----------|--------|-----|
| Provider scope | Any S3-compatible | B2 alone is too narrow; SDK already supports all |
| Queue handling | Adapter pattern | Avoids coupling to any ORM |
| HTTP handler | Web standard Request/Response | Works in SvelteKit, Next, Hono, Bun, Workers |
| Module format | ESM only | Modern runtimes all support it |
| Config loading | Explicit object passed to init() | No magic file discovery; predictable |
| Config strategy | Singleton + per-call override | Easy default, flexible when needed |
| Public API language | English function names | npm convention |
| `fetch` naming | Renamed to `download` | Avoids shadowing global fetch |
| `publicPath` | Configurable, defaults `/media` | Mount path for the internal proxy handler |
| `proxyUrl` in config | Optional `string`; if set, `toMediaUrl` uses it as base instead of `publicPath` | Enables external proxies (CF Worker, CDN) without changing app code |
| `urlBuilder` in config | Optional `UrlBuilder` fn; defaults to simple concat | Allows custom URL schemes (tokens, CDN prefixes, etc.) when `proxyUrl` alone isn't enough |
| `authorize` return | `{ ok: boolean, status?: number }` | Distinguishes 401 vs 403 |
| QueueAdapter methods | 4: insert, pending, remove, markAttempt | Minimal but complete |
| S3 client config | `forcePathStyle: true`, `region: 'auto'` defaults | Required for B2, harmless elsewhere |
| Node version | >=18 | Needs native fetch, Web Streams, crypto.randomUUID |

---

## Proxy URL strategy

`toMediaUrl(key)` is the single point that converts a bucket key into a URL
the browser can request. Its behavior depends on two optional config fields:

- `proxyUrl` — the **where**: full base URL of an external proxy
  (e.g. `"https://media.my-worker.workers.dev"`).
- `urlBuilder` — the **how**: a function `(base, key) => string` that
  constructs the final URL from the base and the key.

Resolution order inside `toMediaUrl`:

```
1. Determine base:  config.proxyUrl ?? config.publicPath
2. Build URL:       config.urlBuilder?.(base, key) ?? `${base}/${key}`
3. Legacy passthrough: if key starts with "http", return key unchanged
```

`publicPath` stays relevant even when `proxyUrl` is set — it is the path where
`createMediaHandler` is mounted in the user's app. The two fields are
independent: `publicPath` = server route, `proxyUrl` = client-facing URL.

### Built-in catalog (`urlBuilders`)

Vaulter exports a `urlBuilders` object with ready-to-use strategies:

```ts
import { urlBuilders } from 'vaulter'

urlBuilders.simple   // (base, key) => `${base}/${key}`  — the default
```

Users extend the catalog **in their own project** — never by mutating the
exported object from vaulter:

```ts
// src/media-builders.ts  (user's file)
import { urlBuilders, type UrlBuilder } from 'vaulter'

export const myBuilders = {
  ...urlBuilders,
  cloudflareAuth: (base: string, key: string): string =>
    `${base}/${key}?token=${sign(key)}`,
}

// src/server.ts
import { init } from 'vaulter'
import { myBuilders } from './media-builders.js'

init({
  endpoint, bucket, credentials,
  proxyUrl: 'https://media.my-worker.workers.dev',
  urlBuilder: myBuilders.cloudflareAuth,
})
```

---

## Finalized code (do not regenerate without permission)

`package.json`, `tsconfig.json`, and `src/errors.ts` are fully designed and
approved. Implement them verbatim.

`src/config.ts` is approved **with the following additions** — include them
when implementing:
- `VaulterConfig` gets two new optional fields: `proxyUrl?: string` and
  `urlBuilder?: UrlBuilder`.
- `ResolvedConfig` gets the same two fields, but typed as
  `proxyUrl: string | undefined` and `urlBuilder: UrlBuilder | undefined`
  (no defaults — `undefined` is the valid "not set" state).
- `applyDefaults` passes them through without transformation (no normalization
  needed; `normalizeEndpoint`-style handling is not required here).

Files still to implement, in dependency order:
1. `src/client.ts`
2. `src/storage.ts`
3. `src/handler.ts`
4. `src/queue.ts`
5. `src/index.ts`
6. `examples/prisma-adapter.ts`
7. Framework example handlers
8. `README.md`

---

## Coding conventions

- **Imports use `.js` extensions** (NodeNext requires this even for .ts files):
  `import { foo } from './bar.js'` — never `'./bar'`.
- **Use `import type` for type-only imports.** `verbatimModuleSyntax` is on.
- **No default exports** except where required (`defineConfig` and the user's
  config file). Named exports everywhere else.
- **Errors thrown by the library must be Vaulter\* classes**, not plain `Error`.
  Wrap AWS SDK errors with `{ cause: originalError }`.
- **No console.log in library code.** If something needs to be logged,
  it's the user's responsibility (let them catch and log themselves).
- **JSDoc on every exported function and type.** This is what users see in
  their editor's hover tooltips.

---

## Things Claude should NOT do

- Do not add CommonJS support.
- Do not add a CLI tool. Vaulter is a library, not an app.
- Do not add framework-specific helpers in `src/`. Examples for frameworks
  live in `examples/` only.
- Do not add Prisma/Drizzle/any ORM as a dependency. The queue is adapter-based.
- Do not add a logger dependency. The library is silent.
- Do not auto-load `vaulter.config.ts`. The user passes config explicitly.
- Do not add file upload size limits, MIME type validation, or image
  processing. Those are the user's responsibility — Vaulter only moves bytes.
- Do not change error messages from English without asking.
- Do not introduce abstractions for "future flexibility". YAGNI.

---

## When unsure

- Read `docs/origin-architecture.md` for the design intent.
- Match the patterns of already-implemented files (`errors.ts`, `config.ts`).
- Ask the user before introducing a new dependency, a new exported function,
  or a new subpath in `package.json` exports.

## First draft implementation

 - Verify /Users/zerorandy/Desarrollo/conquify/conquify-social to see if there is existing code with good behavior. This was the project where the idea of creating a library like Vaulter started, so you will see a real or the first 'draft Vaulter library' running in a real-life project.
