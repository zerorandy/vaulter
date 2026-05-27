import { resolveConfig } from "./config.js";
import type { VaulterConfig } from "./config.js";
import { download } from "./storage.js";
import { VaulterDownloadError } from "./errors.js";

/**
 * Resultado que `authorize` debe devolver para cada request al proxy.
 *
 * - `ok: true`  — el request está autorizado, continuar con la descarga.
 * - `ok: false` — denegar. `status` permite distinguir 401 (sin sesión)
 *                 de 403 (sesión válida pero sin permiso).
 */
export interface AuthorizeResult {
  ok: boolean;
  status?: number;
}

/**
 * Opciones para `createMediaHandler`.
 */
export interface MediaHandlerOptions {
  /**
   * Función que recibe el `Request` entrante y decide si está autorizado.
   * Aquí es donde el usuario verifica sesión, JWT, API key, etc.
   *
   * @example
   * authorize: async (req) => {
   *   const session = await getSession(req)
   *   return { ok: !!session, status: session ? 200 : 401 }
   * }
   */
  authorize: (request: Request) => Promise<AuthorizeResult>;

  /**
   * Callback invocado cuando el handler captura un error interno (descarga
   * fallida, error de S3, etc.). Úsalo para registrar el error con tu propio
   * logger. El cliente siempre recibe una respuesta genérica (500 o 404);
   * este callback es el único punto donde puedes acceder al error original.
   *
   * El error es una instancia de `VaulterDownloadError` cuando viene de S3,
   * con las propiedades `key`, `status` y `cause` (el error original del SDK).
   *
   * @example
   * onError: (err, req) => {
   *   logger.error({ err, url: req.url }, "vaulter media error")
   * }
   */
  onError?: (err: unknown, request: Request) => void;

  /** Config explícito. Si se omite, usa el singleton de `init()`. */
  config?: VaulterConfig;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

/**
 * Crea un handler HTTP que actúa como proxy privado para los archivos del
 * bucket. El handler:
 *
 * 1. Llama a `authorize(request)` — si falla, responde 401/403.
 * 2. Extrae la key del path de la URL.
 * 3. Descarga el objeto desde S3 con soporte de Range requests.
 * 4. Transmite la respuesta al cliente con los headers correctos.
 *
 * Devuelve una función `(request: Request) => Promise<Response>` compatible
 * con SvelteKit, Next.js App Router, Astro, Hono, Bun y Cloudflare Workers.
 *
 * Usa `onError` para observar errores internos sin exponerlos al cliente:
 *
 * @example
 * import { createMediaHandler } from 'vaulter/handler'
 *
 * const handler = createMediaHandler({
 *   authorize: async (req) => ({ ok: !!getSession(req) }),
 *   onError: (err, req) => logger.error({ err, url: req.url }, "media error"),
 * })
 * export const GET = handler
 */
export function createMediaHandler(
  opts: MediaHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const config = resolveConfig(opts.config);

    const auth = await opts.authorize(request);
    if (!auth.ok) {
      return new Response("Unauthorized", {
        status: auth.status ?? 401,
        headers: SECURITY_HEADERS,
      });
    }

    // Extraer la key: todo lo que va después de publicPath + "/"
    // Ej: pathname = "/media/bitacora/abc/foto.jpg", publicPath = "/media"
    // → key = "bitacora/abc/foto.jpg"
    const { pathname } = new URL(request.url);
    const prefix = config.publicPath + "/";
    const key = pathname.startsWith(prefix)
      ? pathname.slice(prefix.length)
      : pathname.slice(1);

    if (!key) {
      return new Response("Not Found", { status: 404, headers: SECURITY_HEADERS });
    }
    if (key.includes("..") || key.startsWith("/")) {
      return new Response("Bad Request", { status: 400, headers: SECURITY_HEADERS });
    }

    const range = request.headers.get("Range") ?? undefined;

    try {
      const obj = await download(
        key,
        range,
        opts.config !== undefined ? { config: opts.config } : undefined,
      );

      const headers: Record<string, string> = {
        "Content-Type": obj.ContentType ?? "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
        ...SECURITY_HEADERS,
      };

      if (obj.ContentLength) {
        headers["Content-Length"] = String(obj.ContentLength);
      }
      if (obj.ContentRange) {
        headers["Content-Range"] = obj.ContentRange;
      }
      if (range) {
        headers["Accept-Ranges"] = "bytes";
      }

      return new Response(obj.Body as ReadableStream, {
        status: range ? 206 : 200,
        headers,
      });
    } catch (err) {
      try { opts.onError?.(err, request); } catch { /* el caller es responsable de que su callback no lance */ }
      if (err instanceof VaulterDownloadError && err.status === 404) {
        return new Response("Not Found", { status: 404, headers: SECURITY_HEADERS });
      }
      return new Response("Internal Server Error", { status: 500, headers: SECURITY_HEADERS });
    }
  };
}
