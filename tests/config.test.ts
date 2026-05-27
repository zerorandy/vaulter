import { describe, it, expect, beforeEach } from "vitest";
import {
  init,
  resolveConfig,
  defineConfig,
  _resetConfig,
} from "../src/config.js";
import { VaulterConfigError } from "../src/errors.js";

const BASE = {
  endpoint: "s3.us-east-005.backblazeb2.com",
  bucket: "my-bucket",
  credentials: { accessKeyId: "key-id", secretAccessKey: "secret" },
};

beforeEach(() => {
  _resetConfig();
});

// ─── resolveConfig ────────────────────────────────────────────────────────────

describe("resolveConfig", () => {
  it("lanza VaulterConfigError si no hay init() ni override", () => {
    expect(() => resolveConfig()).toThrowError(VaulterConfigError);
  });

  it("devuelve el singleton tras init()", () => {
    init(BASE);
    const config = resolveConfig();
    expect(config.bucket).toBe("my-bucket");
  });

  it("override tiene prioridad sobre el singleton", () => {
    init(BASE);
    const config = resolveConfig({ ...BASE, bucket: "otro-bucket" });
    expect(config.bucket).toBe("otro-bucket");
  });

  it("_resetConfig limpia el singleton", () => {
    init(BASE);
    _resetConfig();
    expect(() => resolveConfig()).toThrowError(VaulterConfigError);
  });

  it("init() llamado dos veces sobrescribe el primero", () => {
    init(BASE);
    init({ ...BASE, bucket: "segundo-bucket" });
    expect(resolveConfig().bucket).toBe("segundo-bucket");
  });

  it("override en resolveConfig no contamina el singleton", () => {
    init(BASE);
    resolveConfig({ ...BASE, bucket: "override-bucket" });
    expect(resolveConfig().bucket).toBe("my-bucket");
  });
});

// ─── defineConfig ─────────────────────────────────────────────────────────────

describe("defineConfig", () => {
  it("devuelve el mismo objeto sin modificaciones", () => {
    const result = defineConfig(BASE);
    expect(result).toBe(BASE);
  });
});

// ─── normalizeEndpoint ────────────────────────────────────────────────────────

describe("normalizeEndpoint", () => {
  it("añade https:// si el endpoint no tiene protocolo", () => {
    init({ ...BASE, endpoint: "s3.us-east-005.backblazeb2.com" });
    expect(resolveConfig().endpoint).toBe(
      "https://s3.us-east-005.backblazeb2.com",
    );
  });

  it("respeta https:// si ya está presente", () => {
    init({ ...BASE, endpoint: "https://s3.us-east-005.backblazeb2.com" });
    expect(resolveConfig().endpoint).toBe(
      "https://s3.us-east-005.backblazeb2.com",
    );
  });

  it("respeta http:// (entornos locales sin TLS)", () => {
    init({ ...BASE, endpoint: "http://localhost:9000" });
    expect(resolveConfig().endpoint).toBe("http://localhost:9000");
  });
});

// ─── normalizePublicPath ──────────────────────────────────────────────────────

describe("normalizePublicPath", () => {
  it("default es /media", () => {
    init(BASE);
    expect(resolveConfig().publicPath).toBe("/media");
  });

  it("añade / inicial si falta", () => {
    init({ ...BASE, publicPath: "files" });
    expect(resolveConfig().publicPath).toBe("/files");
  });

  it("elimina / al final", () => {
    init({ ...BASE, publicPath: "/media/" });
    expect(resolveConfig().publicPath).toBe("/media");
  });

  it("acepta rutas personalizadas", () => {
    init({ ...BASE, publicPath: "/static/media" });
    expect(resolveConfig().publicPath).toBe("/static/media");
  });
});

// ─── normalizeProxyUrl ────────────────────────────────────────────────────────

describe("normalizeProxyUrl", () => {
  it("elimina / al final de proxyUrl", () => {
    init({ ...BASE, proxyUrl: "https://media.worker.dev/" });
    expect(resolveConfig().proxyUrl).toBe("https://media.worker.dev");
  });

  it("deja proxyUrl sin cambios si no tiene / al final", () => {
    init({ ...BASE, proxyUrl: "https://media.worker.dev" });
    expect(resolveConfig().proxyUrl).toBe("https://media.worker.dev");
  });

  it("proxyUrl es undefined cuando no se define", () => {
    init(BASE);
    expect(resolveConfig().proxyUrl).toBeUndefined();
  });
});

// ─── validateConfig ───────────────────────────────────────────────────────────

describe("validateConfig", () => {
  it("lanza si falta endpoint", () => {
    expect(() => init({ ...BASE, endpoint: "" })).toThrowError(
      VaulterConfigError,
    );
  });

  it("lanza si falta bucket", () => {
    expect(() => init({ ...BASE, bucket: "" })).toThrowError(VaulterConfigError);
  });

  it("lanza si falta accessKeyId", () => {
    expect(() =>
      init({ ...BASE, credentials: { ...BASE.credentials, accessKeyId: "" } }),
    ).toThrowError(VaulterConfigError);
  });

  it("lanza si falta secretAccessKey", () => {
    expect(() =>
      init({
        ...BASE,
        credentials: { ...BASE.credentials, secretAccessKey: "" },
      }),
    ).toThrowError(VaulterConfigError);
  });
});

// ─── defaults ─────────────────────────────────────────────────────────────────

describe("defaults", () => {
  it("region por defecto es auto", () => {
    init(BASE);
    expect(resolveConfig().region).toBe("auto");
  });

  it("forcePathStyle por defecto es true", () => {
    init(BASE);
    expect(resolveConfig().forcePathStyle).toBe(true);
  });

  it("respeta region explícita", () => {
    init({ ...BASE, region: "us-east-1" });
    expect(resolveConfig().region).toBe("us-east-1");
  });

  it("respeta forcePathStyle: false", () => {
    init({ ...BASE, forcePathStyle: false });
    expect(resolveConfig().forcePathStyle).toBe(false);
  });

  it("urlBuilder es undefined cuando no se define", () => {
    init(BASE);
    expect(resolveConfig().urlBuilder).toBeUndefined();
  });
});
