import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { init, _resetConfig } from "../src/config.js";
import { VaulterDownloadError } from "../src/errors.js";
// VaulterConfigError se importa solo para verificar el tipo en el test de config faltante

// Mock selectivo: solo download se reemplaza, el resto del módulo permanece real
const mockDownload = vi.fn();
vi.mock("../src/storage.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/storage.js")>();
  return { ...original, download: mockDownload };
});

const { createMediaHandler } = await import("../src/handler.js");

const BASE = {
  endpoint: "s3.us-east-005.backblazeb2.com",
  bucket: "test-bucket",
  credentials: { accessKeyId: "key-id", secretAccessKey: "secret" },
};

const ALLOW = async () => ({ ok: true as const });
const DENY  = async () => ({ ok: false as const });

function makeRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, { headers });
}

beforeEach(() => {
  _resetConfig();
  init(BASE);
  mockDownload.mockReset();
});

afterEach(() => {
  _resetConfig();
});

// ─── authorize ────────────────────────────────────────────────────────────────

describe("authorize", () => {
  it("devuelve 401 cuando authorize retorna {ok: false}", async () => {
    const handler = createMediaHandler({ authorize: DENY });
    const res = await handler(makeRequest("/media/folder/file.jpg"));
    expect(res.status).toBe(401);
  });

  it("devuelve 403 cuando authorize retorna {ok: false, status: 403}", async () => {
    const handler = createMediaHandler({
      authorize: async () => ({ ok: false, status: 403 }),
    });
    const res = await handler(makeRequest("/media/folder/file.jpg"));
    expect(res.status).toBe(403);
  });

  it("usa 401 como status por defecto al denegar sin status explícito", async () => {
    const handler = createMediaHandler({
      authorize: async () => ({ ok: false }),
    });
    const res = await handler(makeRequest("/media/file.jpg"));
    expect(res.status).toBe(401);
  });
});

// ─── extracción de key ────────────────────────────────────────────────────────

describe("extracción de key", () => {
  it("devuelve 404 cuando la URL no tiene key después del prefix", async () => {
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/"));
    expect(res.status).toBe(404);
  });

  it("extrae la key correctamente de /media/folder/file.jpg", async () => {
    mockDownload.mockResolvedValue({
      Body: new ReadableStream(),
      ContentType: "image/jpeg",
    });
    const handler = createMediaHandler({ authorize: ALLOW });
    await handler(makeRequest("/media/bitacora/abc123/foto.jpg"));

    const [calledKey] = mockDownload.mock.calls[0] as [string];
    expect(calledKey).toBe("bitacora/abc123/foto.jpg");
  });

  it("funciona con publicPath personalizado", async () => {
    _resetConfig();
    init({ ...BASE, publicPath: "/files" });
    mockDownload.mockResolvedValue({
      Body: new ReadableStream(),
      ContentType: "application/pdf",
    });
    const handler = createMediaHandler({ authorize: ALLOW });
    await handler(makeRequest("/files/docs/report.pdf"));

    const [calledKey] = mockDownload.mock.calls[0] as [string];
    expect(calledKey).toBe("docs/report.pdf");
  });
});

// ─── respuesta exitosa ────────────────────────────────────────────────────────

