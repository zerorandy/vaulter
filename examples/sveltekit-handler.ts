/**
 * Ejemplo: proxy de media en SvelteKit
 *
 * Crea el archivo en:
 *   src/routes/media/[...path]/+server.ts
 *
 * Si usas un proxy externo (proxyUrl en tu config), no necesitas este
 * archivo — el tráfico va directo al Worker/CDN y nunca pasa por tu app.
 */

import { createMediaHandler } from "@zerorandy/vaulter/handler";
// import type { RequestHandler } from './$types'
// import { init } from '@zerorandy/vaulter'
//
// Inicializa una vez en hooks.server.ts o en tu primer load server-side:
// init({
//   endpoint: process.env.B2_ENDPOINT!,
//   bucket: process.env.B2_BUCKET_NAME!,
//   credentials: {
//     accessKeyId: process.env.B2_KEY_ID!,
//     secretAccessKey: process.env.B2_APPLICATION_KEY!,
//   },
// })

const handler = createMediaHandler({
  authorize: async (request) => {
    // SvelteKit no expone `locals` en el Request estándar.
    // La forma idiomática es envolver el handler en un RequestHandler:
    //
    // export const GET: RequestHandler = async ({ request, locals }) => {
    //   if (!locals.user) return new Response('Unauthorized', { status: 401 })
    //   return handler(request)
    // }
    //
    // Si tu app usa JWT o cookies en el header, puedes verificarlo aquí:
    const cookie = request.headers.get("cookie") ?? "";
    const hasSession = cookie.includes("session="); // simplificado
    return { ok: hasSession, status: hasSession ? 200 : 401 };
  },
});

// export const GET: RequestHandler = ({ request }) => handler(request)
export { handler };
