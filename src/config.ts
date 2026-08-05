import { VaulterConfigError } from "./errors.js";

/**
 * Función que construye la URL final del proxy a partir de una base y una key.
 *
 * - `base`: valor de `proxyUrl` si está definido, o `publicPath` en caso contrario.
 * - `key`: path del objeto en el bucket (ej. `"bitacora/abc123/foto.jpg"`).
 *
 * @example
 * // Builder con token de autenticación para un Cloudflare Worker
 * const myBuilder: UrlBuilder = (base, key) =>
 *   `${base}/${key}?token=${generateToken(key)}`;
 */
export type UrlBuilder = (base: string, key: string) => string;

/**
 * Configuración de Vaulter. Apunta a un bucket S3-compatible
 * (Backblaze B2, Cloudflare R2, AWS S3, MinIO, Wasabi, etc).
 */
export interface VaulterConfig {
  /**
   * Endpoint del proveedor S3-compatible. Acepta con o sin protocolo.
   *
   * @example "s3.us-east-005.backblazeb2.com"
   * @example "https://abc123.r2.cloudflarestorage.com"
   */
  endpoint: string;

  /** Nombre del bucket. Debe ser un bucket privado. */
  bucket: string;

  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };

  /**
   * Región del bucket. Backblaze B2 ignora este campo,
   * pero AWS S3 y otros proveedores lo requieren.
   * @default "auto"
   */
  region?: string;

  /**
   * Path-style URLs (bucket en el path) en lugar de virtual-hosted style
   * (bucket en el subdominio). Backblaze B2 y MinIO lo requieren.
   * AWS S3 acepta ambos.
   * @default true
   */
  forcePathStyle?: boolean;

  /**
   * Prefijo de URL que el proxy expone al navegador. Es la ruta donde el
   * usuario monta `createMediaHandler` en su app.
   * `toMediaUrl(key)` usa este valor como base cuando `proxyUrl` no está definido.
   * @default "/media"
   */
  publicPath?: string;

  /**
   * URL base de un proxy externo (Cloudflare Worker, CDN, etc.).
   * Cuando está definido, `toMediaUrl(key)` lo usa como base en lugar de
   * `publicPath`, y el resultado será una URL absoluta.
   *
   * @example "https://media.my-worker.workers.dev"
   */
  proxyUrl?: string;

  /**
   * Función personalizada para construir la URL final de cada key.
   * Si no se especifica, se usa el builder por defecto: `${base}/${key}`.
   *
   * Recibe la base (`proxyUrl` o `publicPath`) y la key del objeto.
   * Útil para añadir tokens, prefijos de CDN u otras transformaciones.
   *
   * @example
   * import { urlBuilders } from 'vaulter'
   * // Extender el builder simple con un token
   * urlBuilder: (base, key) => `${base}/${key}?token=${sign(key)}`
   */
  urlBuilder?: UrlBuilder;

  /**
   * Lista de MIME types permitidos para `upload()`/`uploadMany()`.
   * Si no se define, no hay restricción (comportamiento actual: `file.type`
   * se guarda tal cual, sin validar).
   *
   * Vaulter no valida el tipo de archivo por defecto — es responsabilidad
   * del usuario, ya que `file.type` es dato del cliente y se sirve de vuelta
   * sin modificar desde `download()`/el proxy. Definir `allowedTypes` es la
   * forma de optar por validación en escritura.
   *
   * Soporta wildcard de subtipo: `"image/*"` matchea cualquier `image/...`.
   * El resto de entradas deben matchear `file.type` exactamente.
   *
   * @example
   * init({ ..., allowedTypes: ["image/png", "image/jpeg", "image/*"] })
   */
  allowedTypes?: string[];
}

/**
 * Config con todos los defaults aplicados — uso interno.
 * Las propiedades opcionales del usuario aquí son obligatorias.
 */
export interface ResolvedConfig {
  endpoint: string;
  bucket: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  region: string;
  forcePathStyle: boolean;
  publicPath: string;
  proxyUrl: string | undefined;
  urlBuilder: UrlBuilder | undefined;
  allowedTypes: string[] | undefined;
}

