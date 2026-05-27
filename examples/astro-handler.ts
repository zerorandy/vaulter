/**
 * Ejemplo: proxy de media en Astro (SSR)
 *
 * Crea el archivo en:
 *   src/pages/media/[...path].ts
 *
 * Requiere output: 'server' o 'hybrid' en astro.config.mjs.
 *
 * Si usas un proxy externo (proxyUrl en tu config), no necesitas este
 * archivo — el tráfico va directo al Worker/CDN.
 */

import { createMediaHandler } from "vaulter/handler";
// import type { APIRoute } from 'astro'
// import { init } from 'vaulter'
//
// Inicializa en src/lib/vaulter.ts (importado desde un middleware o un endpoint):
// init({
//   endpoint: import.meta.env.B2_ENDPOINT,
//   bucket: import.meta.env.B2_BUCKET_NAME,
//   credentials: {
//     accessKeyId: import.meta.env.B2_KEY_ID,
//     secretAccessKey: import.meta.env.B2_APPLICATION_KEY,
//   },
// })

const handler = createMediaHandler({
  authorize: async (request) => {
    // Astro expone Astro.locals en los APIRoute, pero el Request estándar
    // solo tiene headers. Verifica sesión desde cookies o Authorization:
    //
    // const session = await getSession(request)   // tu helper de auth
    // return { ok: !!session, status: session ? 200 : 401 }

    const cookie = request.headers.get("cookie") ?? "";
    const hasSession = cookie.includes("session=");
    return { ok: hasSession, status: hasSession ? 200 : 401 };
  },
});

// export const GET: APIRoute = ({ request }) => handler(request)
export { handler };
