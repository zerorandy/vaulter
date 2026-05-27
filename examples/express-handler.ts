/**
 * Ejemplo: proxy de media en Express
 *
 * Si usas un proxy externo (proxyUrl en tu config), no necesitas esta ruta.
 */

import { createMediaHandler } from "vaulter/handler";
// import express from 'express'
// import { init } from 'vaulter'
//
// init({
//   endpoint: process.env.B2_ENDPOINT!,
//   bucket: process.env.B2_BUCKET_NAME!,
//   credentials: {
//     accessKeyId: process.env.B2_KEY_ID!,
//     secretAccessKey: process.env.B2_APPLICATION_KEY!,
//   },
// })
//
// const app = express()

const handler = createMediaHandler({
  authorize: async (request) => {
    // Con express-session o passport, la sesión viene en la cookie.
    // Para adaptar un Request Express a Web Request, usa el adaptador
    // de tu framework o verifica el header directamente:
    const cookie = request.headers.get("cookie") ?? "";
    const hasSession = cookie.includes("connect.sid=");
    return { ok: hasSession, status: hasSession ? 200 : 401 };
  },
});

// Express no usa Web Request/Response nativamente.
// Usa un adaptador o Node.js >=18 con el flag --experimental-fetch:
//
// app.get('/media/*', async (req, res) => {
//   const webReq = new Request(
//     `http://localhost${req.url}`,
//     { headers: Object.entries(req.headers).flatMap(([k, v]) =>
//         Array.isArray(v) ? v.map(val => [k, val]) : [[k, String(v ?? '')]]
//     )}
//   )
//   const webRes = await handler(webReq)
//   res.status(webRes.status)
//   webRes.headers.forEach((val, key) => res.setHeader(key, val))
//   const body = await webRes.arrayBuffer()
//   res.send(Buffer.from(body))
// })

export { handler };
