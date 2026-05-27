import { S3Client } from "@aws-sdk/client-s3";
import type { ResolvedConfig } from "./config.js";

/**
 * Crea un S3Client configurado para el proveedor del usuario.
 * Uso interno — nunca exportado desde index.ts.
 */
export function createS3Client(config: ResolvedConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.credentials.accessKeyId,
      secretAccessKey: config.credentials.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });
}
