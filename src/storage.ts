import {
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { resolveConfig } from "./config.js";
import type { VaulterConfig, UrlBuilder } from "./config.js";
import { createS3Client } from "./client.js";
import {
  VaulterUploadError,
  VaulterDeleteError,
  VaulterDownloadError,
} from "./errors.js";

/* ------------------------------------------------------------------ */
/* Catálogo de builders                                                 */
/* ------------------------------------------------------------------ */

/**
 * Builders de URL incluidos en Vaulter. Úsalos directamente o como base
 * para crear los tuyos en tu propio proyecto.
 *
 * @example
 * import { urlBuilders, type UrlBuilder } from 'vaulter'
 *
 * export const myBuilders = {
 *   ...urlBuilders,
 *   withToken: (base, key): string => `${base}/${key}?t=${sign(key)}`,
 * }
 */
export const urlBuilders = {
  /**
   * Concatena base y key con `/`. Comportamiento por defecto de `toMediaUrl`.
   */
  simple: (base: string, key: string): string => `${base}/${key}`,
} satisfies Record<string, UrlBuilder>;

/* ------------------------------------------------------------------ */
/* Validaciones internas                                               */
/* ------------------------------------------------------------------ */

const VALID_FOLDER_RE = /^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/;

function assertValidFolder(folder: string): void {
  if (!VALID_FOLDER_RE.test(folder)) {
    throw new VaulterUploadError(
      `Invalid folder "${folder}": use only [a-zA-Z0-9_-] segments separated by "/"`,
      folder,
    );
  }
}

/* ------------------------------------------------------------------ */
/* upload                                                               */
/* ------------------------------------------------------------------ */

/**
 * Sube un archivo al bucket y devuelve su key.
 * La key sigue el patrón `{folder}/{timestamp}-{uuid}.{ext}`.
 *
 * @example
 * const key = await upload(file, `avatars/${userId}`)
 * // → "avatars/abc123/1748123456789-550e8400.jpg"
 */
export async function upload(
  file: File,
  folder: string,
  opts?: { config?: VaulterConfig },
): Promise<string> {
  assertValidFolder(folder);
  const config = resolveConfig(opts?.config);
  const s3 = createS3Client(config);

  const timestamp = Date.now();
  const dotIndex = file.name.lastIndexOf(".");
  const ext = dotIndex >= 0 ? file.name.slice(dotIndex + 1) : "bin";
  const key = `${folder}/${timestamp}-${crypto.randomUUID()}.${ext}`;

  const buffer = await file.arrayBuffer();

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: Buffer.from(buffer),
        ContentType: file.type || "application/octet-stream",
      }),
    );
  } catch (err) {
    throw new VaulterUploadError(
      `Failed to upload "${key}"`,
      key,
      { cause: err },
    );
  }

  return key;
}

/* ------------------------------------------------------------------ */
/* uploadMany                                                           */
/* ------------------------------------------------------------------ */

/**
 * Sube múltiples archivos en paralelo y devuelve sus keys en el mismo orden.
 *
 * @example
 * const keys = await uploadMany(files, `bitacora/${userId}`)
 */
export async function uploadMany(
  files: File[],
  folder: string,
  opts?: { config?: VaulterConfig },
): Promise<string[]> {
  return Promise.all(files.map((f) => upload(f, folder, opts)));
}

/* ------------------------------------------------------------------ */
/* remove                                                               */
/* ------------------------------------------------------------------ */

/**
 * Elimina un objeto del bucket por su key.
 *
 * @example
 * await remove("avatars/abc123/1748123456789-uuid.jpg")
 */
export async function remove(
  key: string,
  opts?: { config?: VaulterConfig },
): Promise<void> {
  const config = resolveConfig(opts?.config);
  const s3 = createS3Client(config);

  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: config.bucket,
        Key: key,
      }),
    );
  } catch (err) {
    throw new VaulterDeleteError(
      `Failed to delete "${key}"`,
      key,
      { cause: err },
    );
  }
}

/* ------------------------------------------------------------------ */
/* download                                                             */
/* ------------------------------------------------------------------ */

/**
 * Descarga un objeto del bucket. Acepta el header `Range` para soportar
 * seeking en videos (respuestas 206 Partial Content).
 *
 * @param key   - Key del objeto en el bucket.
 * @param range - Header Range opcional, ej. `"bytes=0-1048576"`.
 *
 * @example
 * const obj = await download("bitacora/abc123/video.mp4", "bytes=0-")
 * // obj.Body es un ReadableStream
 */
export async function download(
  key: string,
  range?: string,
  opts?: { config?: VaulterConfig },
): Promise<GetObjectCommandOutput> {
  const config = resolveConfig(opts?.config);
  const s3 = createS3Client(config);

  try {
    return await s3.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Range: range,
      }),
    );
  } catch (err) {
    const status =
      (err as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode ?? 500;
    throw new VaulterDownloadError(
      `Failed to download "${key}"`,
      key,
      status,
      { cause: err },
    );
  }
}

/* ------------------------------------------------------------------ */
/* toMediaUrl                                                           */
/* ------------------------------------------------------------------ */

/**
 * Convierte una key del bucket en la URL que el navegador debe usar para
 * acceder al archivo.
 *
 * Orden de resolución:
 * 1. Si `key` empieza con `http`, se devuelve sin modificar (URL legacy).
 * 2. La base es `config.proxyUrl` si está definido, o `config.publicPath`.
 * 3. La URL final la construye `config.urlBuilder` si existe, o el builder
 *    por defecto: `${base}/${key}`.
 *
 * @example
 * // Proxy interno (publicPath = "/media"):
 * toMediaUrl("bitacora/abc123/foto.jpg")
 * // → "/media/bitacora/abc123/foto.jpg"
 *
 * // Proxy externo (proxyUrl = "https://media.worker.dev"):
 * toMediaUrl("bitacora/abc123/foto.jpg")
 * // → "https://media.worker.dev/bitacora/abc123/foto.jpg"
 *
 * // Key nula o vacía:
 * toMediaUrl(null)  // → null
 */
export function toMediaUrl(
  key: string | null | undefined,
  opts?: { config?: VaulterConfig },
): string | null {
  if (!key) return null;
  if (key.startsWith("http")) return key;

  const config = resolveConfig(opts?.config);
  const base = config.proxyUrl ?? config.publicPath;
  const builder = config.urlBuilder ?? urlBuilders.simple;

  return builder(base, key);
}
