Estado actual de Vaulter
  
  ¿Qué es? Una librería npm para almacenamiento de archivos en el servidor, agnóstica de framework, usando el patrón private
   bucket + server proxy. Extraída de conquify-social (SvelteKit + Backblaze B2 en producción).

  Archivos finalizados y aprobados:
  - package.json — ESM-only, exports correctos (., ./handler, ./queue, ./errors), deps en orden.
  - tsconfig.json — NodeNext, verbatimModuleSyntax, strict mode completo.
  - src/errors.ts — 5 clases: VaulterError, VaulterConfigError, VaulterUploadError, VaulterDeleteError,
  VaulterDownloadError.
  - src/config.ts — defineConfig, init, resolveConfig, _resetConfig, con singleton, defaults y normalización de
  endpoint/publicPath. ADICIÓN APROBADA: VaulterConfig y ResolvedConfig incluyen dos campos nuevos:
  proxyUrl?: string y urlBuilder?: UrlBuilder (sin defaults, se pasan tal cual en applyDefaults).
  
  Todavía por implementar (en orden de dependencia):

  ┌─────┬────────────────────────────┬────────────────────────────────────────────────────────────────────┐
  │  #  │          Archivo           │                              Qué hace                              │
  ├─────┼────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 1   │ src/client.ts              │ Fábrica interna de S3Client (nunca exportado)                      │
  ├─────┼────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 2   │ src/storage.ts             │ upload, uploadMany, remove, download, toMediaUrl, urlBuilders      │
  ├─────┼────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 3   │ src/handler.ts             │ createMediaHandler({ authorize }) → (Request) => Promise<Response> │
  ├─────┼────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 4   │ src/queue.ts               │ createCleanupQueue, createCleanupRunner, QueueAdapter, QueueItem   │
  ├─────┼────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 5   │ src/index.ts               │ Re-exports reales (actualmente solo tiene un placeholder)          │
  ├─────┼────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 6   │ examples/prisma-adapter.ts │ Implementación de referencia del QueueAdapter                      │
  ├─────┼────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 7   │ examples/*.ts              │ Handlers para SvelteKit, Next.js, Astro, Express                   │
  ├─────┼────────────────────────────┼────────────────────────────────────────────────────────────────────┤
  │ 8   │ README.md                  │ Documentación pública                                              │
  └─────┴────────────────────────────┴────────────────────────────────────────────────────────────────────┘

  Principios clave que debo respetar: sin CommonJS, sin clases en la API pública, imports con .js, import type para tipos,
  errores siempre con clases Vaulter*, sin console.log, JSDoc en todo lo exportado.

  ¿Quieres que empiece a implementar desde src/client.ts?
