import { describe, it, expect } from "vitest";
import {
  VaulterError,
  VaulterConfigError,
  VaulterUploadError,
  VaulterDeleteError,
  VaulterDownloadError,
} from "../src/errors.js";

describe("VaulterError", () => {
  it("es instancia de Error", () => {
    expect(new VaulterError("msg")).toBeInstanceOf(Error);
  });

  it("name es VaulterError", () => {
    expect(new VaulterError("msg").name).toBe("VaulterError");
  });

  it("message se asigna correctamente", () => {
    expect(new VaulterError("algo salió mal").message).toBe("algo salió mal");
  });
});

describe("VaulterConfigError", () => {
  it("es instancia de VaulterError", () => {
    expect(new VaulterConfigError("msg")).toBeInstanceOf(VaulterError);
  });

  it("name es VaulterConfigError", () => {
    expect(new VaulterConfigError("msg").name).toBe("VaulterConfigError");
  });
});

describe("VaulterUploadError", () => {
  it("es instancia de VaulterError", () => {
    expect(new VaulterUploadError("msg", "key.jpg")).toBeInstanceOf(VaulterError);
  });

  it("name es VaulterUploadError", () => {
    expect(new VaulterUploadError("msg", "key.jpg").name).toBe("VaulterUploadError");
  });

  it(".key tiene el valor correcto", () => {
    expect(new VaulterUploadError("msg", "folder/key.jpg").key).toBe("folder/key.jpg");
  });

  it("propaga cause al error original", () => {
    const cause = new Error("S3 original");
    const err = new VaulterUploadError("msg", "key.jpg", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("VaulterDeleteError", () => {
  it("es instancia de VaulterError", () => {
    expect(new VaulterDeleteError("msg", "key.jpg")).toBeInstanceOf(VaulterError);
  });

  it("name es VaulterDeleteError", () => {
    expect(new VaulterDeleteError("msg", "key.jpg").name).toBe("VaulterDeleteError");
  });

  it(".key tiene el valor correcto", () => {
    expect(new VaulterDeleteError("msg", "folder/key.jpg").key).toBe("folder/key.jpg");
  });

  it("propaga cause al error original", () => {
    const cause = new Error("S3 original");
    const err = new VaulterDeleteError("msg", "key.jpg", { cause });
    expect(err.cause).toBe(cause);
  });
});

describe("VaulterDownloadError", () => {
  it("es instancia de VaulterError", () => {
    expect(new VaulterDownloadError("msg", "key.jpg", 404)).toBeInstanceOf(VaulterError);
  });

  it("name es VaulterDownloadError", () => {
    expect(new VaulterDownloadError("msg", "key.jpg", 404).name).toBe("VaulterDownloadError");
  });

  it(".key tiene el valor correcto", () => {
    expect(new VaulterDownloadError("msg", "folder/key.jpg", 404).key).toBe("folder/key.jpg");
  });

  it(".status tiene el valor correcto", () => {
    expect(new VaulterDownloadError("msg", "key.jpg", 503).status).toBe(503);
  });

  it("propaga cause al error original", () => {
    const cause = new Error("S3 original");
    const err = new VaulterDownloadError("msg", "key.jpg", 500, { cause });
    expect(err.cause).toBe(cause);
  });
});
