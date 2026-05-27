# Vaulter

Server-side file storage library for S3-compatible providers with a private-bucket + proxy pattern. Framework-agnostic, ESM-only, TypeScript-first.

> **Status:** early development (0.x). API may change before 1.0.

## What it does

Vaulter wraps any S3-compatible storage (Backblaze B2, Cloudflare R2, AWS S3, MinIO, Wasabi) behind a server-side proxy. The bucket stays fully private — clients never talk to S3 directly. Your database stores object keys, not URLs, so you can switch providers without data migration.

## Why

Most file upload libraries either expose the bucket to the public internet, require complex presigned-URL flows, or couple you to a specific framework. Vaulter takes a different approach:

- **Bucket stays private.** Nothing in the bucket is reachable from the public internet.
- **Server is the single point of access.** All reads go through a proxy you control, where you enforce your own auth.
- **Database stores keys, not URLs.** Switch from B2 to R2 without touching your data.
- **Framework-agnostic.** Works in SvelteKit, Next.js App Router, Hono, Bun, Cloudflare Workers, Express, or anything that speaks Web standard `Request`/`Response`.
- **Just functions.** No classes, no clients to instantiate. `upload(file, folder)` and done.

## Installation

```bash
npm install vaulter
# or
pnpm add vaulter
```

Requires Node.js 18+ (or any modern runtime with `fetch`, Web Streams, and `crypto.randomUUID`).

## Quick start

### 1. Create your config

```ts
// vaulter.config.ts
import { defineConfig } from 'vaulter';

export default defineConfig({
  endpoint: process.env.B2_ENDPOINT!,
  bucket: process.env.B2_BUCKET_NAME!,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID!,
    secretAccessKey: process.env.B2_APPLICATION_KEY!,
  },
});
```

### 2. Initialize once at startup

```ts
// app entry point (server.ts, hooks.server.ts, etc.)
import { init } from 'vaulter';
import config from './vaulter.config';

init(config);
```

### 3. Use it

```ts
import { upload, remove, toMediaUrl } from 'vaulter';

// Upload — returns a key, store this in your database
const key = await upload(file, `bitacora/${userId}`);
// → "bitacora/abc123/1748123456789-uuid.jpg"

// Convert key to URL for your <img> tag
const url = toMediaUrl(key);
// → "/media/bitacora/abc123/1748123456789-uuid.jpg"

// Delete when no longer needed
await remove(key);
```

### 4. Mount the media proxy

```ts
// SvelteKit: src/routes/media/[...path]/+server.ts
import { createMediaHandler } from 'vaulter/handler';

export const GET = createMediaHandler({
  authorize: async (request) => {
    const session = await getSession(request);
    return session ? { ok: true } : { ok: false, status: 401 };
  },
});
```

The handler returns a Web standard `Request → Response` function. It works the same in Next.js App Router, Hono, Bun, and Cloudflare Workers — see `examples/` for each.

## API

### `vaulter` (core)

| Export | Purpose |
|--------|---------|
| `defineConfig(config)` | Identity helper for typed config files |
| `init(config)` | Register a global config singleton |
| `upload(file, folder, opts?)` | Upload one file, returns its key |
| `uploadMany(files, folder, opts?)` | Upload many files in parallel |
| `remove(key, opts?)` | Delete a file from the bucket |
| `download(key, range?, opts?)` | Fetch a file (with optional Range header) |
| `toMediaUrl(key)` | Convert a key to a proxy URL |

All operation functions accept an optional `opts.config` to override the singleton — useful for testing and multi-tenant setups.

### `vaulter/handler`

| Export | Purpose |
|--------|---------|
| `createMediaHandler({ authorize })` | Build a Web standard request handler for serving files |

### `vaulter/queue`

The cleanup queue is adapter-based — Vaulter has no opinion about your database. You provide an implementation of `QueueAdapter` (4 methods); Vaulter handles the rest.

| Export | Purpose |
|--------|---------|
| `createCleanupQueue({ adapter, maxAttempts })` | Build the queue interface |
| `createCleanupRunner(queue)` | Build a runner for scheduled cleanup |
| `QueueAdapter` | Interface to implement for your database |
| `QueueItem` | Type returned by `adapter.pending()` |

See `examples/prisma-adapter.ts` for a reference implementation.

### `vaulter/errors`

All errors thrown by Vaulter extend `VaulterError`, so a single `instanceof VaulterError` catches anything from the library.

| Export | Use |
|--------|-----|
| `VaulterError` | Base class |
| `VaulterConfigError` | Missing or invalid config |
| `VaulterUploadError` | Upload to S3 failed |
| `VaulterDeleteError` | Delete on S3 failed |
| `VaulterDownloadError` | Download from S3 failed (includes HTTP `status`) |

## Configuration reference

```ts
defineConfig({
  // Required
  endpoint: 's3.us-east-005.backblazeb2.com',   // with or without https://
  bucket: 'my-bucket',                          // must be Private
  credentials: {
    accessKeyId: '...',
    secretAccessKey: '...',
  },

  // Optional
  region: 'auto',           // default 'auto' — B2 ignores it; S3 needs it
  forcePathStyle: true,     // default true — required for B2 and MinIO
  publicPath: '/media',     // default '/media' — prefix returned by toMediaUrl
});
```

## Provider notes

| Provider | Endpoint format | `forcePathStyle` |
|----------|----------------|------------------|
| Backblaze B2 | `s3.us-east-005.backblazeb2.com` | `true` (required) |
| Cloudflare R2 | `<account_id>.r2.cloudflarestorage.com` | `true` |
| AWS S3 | `s3.<region>.amazonaws.com` | `false` (optional) |
| MinIO | `<your-host>:9000` | `true` (required) |
| Wasabi | `s3.<region>.wasabisys.com` | `true` |

The defaults (`region: 'auto'`, `forcePathStyle: true`) work out of the box for B2, R2, MinIO, and Wasabi. AWS S3 users should set `region` explicitly.

## Design principles

1. **Private bucket only.** Vaulter assumes your bucket has no public access. If your bucket is public, Vaulter still works, but you're not getting the security benefit.
2. **Keys in the database, not URLs.** Store what Vaulter returns from `upload()`. Never store the full S3 URL.
3. **All reads through the proxy.** The browser never sees S3. Your server reads from S3 and streams to the browser.
4. **The library is silent.** No `console.log`, no telemetry, no auto-retries. If something fails, you get a typed error to handle.

See [`docs/origin-architecture.md`](./docs/origin-architecture.md) for the original design that inspired Vaulter, including security layering, the cleanup queue pattern, and detailed reasoning behind these decisions.

## Status & roadmap

- [x] Core API design
- [ ] `src/client.ts`, `src/storage.ts`
- [ ] `src/handler.ts` with Range request support
- [ ] `src/queue.ts` with adapter pattern
- [ ] Reference adapter for Prisma
- [ ] Framework example handlers
- [ ] First publish to npm

## License

MIT
