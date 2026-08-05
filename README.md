# @zerorandy/vaulter

Server-side file storage library for S3-compatible providers with a private-bucket + proxy pattern. Framework-agnostic, ESM-only, TypeScript-first.

## What it does

Vaulter wraps any S3-compatible storage (Backblaze B2, Cloudflare R2, AWS S3, MinIO, Wasabi) behind a server-side proxy. The bucket stays fully private — clients never talk to S3 directly. Your database stores object keys, not URLs, so switching providers requires no data migration.

- **Bucket stays private.** Nothing in the bucket is reachable from the public internet.
- **Server is the single point of access.** All reads go through a proxy you control, where you enforce your own auth.
- **Database stores keys, not URLs.** Migrate providers without touching your data.
- **Framework-agnostic.** Works in SvelteKit, Next.js App Router, Astro, Hono, Bun, Express, or anything that speaks Web standard `Request`/`Response`.
- **Just functions.** No classes, no clients to instantiate. `upload(file, folder)` and done.
- **Intercambiable proxy.** Use the built-in proxy or point to a Cloudflare Worker for zero-egress-cost delivery with Backblaze B2.

## Installation

```bash
# From npm (once published)
npm install @zerorandy/vaulter
pnpm add @zerorandy/vaulter

# From GitHub (current)
pnpm add github:zerorandy/vaulter#v0.1.0
npm install github:zerorandy/vaulter#v0.1.0
```

Requires Node.js 18+ (or any modern runtime with Web Streams and `crypto.randomUUID`).

## Quick start

### 1. Initialize once at startup

```ts
// server entry point, hooks.server.ts, middleware.ts, etc.
import { init } from '@zerorandy/vaulter'

init({
  endpoint: process.env.B2_ENDPOINT!,
  bucket: process.env.B2_BUCKET_NAME!,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID!,
    secretAccessKey: process.env.B2_APPLICATION_KEY!,
  },
})
```

### 2. Upload files

```ts
import { upload, uploadMany } from '@zerorandy/vaulter'

// Single file — returns the key, store this in your database
const key = await upload(file, `avatars/${userId}`)
// → "avatars/abc123/1748123456789-uuid.jpg"

// Multiple files in parallel
const keys = await uploadMany(files, `gallery/${userId}`)
```

### 3. Convert keys to URLs

```ts
import { toMediaUrl } from '@zerorandy/vaulter'

const url = toMediaUrl(key)
// → "/media/avatars/abc123/1748123456789-uuid.jpg"

// Null-safe: toMediaUrl(null) → null
```

### 4. Mount the media proxy

```ts
// SvelteKit: src/routes/media/[...path]/+server.ts
import { createMediaHandler } from '@zerorandy/vaulter/handler'

export const GET = createMediaHandler({
  authorize: async (request, key) => {
    const session = await getSession(request)
    return { ok: !!session, status: session ? 200 : 401 }
  },
})
```

The handler returns a Web-standard `(Request) => Promise<Response>` function — the same code works in Next.js App Router, Astro, Hono, Bun, and Cloudflare Workers.

`authorize` also receives the object `key` (already extracted from the URL, not yet format-validated), so you can enforce per-resource access instead of just "is there a session":

```ts
authorize: async (request, key) => {
  const session = await getSession(request)
  if (!session) return { ok: false, status: 401 }
  const ownsResource = key.startsWith(`avatars/${session.userId}/`)
  return { ok: ownsResource, status: ownsResource ? 200 : 403 }
}
```

---

## External proxy (Cloudflare Worker + Backblaze B2)

Backblaze B2 and Cloudflare have a bandwidth alliance — traffic from B2 to Cloudflare is free. If you move the proxy to a Cloudflare Worker, your egress costs drop to zero.

With Vaulter you don't need to rewrite your app. Just add `proxyUrl` to your config:

```ts
init({
  endpoint: process.env.B2_ENDPOINT!,
  bucket: process.env.B2_BUCKET_NAME!,
  credentials: { ... },
  proxyUrl: 'https://media.my-worker.workers.dev',
})
```

Now `toMediaUrl(key)` returns `https://media.my-worker.workers.dev/key` automatically. Your Worker handles the S3 fetch — Vaulter handles everything else (upload, delete, queue).

For custom URL schemes (tokens, CDN prefixes), use `urlBuilder`:

```ts
import { urlBuilders, type UrlBuilder } from '@zerorandy/vaulter'

// Your own builders file
export const myBuilders = {
  ...urlBuilders,
  withToken: (base: string, key: string): string =>
    `${base}/${key}?token=${generateToken(key)}`,
}

// In init():
init({
  ...,
  proxyUrl: 'https://media.my-worker.workers.dev',
  urlBuilder: myBuilders.withToken,
})
```

---

## MIME-type validation

By default Vaulter does **not** validate `file.type` — the browser-supplied
MIME type is stored as-is as the object's `ContentType` and returned
verbatim by `download()` and the proxy handler. If your app ever renders
that content back to users, an attacker-controlled `file.type` can be a
stored-XSS vector unless you validate it yourself.

Vaulter doesn't enforce this by default (file validation is intentionally
out of scope — see the project's design principles), but you can opt in
with `allowedTypes`, globally or per call:

