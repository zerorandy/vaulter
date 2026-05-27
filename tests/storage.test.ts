import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { init, _resetConfig } from "../src/config.js";
import {
  VaulterUploadError,
  VaulterDeleteError,
  VaulterDownloadError,
} from "../src/errors.js";

// Mock del cliente S3 — intercepta createS3Client antes de importar storage
const mockSend = vi.fn();
vi.mock("../src/client.js", () => ({
  createS3Client: () => ({ send: mockSend }),
}));

// Importar storage DESPUÉS del mock
const { upload, uploadMany, remove, download, toMediaUrl, urlBuilders } =
  await import("../src/storage.js");

const BASE = {
  endpoint: "s3.us-east-005.backblazeb2.com",
  bucket: "test-bucket",
  credentials: { accessKeyId: "key-id", secretAccessKey: "secret" },
};

beforeEach(() => {
  _resetConfig();
  init(BASE);
  mockSend.mockReset();
});

afterEach(() => {
  _resetConfig();
});

// ─── urlBuilders ──────────────────────────────────────────────────────────────

describe("urlBuilders.simple", () => {
  it("concatena base y key con /", () => {
    expect(urlBuilders.simple("/media", "folder/file.jpg")).toBe(
      "/media/folder/file.jpg",
    );
  });

  it("funciona con URL absoluta como base", () => {
    expect(urlBuilders.simple("https://cdn.example.com", "img/photo.jpg")).toBe(
      "https://cdn.example.com/img/photo.jpg",
    );
  });
});

// ─── toMediaUrl ───────────────────────────────────────────────────────────────

describe("toMediaUrl", () => {
  it("devuelve null para null", () => {
    expect(toMediaUrl(null)).toBeNull();
  });

  it("devuelve null para undefined", () => {
    expect(toMediaUrl(undefined)).toBeNull();
  });

  it("devuelve null para string vacío", () => {
    expect(toMediaUrl("")).toBeNull();
  });

  it("devuelve la URL https:// sin modificar (legacy passthrough)", () => {
    const legacy = "https://cdn.uploadthing.com/file/abc123.jpg";
    expect(toMediaUrl(legacy)).toBe(legacy);
  });

  it("devuelve la URL http:// sin modificar (legacy passthrough)", () => {
    const legacy = "http://localhost:8080/uploads/file.jpg";
    expect(toMediaUrl(legacy)).toBe(legacy);
  });

  it("construye /publicPath/key con config por defecto", () => {
    expect(toMediaUrl("bitacora/abc123/foto.jpg")).toBe(
      "/media/bitacora/abc123/foto.jpg",
    );
  });

  it("usa proxyUrl como base cuando está definido", () => {
    _resetConfig();
    init({ ...BASE, proxyUrl: "https://media.worker.dev" });
    expect(toMediaUrl("bitacora/abc123/foto.jpg")).toBe(
      "https://media.worker.dev/bitacora/abc123/foto.jpg",
    );
  });

  it("usa urlBuilder personalizado cuando está definido", () => {
    const customBuilder = vi.fn(
      (base: string, key: string) => `${base}/v2/${key}`,
    );
    _resetConfig();
    init({ ...BASE, urlBuilder: customBuilder });
    const result = toMediaUrl("folder/file.jpg");
    expect(customBuilder).toHaveBeenCalledWith("/media", "folder/file.jpg");
    expect(result).toBe("/media/v2/folder/file.jpg");
  });

  it("proxyUrl tiene prioridad sobre publicPath en el builder", () => {
    const customBuilder = vi.fn((base: string, key: string) => `${base}/${key}`);
    _resetConfig();
    init({
      ...BASE,
      publicPath: "/local",
      proxyUrl: "https://cdn.example.com",
      urlBuilder: customBuilder,
    });
    toMediaUrl("file.jpg");
    expect(customBuilder).toHaveBeenCalledWith("https://cdn.example.com", "file.jpg");
  });
});

// ─── upload ───────────────────────────────────────────────────────────────────

