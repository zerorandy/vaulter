import { VaulterConfigError } from "./errors.js";

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
   * Prefijo de URL que el proxy expone al navegador.
   * `toMediaUrl(key)` devuelve `${publicPath}/${key}`.
   * @default "/media"
   */
  publicPath?: string;
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
      "Vaulter no está inicializado. Llama a init(config) una vez al arrancar la app, " +
        "o pasa un config explícito a la función que estás llamando.",
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
  };
}

function validateConfig(config: VaulterConfig): void {
  if (!config.endpoint) {
    throw new VaulterConfigError("config.endpoint es requerido");
  }
  if (!config.bucket) {
    throw new VaulterConfigError("config.bucket es requerido");
  }
  if (!config.credentials?.accessKeyId) {
    throw new VaulterConfigError("config.credentials.accessKeyId es requerido");
  }
  if (!config.credentials?.secretAccessKey) {
    throw new VaulterConfigError(
      "config.credentials.secretAccessKey es requerido",
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