/**
 * Helper de tipado para que el usuario obtenga autocompletado al escribir
 * su archivo `vaulter.config.ts`. No hace nada más que devolver el config.
 *
 * @example
 * ```ts
 * import { defineConfig } from 'vaulter';
 *
 * export default defineConfig({
 *   endpoint: process.env.B2_ENDPOINT!,
 *   bucket: process.env.B2_BUCKET_NAME!,
 *   credentials: {
 *     accessKeyId: process.env.B2_KEY_ID!,
 *     secretAccessKey: process.env.B2_APPLICATION_KEY!
 *   }
 * });
 * ```
 */
export function defineConfig(config: VaulterConfig): VaulterConfig {
  return config;
}

/* ------------------------------------------------------------------ */
/* Singleton interno                                                    */
/* ------------------------------------------------------------------ */

let globalConfig: ResolvedConfig | null = null;

/**
 * Inicializa Vaulter con un config global. Llamar una vez al arrancar
 * la aplicación. Las funciones posteriores (`upload`, `download`, etc.)
 * usarán este config sin necesidad de pasarlo en cada llamada.
 *
 * Llamar `init` dos veces sobreescribe el config anterior — útil para tests.
 */
export function init(config: VaulterConfig): void {
  globalConfig = applyDefaults(config);
}

/**
 * Devuelve el config con defaults aplicados.
 *
 * Si el usuario pasa un `override`, ese se usa (con sus propios defaults).
 * Si no, se devuelve el singleton inicializado con `init()`.
 *
 * Lanza `VaulterConfigError` si no hay singleton ni override.
 *
 * Uso interno — las funciones públicas de la librería llaman esto.
 */
export function resolveConfig(override?: VaulterConfig): ResolvedConfig {
  if (override) {
    return applyDefaults(override);
  }

  if (!globalConfig) {
    throw new VaulterConfigError(
      "Vaulter is not initialized. Call init(config) once when starting the app, " +
        "or pass an explicit config to the function you're calling.",
    );
  }

  return globalConfig;
}

/**
 * Solo para tests: limpia el config global.
 * No exportado en `index.ts` — uso interno y de testing.
 */
export function _resetConfig(): void {
  globalConfig = null;
}

/* ------------------------------------------------------------------ */
/* Helpers internos                                                     */
/* ------------------------------------------------------------------ */

function applyDefaults(config: VaulterConfig): ResolvedConfig {
  validateConfig(config);

  return {
    endpoint: normalizeEndpoint(config.endpoint),
    bucket: config.bucket,
    credentials: {
      accessKeyId: config.credentials.accessKeyId,
      secretAccessKey: config.credentials.secretAccessKey,
    },
    region: config.region ?? "auto",
    forcePathStyle: config.forcePathStyle ?? true,
    publicPath: normalizePublicPath(config.publicPath ?? "/media"),
    proxyUrl: config.proxyUrl
      ? normalizeProxyUrl(config.proxyUrl)
      : undefined,
    urlBuilder: config.urlBuilder,
    allowedTypes: config.allowedTypes,
  };
}

function validateConfig(config: VaulterConfig): void {
  if (!config.endpoint) {
    throw new VaulterConfigError("config.endpoint is required");
  }
  if (!config.bucket) {
    throw new VaulterConfigError("config.bucket is required");
  }
  if (!config.credentials?.accessKeyId) {
    throw new VaulterConfigError("config.credentials.accessKeyId is required");
  }
  if (!config.credentials?.secretAccessKey) {
    throw new VaulterConfigError(
      "config.credentials.secretAccessKey is required",
    );
  }
}

/**
 * El usuario puede pasar el endpoint con o sin protocolo:
 *   "s3.us-east-005.backblazeb2.com"
 *   "https://s3.us-east-005.backblazeb2.com"
 * Ambos quedan normalizados con https://.
 */
function normalizeEndpoint(endpoint: string): string {
  return endpoint.startsWith("http") ? endpoint : `https://${endpoint}`;
}

/**
 * Elimina el trailing slash de una URL externa de proxy.
 *   "https://media.worker.dev/"  → "https://media.worker.dev"
 *   "https://media.worker.dev"   → "https://media.worker.dev"
 */
function normalizeProxyUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Asegura que publicPath empiece con / y NO termine con /.
 *   "/media"   → "/media"
 *   "media"    → "/media"
 *   "/media/"  → "/media"
 *   "/files"   → "/files"
 */
function normalizePublicPath(path: string): string {
  let p = path.startsWith("/") ? path : `/${path}`;
  if (p.endsWith("/") && p.length > 1) {
    p = p.slice(0, -1);
  }
  return p;
}
