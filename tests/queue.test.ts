import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { init, _resetConfig } from "../src/config.js";
import type { QueueAdapter, QueueItem } from "../src/queue.js";
import { VaulterQueueError } from "../src/errors.js";

// Mock selectivo: solo remove se reemplaza
const mockRemove = vi.fn();
vi.mock("../src/storage.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/storage.js")>();
  return { ...original, remove: mockRemove };
});

const { createCleanupQueue, createCleanupRunner } = await import(
  "../src/queue.js"
);

const BASE = {
  endpoint: "s3.us-east-005.backblazeb2.com",
  bucket: "test-bucket",
  credentials: { accessKeyId: "key-id", secretAccessKey: "secret" },
};

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: crypto.randomUUID(),
    key: "folder/file.jpg",
    attempts: 0,
    lastTriedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<QueueAdapter> = {}): QueueAdapter {
  return {
    insert: vi.fn(),
    pending: vi.fn().mockResolvedValue([]),
    remove: vi.fn(),
    markAttempt: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  _resetConfig();
  init(BASE);
  mockRemove.mockReset();
});

afterEach(() => {
  _resetConfig();
});

// ─── createCleanupQueue ───────────────────────────────────────────────────────

describe("createCleanupQueue", () => {
  it("enqueue llama adapter.insert con la key correcta", async () => {
    const adapter = makeAdapter();
    const queue = createCleanupQueue({ adapter });
    await queue.enqueue("bitacora/abc123/foto.jpg");
    expect(adapter.insert).toHaveBeenCalledWith("bitacora/abc123/foto.jpg");
  });

  it("enqueue llama adapter.insert exactamente una vez", async () => {
    const adapter = makeAdapter();
    const queue = createCleanupQueue({ adapter });
    await queue.enqueue("some/key.jpg");
    expect(adapter.insert).toHaveBeenCalledTimes(1);
  });

  it("múltiples llamadas a enqueue son independientes", async () => {
    const adapter = makeAdapter();
    const queue = createCleanupQueue({ adapter });
    await queue.enqueue("key1.jpg");
    await queue.enqueue("key2.jpg");
    await queue.enqueue("key3.jpg");
    expect(adapter.insert).toHaveBeenCalledTimes(3);
    expect(adapter.insert).toHaveBeenNthCalledWith(1, "key1.jpg");
    expect(adapter.insert).toHaveBeenNthCalledWith(2, "key2.jpg");
    expect(adapter.insert).toHaveBeenNthCalledWith(3, "key3.jpg");
  });
});

// ─── createCleanupRunner — guard ──────────────────────────────────────────────

describe("createCleanupRunner — guard", () => {
  it("lanza si la queue no fue creada por createCleanupQueue", () => {
    const fakeQueue = { enqueue: async () => {} };
    expect(() => createCleanupRunner(fakeQueue)).toThrow(VaulterQueueError);
  });
});

// ─── runner — flujo exitoso ───────────────────────────────────────────────────

describe("runner — flujo exitoso", () => {
  it("llama adapter.pending con maxAttempts correcto", async () => {
    const adapter = makeAdapter();
    const queue = createCleanupQueue({ adapter, maxAttempts: 3 });
    const run = createCleanupRunner(queue);
    await run();
    expect(adapter.pending).toHaveBeenCalledWith(3);
  });

  it("maxAttempts por defecto es 5", async () => {
    const adapter = makeAdapter();
    const queue = createCleanupQueue({ adapter });
    const run = createCleanupRunner(queue);
    await run();
    expect(adapter.pending).toHaveBeenCalledWith(5);
  });

  it("llama remove(item.key) para cada item pendiente", async () => {
    const item = makeItem({ key: "folder/foto.jpg" });
    const adapter = makeAdapter({
      pending: vi.fn().mockResolvedValue([item]),
    });
    mockRemove.mockResolvedValue(undefined);

    const queue = createCleanupQueue({ adapter });
    const run = createCleanupRunner(queue);
    await run();

    expect(mockRemove).toHaveBeenCalledWith("folder/foto.jpg", undefined);
  });

  it("el config explícito llega a remove()", async () => {
    const explicitConfig = { ...BASE, bucket: "otro-bucket" };
    const item = makeItem({ key: "folder/foto.jpg" });
    const adapter = makeAdapter({
      pending: vi.fn().mockResolvedValue([item]),
    });
    mockRemove.mockResolvedValue(undefined);

    const queue = createCleanupQueue({ adapter, config: explicitConfig });
    const run = createCleanupRunner(queue);
    await run();

    expect(mockRemove).toHaveBeenCalledWith("folder/foto.jpg", {
      config: explicitConfig,
    });
  });

  it("llama adapter.remove(item.id) tras borrado exitoso", async () => {
    const item = makeItem({ id: "item-id-123", key: "folder/foto.jpg" });
    const adapter = makeAdapter({
      pending: vi.fn().mockResolvedValue([item]),
    });
    mockRemove.mockResolvedValue(undefined);

    const queue = createCleanupQueue({ adapter });
    const run = createCleanupRunner(queue);
    await run();

    expect(adapter.remove).toHaveBeenCalledWith("item-id-123");
    expect(adapter.markAttempt).not.toHaveBeenCalled();
  });

  it("no llama adapter.remove si no hay items pendientes", async () => {
    const adapter = makeAdapter({ pending: vi.fn().mockResolvedValue([]) });
    const queue = createCleanupQueue({ adapter });
    const run = createCleanupRunner(queue);
    await run();
    expect(adapter.remove).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
  });
});

// ─── runner — flujo fallido ───────────────────────────────────────────────────

describe("runner — flujo fallido", () => {
  it("llama adapter.markAttempt(item.id) cuando el borrado S3 falla", async () => {
    const item = makeItem({ id: "item-fail-456", key: "folder/foto.jpg" });
    const adapter = makeAdapter({
      pending: vi.fn().mockResolvedValue([item]),
    });
    mockRemove.mockRejectedValue(new Error("S3 timeout"));

    const queue = createCleanupQueue({ adapter });
    const run = createCleanupRunner(queue);
    await run();

    expect(adapter.markAttempt).toHaveBeenCalledWith("item-fail-456");
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it("un fallo no cancela el procesamiento de los otros items", async () => {
    const itemFail = makeItem({ id: "fail", key: "foto-fail.jpg" });
    const itemOk   = makeItem({ id: "ok",   key: "foto-ok.jpg" });
    const adapter = makeAdapter({
      pending: vi.fn().mockResolvedValue([itemFail, itemOk]),
    });

    mockRemove
      .mockRejectedValueOnce(new Error("fallo"))
      .mockResolvedValueOnce(undefined);

    const queue = createCleanupQueue({ adapter });
    const run = createCleanupRunner(queue);
    await run();

    expect(adapter.markAttempt).toHaveBeenCalledWith("fail");
    expect(adapter.remove).toHaveBeenCalledWith("ok");
  });

  it("procesa N items aunque todos fallen", async () => {
    const items = [makeItem(), makeItem(), makeItem()];
    const adapter = makeAdapter({
      pending: vi.fn().mockResolvedValue(items),
    });
    mockRemove.mockRejectedValue(new Error("error masivo"));

    const queue = createCleanupQueue({ adapter });
    const run = createCleanupRunner(queue);
    await run();

    expect(adapter.markAttempt).toHaveBeenCalledTimes(3);
    expect(adapter.remove).not.toHaveBeenCalled();
  });
});