describe("respuesta exitosa", () => {
  beforeEach(() => {
    mockDownload.mockResolvedValue({
      Body: new ReadableStream(),
      ContentType: "image/jpeg",
      ContentLength: 12345,
    });
  });

  it("devuelve status 200", async () => {
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/foto.jpg"));
    expect(res.status).toBe(200);
  });

  it("incluye Content-Type del objeto S3", async () => {
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/foto.jpg"));
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("incluye Cache-Control: private, max-age=3600", async () => {
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/foto.jpg"));
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
  });

  it("incluye Content-Length cuando S3 lo provee", async () => {
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/foto.jpg"));
    expect(res.headers.get("Content-Length")).toBe("12345");
  });

  it("usa application/octet-stream si S3 no provee ContentType", async () => {
    mockDownload.mockResolvedValue({ Body: new ReadableStream() });
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/foto.jpg"));
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("no incluye Content-Length cuando S3 no lo provee", async () => {
    mockDownload.mockResolvedValue({ Body: new ReadableStream(), ContentType: "image/jpeg" });
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/foto.jpg"));
    expect(res.headers.get("Content-Length")).toBeNull();
  });
});

// ─── Range requests ───────────────────────────────────────────────────────────

describe("Range requests", () => {
  beforeEach(() => {
    mockDownload.mockResolvedValue({
      Body: new ReadableStream(),
      ContentType: "video/mp4",
      ContentRange: "bytes 0-1048576/10485760",
    });
  });

  it("devuelve 206 cuando el request tiene header Range", async () => {
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(
      makeRequest("/media/video.mp4", { Range: "bytes=0-1048576" }),
    );
    expect(res.status).toBe(206);
  });

  it("incluye Accept-Ranges: bytes", async () => {
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(
      makeRequest("/media/video.mp4", { Range: "bytes=0-" }),
    );
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
  });

  it("incluye Content-Range cuando S3 lo provee", async () => {
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(
      makeRequest("/media/video.mp4", { Range: "bytes=0-1048576" }),
    );
    expect(res.headers.get("Content-Range")).toBe("bytes 0-1048576/10485760");
  });

  it("pasa el Range a download()", async () => {
    const handler = createMediaHandler({ authorize: ALLOW });
    await handler(makeRequest("/media/video.mp4", { Range: "bytes=0-65536" }));
    const [, passedRange] = mockDownload.mock.calls[0] as [string, string];
    expect(passedRange).toBe("bytes=0-65536");
  });

  it("no incluye Content-Range cuando S3 no lo provee", async () => {
    mockDownload.mockResolvedValue({ Body: new ReadableStream(), ContentType: "video/mp4" });
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/video.mp4", { Range: "bytes=0-" }));
    expect(res.headers.get("Content-Range")).toBeNull();
  });
});

// ─── manejo de errores ────────────────────────────────────────────────────────

describe("errores", () => {
  it("devuelve 404 cuando download lanza VaulterDownloadError con status 404", async () => {
    mockDownload.mockRejectedValue(
      new VaulterDownloadError("Not found", "key.jpg", 404),
    );
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/key.jpg"));
    expect(res.status).toBe(404);
  });

  it("devuelve 500 para cualquier otro error", async () => {
    mockDownload.mockRejectedValue(new Error("error inesperado"));
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/key.jpg"));
    expect(res.status).toBe(500);
  });

  it("devuelve 500 para VaulterDownloadError con status != 404", async () => {
    mockDownload.mockRejectedValue(
      new VaulterDownloadError("Server error", "key.jpg", 503),
    );
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/key.jpg"));
    expect(res.status).toBe(500);
  });

  it("rechaza con VaulterConfigError si init() no fue llamado y no hay config", async () => {
    _resetConfig();
    const handler = createMediaHandler({ authorize: ALLOW });
    await expect(handler(makeRequest("/media/key.jpg"))).rejects.toThrow();
  });
});

// ─── onError ──────────────────────────────────────────────────────────────────

describe("onError", () => {
  it("invoca onError cuando download lanza un error", async () => {
    const originalErr = new Error("S3 caído");
    mockDownload.mockRejectedValue(originalErr);
    const onError = vi.fn();
    const handler = createMediaHandler({ authorize: ALLOW, onError });
    await handler(makeRequest("/media/foto.jpg"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(originalErr, expect.any(Request));
  });

  it("invoca onError con el Request original", async () => {
    mockDownload.mockRejectedValue(new Error("fallo"));
    const onError = vi.fn();
    const handler = createMediaHandler({ authorize: ALLOW, onError });
    const req = makeRequest("/media/foto.jpg");
    await handler(req);
    const [, passedRequest] = onError.mock.calls[0] as [unknown, Request];
    expect(passedRequest.url).toBe(req.url);
  });

  it("sigue devolviendo 500 aunque onError lance una excepción", async () => {
    mockDownload.mockRejectedValue(new Error("fallo"));
    const handler = createMediaHandler({
      authorize: ALLOW,
      onError: () => { throw new Error("logger caído"); },
    });
    const res = await handler(makeRequest("/media/foto.jpg"));
    expect(res.status).toBe(500);
  });

  it("no invoca onError cuando authorize deniega", async () => {
    const onError = vi.fn();
    const handler = createMediaHandler({ authorize: DENY, onError });
    await handler(makeRequest("/media/foto.jpg"));
    expect(onError).not.toHaveBeenCalled();
  });

  it("no invoca onError en respuestas exitosas", async () => {
    mockDownload.mockResolvedValue({ Body: new ReadableStream(), ContentType: "image/jpeg" });
    const onError = vi.fn();
    const handler = createMediaHandler({ authorize: ALLOW, onError });
    await handler(makeRequest("/media/foto.jpg"));
    expect(onError).not.toHaveBeenCalled();
  });

  it("no invoca onError cuando VaulterDownloadError tiene status 404", async () => {
    mockDownload.mockRejectedValue(
      new VaulterDownloadError("Not found", "key.jpg", 404),
    );
    const onError = vi.fn();
    const handler = createMediaHandler({ authorize: ALLOW, onError });
    await handler(makeRequest("/media/key.jpg"));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("funciona sin onError (el campo es opcional)", async () => {
    mockDownload.mockRejectedValue(new Error("fallo"));
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/foto.jpg"));
    expect(res.status).toBe(500);
  });
});

// ─── validación de extensión ──────────────────────────────────────────────────

describe("validación de extensión", () => {
  it("devuelve 400 cuando la key no tiene extensión de archivo (segmento simple)", async () => {
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/club-logos"));
    expect(res.status).toBe(400);
  });

  it("devuelve 400 cuando la key no tiene extensión de archivo (path anidado)", async () => {
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/avatars/userId"));
    expect(res.status).toBe(400);
  });

  it("no bloquea una key con extensión válida", async () => {
    mockDownload.mockResolvedValue({ Body: new ReadableStream(), ContentType: "image/jpeg" });
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/avatars/user/foto.jpg"));
    expect(res.status).toBe(200);
  });
});

// ─── headers de seguridad ─────────────────────────────────────────────────────

describe("headers de seguridad", () => {
  it("respuesta 200 incluye X-Content-Type-Options: nosniff", async () => {
    mockDownload.mockResolvedValue({ Body: new ReadableStream(), ContentType: "image/jpeg" });
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/foto.jpg"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("respuesta 200 incluye X-Frame-Options: DENY", async () => {
    mockDownload.mockResolvedValue({ Body: new ReadableStream(), ContentType: "image/jpeg" });
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/foto.jpg"));
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("respuesta 206 (Range) incluye X-Content-Type-Options: nosniff", async () => {
    mockDownload.mockResolvedValue({ Body: new ReadableStream(), ContentType: "video/mp4" });
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/video.mp4", { Range: "bytes=0-" }));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("respuesta 401 incluye X-Content-Type-Options: nosniff", async () => {
    const handler = createMediaHandler({ authorize: DENY });
    const res = await handler(makeRequest("/media/foto.jpg"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("respuesta 401 incluye X-Frame-Options: DENY", async () => {
    const handler = createMediaHandler({ authorize: DENY });
    const res = await handler(makeRequest("/media/foto.jpg"));
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("respuesta 404 de S3 incluye X-Content-Type-Options: nosniff", async () => {
    mockDownload.mockRejectedValue(
      new VaulterDownloadError("Not found", "key.jpg", 404),
    );
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/key.jpg"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("respuesta 500 incluye X-Content-Type-Options: nosniff", async () => {
    mockDownload.mockRejectedValue(new Error("error inesperado"));
    const handler = createMediaHandler({ authorize: ALLOW });
    const res = await handler(makeRequest("/media/key.jpg"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
