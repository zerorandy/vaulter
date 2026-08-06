import { remove } from "./storage.js";
import type { VaulterConfig } from "./config.js";
import { VaulterQueueError } from "./errors.js";

/* ------------------------------------------------------------------ */
/* Tipos públicos                                                        */
/* ------------------------------------------------------------------ */

/**
 * Representa un item pendiente de borrado en la cola.
 * El adaptador debe devolver objetos con esta forma en `pending()`.
 */
export interface QueueItem {
  /** Identificador único del item en la cola. */
  id: string;
  /** Key del objeto en el bucket. */
  key: string;
  /** Número de intentos de borrado fallidos hasta ahora. */
  attempts: number;
  /** Última vez que se intentó el borrado. `null` si nunca se intentó. */
  lastTriedAt: Date | null;
  /** Fecha de creación del item en la cola. */
  createdAt: Date;
}

/**
 * Interfaz que el usuario implementa para conectar la cola de limpieza
 * con su base de datos. Vaulter no depende de ningún ORM.
 *
 * @example
 * // Ver examples/prisma-adapter.ts para una implementación completa con Prisma.
 */
export interface QueueAdapter {
  /** Encola una key para borrado futuro. */
  insert(key: string): Promise<void>;
  /** Devuelve items pendientes que aún no superaron `maxAttempts`. */
  pending(maxAttempts: number): Promise<QueueItem[]>;
  /** Elimina un item de la cola (borrado exitoso). */
  remove(id: string): Promise<void>;
  /** Incrementa el contador de intentos fallidos de un item. */
  markAttempt(id: string): Promise<void>;
}

/**
 * Cola de limpieza devuelta por `createCleanupQueue`.
 * El usuario solo necesita llamar a `enqueue` — el runner hace el resto.
 */
export interface CleanupQueue {
  /**
   * Encola una key para que el runner la borre en el próximo ciclo.
   * Llamar antes de borrar el registro en la base de datos.
   */
  enqueue(key: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Estado interno (WeakMap para no contaminar la interfaz pública)      */
/* ------------------------------------------------------------------ */

interface QueueInternal {
  adapter: QueueAdapter;
  maxAttempts: number;
  config: VaulterConfig | undefined;
}

const internals = new WeakMap<CleanupQueue, QueueInternal>();

/* ------------------------------------------------------------------ */
/* createCleanupQueue                                                   */
/* ------------------------------------------------------------------ */

/**
 * Crea una cola de limpieza de archivos. El usuario llama a `enqueue(key)`
 * cuando quiere marcar un archivo para borrado resiliente.
 *
 * @example
 * import { createCleanupQueue } from '@zerorandy/vaulter/queue'
 * import { prismaAdapter } from './prisma-adapter.js'
 *
 * export const cleanupQueue = createCleanupQueue({
 *   adapter: prismaAdapter,
 *   maxAttempts: 5,
 * })
 *
 * // Al borrar un post con media:
 * await cleanupQueue.enqueue(post.imageKey)
 * await db.post.delete({ where: { id: post.id } })
 */
export function createCleanupQueue(opts: {
  adapter: QueueAdapter;
  maxAttempts?: number;
  config?: VaulterConfig;
}): CleanupQueue {
  const queue: CleanupQueue = {
    async enqueue(key: string): Promise<void> {
      await opts.adapter.insert(key);
    },
  };

  internals.set(queue, {
    adapter: opts.adapter,
    maxAttempts: opts.maxAttempts ?? 5,
    config: opts.config,
  });

  return queue;
}

/* ------------------------------------------------------------------ */
/* createCleanupRunner                                                  */
/* ------------------------------------------------------------------ */

/**
 * Crea una función que procesa la cola: intenta borrar cada key pendiente
 * de S3 y actualiza el estado en la base de datos.
 *
 * Llamar esta función desde un cron job o un endpoint protegido.
 *
 * - Borrado exitoso → `adapter.remove(id)` (sale de la cola).
 * - Borrado fallido → `adapter.markAttempt(id)` (reintento en el próximo ciclo).
 * - Tras `maxAttempts` fallos, el item queda en la cola marcado para
 *   revisión manual (depende de la implementación del adaptador).
 *
 * @example
 * import { createCleanupRunner } from '@zerorandy/vaulter/queue'
 * import { cleanupQueue } from './queue.js'
 *
 * export const runCleanup = createCleanupRunner(cleanupQueue)
 *
 * // En un cron endpoint:
 * await runCleanup()
 */
export function createCleanupRunner(
  queue: CleanupQueue,
): () => Promise<void> {
  const state = internals.get(queue);

  if (!state) {
    throw new VaulterQueueError(
      "Vaulter: the queue passed to createCleanupRunner was not created by createCleanupQueue.",
    );
  }

  const { adapter, maxAttempts, config } = state;

  return async function run(): Promise<void> {
    const items = await adapter.pending(maxAttempts);

    await Promise.allSettled(
      items.map(async (item) => {
        try {
          await remove(
            item.key,
            config !== undefined ? { config } : undefined,
          );
          await adapter.remove(item.id);
        } catch {
          await adapter.markAttempt(item.id);
        }
      }),
    );
  };
}
