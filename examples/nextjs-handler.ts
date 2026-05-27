/**
 * Ejemplo: proxy de media en Next.js App Router
 *
 * Crea el archivo en:
 *   app/media/[...path]/route.ts
 *
 * Si usas un proxy externo (proxyUrl en tu config), no necesitas este
 * archivo — el tráfico va directo al Worker/CDN.
 */

import { createMediaHandler } from "vaulter/handler";
// import { getServerSession } from 'next-auth'   // o tu librería de auth
// import { init } from 'vaulter'
//
// Inicializa en lib/vaulter.ts (importado en tu root layout o en un Server Component):
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
    // Con next-auth:
    // const session = await getServerSession()
    // return { ok: !!session, status: session ? 200 : 401 }

    // Con JWT en Authorization header:
    const auth = request.headers.get("authorization");
    const ok = !!auth?.startsWith("Bearer ");
    return { ok, status: ok ? 200 : 401 };
  },
});

export const GET = handler;