```ts
// Global default — applies to every upload()/uploadMany() call
init({
  ...,
  allowedTypes: ['image/png', 'image/jpeg', 'image/*'],
})

// Per-call override — replaces (not merges with) the global list
await upload(file, 'avatars', { allowedTypes: ['image/png'] })
```

Entries ending in `/*` match any subtype (`'image/*'` matches
`'image/png'`, `'image/jpeg'`, etc.); other entries must match `file.type`
exactly. When `allowedTypes` is set and `file.type` doesn't match
(including an empty `file.type`), `upload()` throws `VaulterUploadError`
before any S3 call. Leaving `allowedTypes` unset keeps the current
permissive behavior.

---

## Resilient file deletion (cleanup queue)

S3 deletes can fail (network timeout, rate limit). Vaulter includes an adapter-based cleanup queue so no file is ever permanently orphaned.

```ts
import { createCleanupQueue, createCleanupRunner } from '@zerorandy/vaulter/queue'
import { prismaAdapter } from './prisma-adapter.js'

export const cleanupQueue = createCleanupQueue({
  adapter: prismaAdapter,
  maxAttempts: 5,
})

// When a user deletes a post:
await cleanupQueue.enqueue(post.imageKey)  // register BEFORE deleting from DB
await db.post.delete({ where: { id: post.id } })

// In a cron job endpoint:
export const runCleanup = createCleanupRunner(cleanupQueue)
await runCleanup()
```

The queue is adapter-based — Vaulter has no opinion about your database. Implement the 4-method `QueueAdapter` interface for your ORM. See `examples/prisma-adapter.ts` for a complete Prisma implementation.

---

## API reference

### `@zerorandy/vaulter` (core)

| Export | Signature | Purpose |
|--------|-----------|---------|
| `init` | `(config) => void` | Register global config singleton |
| `defineConfig` | `(config) => config` | Identity helper for typed config files |
| `upload` | `(file, folder, opts?) => Promise<string>` | Upload one file, returns its key |
| `uploadMany` | `(files, folder, opts?) => Promise<string[]>` | Upload many files in parallel |
| `remove` | `(key, opts?) => Promise<void>` | Delete a file from the bucket |
| `download` | `(key, range?, opts?) => Promise<GetObjectCommandOutput>` | Fetch raw S3 object (with optional Range) |
| `toMediaUrl` | `(key) => string \| null` | Convert a key to its proxy URL |
| `urlBuilders` | `{ simple }` | Built-in URL builder catalog |
| `UrlBuilder` | type | `(base: string, key: string) => string` |

All operation functions accept an optional `opts.config` to override the singleton — useful for testing and multi-tenant setups.

### `@zerorandy/vaulter/handler`

| Export | Signature | Purpose |
|--------|-----------|---------|
| `createMediaHandler` | `({ authorize, config? }) => Handler` | Build a proxy handler for serving private files |

### `@zerorandy/vaulter/queue`

| Export | Purpose |
|--------|---------|
| `createCleanupQueue({ adapter, maxAttempts? })` | Build the enqueue interface |
| `createCleanupRunner(queue)` | Build a `() => Promise<void>` runner for cron jobs |
| `QueueAdapter` | Interface to implement for your database |
| `QueueItem` | Type returned by `adapter.pending()` |

### `@zerorandy/vaulter/errors`

All errors extend `VaulterError` — a single `instanceof VaulterError` catches anything from the library.

| Class | When it's thrown |
|-------|-----------------|
| `VaulterError` | Base class |
| `VaulterConfigError` | `init()` not called and no per-call config |
| `VaulterUploadError` | Invalid folder/type, or S3 `PutObject` failed |
| `VaulterDeleteError` | S3 `DeleteObject` failed |
| `VaulterDownloadError` | S3 `GetObject` failed (has `.status` and `.key`) |

---

## Configuration reference

```ts
init({
  // Required
  endpoint: 's3.us-east-005.backblazeb2.com',  // with or without https://
  bucket: 'my-private-bucket',
  credentials: {
    accessKeyId: 'your-key-id',
    secretAccessKey: 'your-secret-key',
  },

  // Optional
  region: 'auto',          // default 'auto' — B2 ignores it; AWS S3 needs it
  forcePathStyle: true,    // default true  — required for B2, MinIO, R2
  publicPath: '/media',    // default '/media' — mount path for createMediaHandler
  allowedTypes: ['image/png', 'image/jpeg'],  // default undefined — no restriction; see "MIME-type validation"

  // External proxy (optional)
  proxyUrl: 'https://media.my-worker.workers.dev',  // overrides publicPath in toMediaUrl
  urlBuilder: myBuilders.withToken,                  // custom URL construction
})
```

## Provider notes

| Provider | Endpoint format | `forcePathStyle` | Notes |
|----------|----------------|------------------|-------|
| Backblaze B2 | `s3.us-east-005.backblazeb2.com` | `true` | Free egress to Cloudflare |
| Cloudflare R2 | `<account_id>.r2.cloudflarestorage.com` | `true` | |
| AWS S3 | `s3.<region>.amazonaws.com` | `false` | Set `region` explicitly |
| MinIO | `<your-host>:9000` | `true` | |
| Wasabi | `s3.<region>.wasabisys.com` | `true` | |

The defaults (`region: 'auto'`, `forcePathStyle: true`) work out of the box for B2, R2, MinIO, and Wasabi.

---

## License

MIT — see [LICENSE](./LICENSE)