describe("upload", () => {
  it("la key devuelta empieza con el folder dado", async () => {
    mockSend.mockResolvedValue({});
    const file = new File(["contenido"], "foto.jpg", { type: "image/jpeg" });
    const key = await upload(file, "bitacora/abc123");
    expect(key.startsWith("bitacora/abc123/")).toBe(true);
  });

  it("la key tiene la extensión correcta del archivo", async () => {
    mockSend.mockResolvedValue({});
    const file = new File(["data"], "video.mp4", { type: "video/mp4" });
    const key = await upload(file, "videos");
    expect(key.endsWith(".mp4")).toBe(true);
  });

  it("usa bin como extensión si el nombre no tiene punto", async () => {
    mockSend.mockResolvedValue({});
    const file = new File(["data"], "sinextension", { type: "" });
    const key = await upload(file, "misc");
    expect(key.endsWith(".bin")).toBe(true);
  });

  it("envía PutObjectCommand con Bucket, Key y ContentType correctos", async () => {
    mockSend.mockResolvedValue({});
    const file = new File(["img"], "avatar.png", { type: "image/png" });
    const key = await upload(file, "avatars");

    const [command] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input["Bucket"]).toBe("test-bucket");
    expect(command.input["Key"]).toBe(key);
    expect(command.input["ContentType"]).toBe("image/png");
  });

  it("usa application/octet-stream si el file no tiene type", async () => {
    mockSend.mockResolvedValue({});
    const file = new File(["data"], "archivo.bin", { type: "" });
    await upload(file, "docs");

    const [command] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input["ContentType"]).toBe("application/octet-stream");
  });

  it("lanza VaulterUploadError cuando S3 falla", async () => {
    mockSend.mockRejectedValue(new Error("S3 error"));
    const file = new File(["data"], "foto.jpg", { type: "image/jpeg" });
    await expect(upload(file, "folder")).rejects.toBeInstanceOf(VaulterUploadError);
  });

  it("VaulterUploadError.key coincide con la key generada", async () => {
    mockSend.mockRejectedValue(new Error("S3 error"));
    const file = new File(["data"], "foto.jpg", { type: "image/jpeg" });
    try {
      await upload(file, "folder");
    } catch (err) {
      expect(err).toBeInstanceOf(VaulterUploadError);
      expect((err as VaulterUploadError).key.startsWith("folder/")).toBe(true);
    }
  });
});

// ─── uploadMany ───────────────────────────────────────────────────────────────

describe("uploadMany", () => {
  it("devuelve un array de keys en el mismo orden", async () => {
    mockSend.mockResolvedValue({});
    const files = [
      new File(["a"], "a.jpg", { type: "image/jpeg" }),
      new File(["b"], "b.png", { type: "image/png" }),
    ];
    const keys = await uploadMany(files, "gallery");
    expect(keys).toHaveLength(2);
    expect(keys[0]!.endsWith(".jpg")).toBe(true);
    expect(keys[1]!.endsWith(".png")).toBe(true);
  });
});

// ─── remove ───────────────────────────────────────────────────────────────────

describe("remove", () => {
  it("envía DeleteObjectCommand con Bucket y Key correctos", async () => {
    mockSend.mockResolvedValue({});
    await remove("bitacora/abc123/foto.jpg");

    const [command] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input["Bucket"]).toBe("test-bucket");
    expect(command.input["Key"]).toBe("bitacora/abc123/foto.jpg");
  });

  it("lanza VaulterDeleteError cuando S3 falla", async () => {
    mockSend.mockRejectedValue(new Error("S3 error"));
    await expect(remove("some/key.jpg")).rejects.toBeInstanceOf(VaulterDeleteError);
  });

  it("VaulterDeleteError.key coincide con la key pasada", async () => {
    mockSend.mockRejectedValue(new Error("S3 error"));
    try {
      await remove("folder/file.jpg");
    } catch (err) {
      expect((err as VaulterDeleteError).key).toBe("folder/file.jpg");
    }
  });
});

// ─── download ─────────────────────────────────────────────────────────────────

describe("download", () => {
  it("envía GetObjectCommand con Bucket y Key correctos", async () => {
    mockSend.mockResolvedValue({ ContentType: "image/jpeg" });
    await download("bitacora/abc123/foto.jpg");

    const [command] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input["Bucket"]).toBe("test-bucket");
    expect(command.input["Key"]).toBe("bitacora/abc123/foto.jpg");
  });

  it("pasa el header Range cuando se provee", async () => {
    mockSend.mockResolvedValue({ ContentType: "video/mp4" });
    await download("video.mp4", "bytes=0-1048576");

    const [command] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input["Range"]).toBe("bytes=0-1048576");
  });

  it("no envía Range cuando es undefined", async () => {
    mockSend.mockResolvedValue({ ContentType: "image/jpeg" });
    await download("foto.jpg");

    const [command] = mockSend.mock.calls[0] as [{ input: Record<string, unknown> }];
    expect(command.input["Range"]).toBeUndefined();
  });

  it("lanza VaulterDownloadError cuando S3 falla", async () => {
    mockSend.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });
    await expect(download("missing.jpg")).rejects.toBeInstanceOf(
      VaulterDownloadError,
    );
  });

  it("VaulterDownloadError.status viene de $metadata.httpStatusCode", async () => {
    mockSend.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });
    try {
      await download("missing.jpg");
    } catch (err) {
      expect((err as VaulterDownloadError).status).toBe(404);
    }
  });

  it("VaulterDownloadError.status es 500 cuando no hay $metadata", async () => {
    mockSend.mockRejectedValue(new Error("red caída"));
    try {
      await download("file.jpg");
    } catch (err) {
      expect((err as VaulterDownloadError).status).toBe(500);
    }
  });
});
