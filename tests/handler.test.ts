import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { init, _resetConfig } from "../src/config.js";
import { VaulterDownloadError } from "../src/errors.js";

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
});
