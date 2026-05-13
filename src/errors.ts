/**
 * Errores tipados de Vaulter.
 *
 * Todos heredan de VaulterError para que el usuario pueda hacer
 * `catch (e) { if (e instanceof VaulterError) ... }` y atrapar
 * cualquier error de la librería de una sola vez.
 */

export class VaulterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaulterError";
  }
}

/**
 * Se lanza cuando se intenta usar la librería sin haber llamado init()
 * y sin pasar config explícito en la llamada.
 */
export class VaulterConfigError extends VaulterError {
  constructor(message: string) {
    super(message);
    this.name = "VaulterConfigError";
  }
}

/**
 * Se lanza cuando una operación de subida falla en el lado de S3.
 * El error original de AWS SDK queda accesible vía `cause`.
 */
export class VaulterUploadError extends VaulterError {
  readonly key: string;

  constructor(message: string, key: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaulterUploadError";
    this.key = key;
  }
}

/**
 * Se lanza cuando una operación de borrado falla en el lado de S3.
 */
export class VaulterDeleteError extends VaulterError {
  readonly key: string;

  constructor(message: string, key: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VaulterDeleteError";
    this.key = key;
  }
}

/**
 * Se lanza cuando se intenta descargar un archivo que no existe en el bucket,
 * o cuando S3 responde con error de acceso/red.
 */
export class VaulterDownloadError extends VaulterError {
  readonly key: string;
  readonly status: number;

  constructor(
    message: string,
    key: string,
    status: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "VaulterDownloadError";
    this.key = key;
    this.status = status;
  }
}
