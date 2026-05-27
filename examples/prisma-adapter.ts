/**
 * Implementación de referencia de QueueAdapter usando Prisma.
 *
 * Requiere este modelo en tu schema.prisma:
 *
 * ```prisma
 * model MediaCleanupQueue {
 *   id          String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
 *   key         String
 *   reason      String    @default("deleted")
 *   attempts    Int       @default(0)
 *   lastTriedAt DateTime? @map("last_tried_at")
 *   failed      Boolean   @default(false)
 *   createdAt   DateTime  @default(now()) @map("created_at")
 *
 *   @@index([failed, attempts])
 *   @@map("media_cleanup_queue")
 * }
 * ```
 */

import type { QueueAdapter, QueueItem } from "vaulter/queue";
// import { PrismaClient } from '@prisma/client'
// const prisma = new PrismaClient()

// Sustituye `prisma` por tu instancia real de PrismaClient.
declare const prisma: {
  mediaCleanupQueue: {
    create: (args: {
      data: { key: string; reason?: string };
    }) => Promise<{ id: string }>;
    findMany: (args: {
      where: { failed: boolean; attempts: { lt: number } };
    }) => Promise<
      {
        id: string;
        key: string;
        attempts: number;
        lastTriedAt: Date | null;
        createdAt: Date;
      }[]
    >;
    delete: (args: { where: { id: string } }) => Promise<void>;
    update: (args: {
      where: { id: string };
      data: { attempts: { increment: number }; lastTriedAt: Date };
    }) => Promise<void>;
  };
};

export const prismaAdapter: QueueAdapter = {
  async insert(key: string): Promise<void> {
    await prisma.mediaCleanupQueue.create({ data: { key } });
  },

  async pending(maxAttempts: number): Promise<QueueItem[]> {
    return prisma.mediaCleanupQueue.findMany({
      where: { failed: false, attempts: { lt: maxAttempts } },
    });
  },

  async remove(id: string): Promise<void> {
    await prisma.mediaCleanupQueue.delete({ where: { id } });
  },

  async markAttempt(id: string): Promise<void> {
    await prisma.mediaCleanupQueue.update({
      where: { id },
      data: { attempts: { increment: 1 }, lastTriedAt: new Date() },
    });
  },
};
