import { and, asc, eq, sql } from "drizzle-orm";
import { botUsersTable, broadcastsTable, db } from "@workspace/db";
import { logger } from "./logger";

let workerStarted = false;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function telegram(method: string, body: Record<string, unknown>): Promise<unknown> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as { ok: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } };
  if (!data.ok) {
    const error = new Error(data.description ?? `Telegram ${method} failed`) as Error & { retryAfter?: number };
    error.retryAfter = data.parameters?.retry_after;
    throw error;
  }
  return data.result;
}

async function sendBroadcast(broadcast: typeof broadcastsTable.$inferSelect, chatId: number): Promise<void> {
  const markup = broadcast.buttonText && broadcast.buttonUrl
    ? { inline_keyboard: [[{ text: broadcast.buttonText, url: broadcast.buttonUrl }]] }
    : undefined;
  const base = { chat_id: chatId, reply_markup: markup };
  if (broadcast.contentType === "photo") await telegram("sendPhoto", { ...base, photo: broadcast.content });
  else if (broadcast.contentType === "video") await telegram("sendVideo", { ...base, video: broadcast.content });
  else if (broadcast.contentType === "animation") await telegram("sendAnimation", { ...base, animation: broadcast.content });
  else if (broadcast.contentType === "document") await telegram("sendDocument", { ...base, document: broadcast.content });
  else await telegram("sendMessage", { ...base, text: broadcast.content, disable_web_page_preview: !broadcast.preview });
}

async function processBroadcast(broadcast: typeof broadcastsTable.$inferSelect): Promise<void> {
  const users = await db.select({ telegramId: botUsersTable.telegramId })
    .from(botUsersTable)
    .where(eq(botUsersTable.banned, false))
    .orderBy(asc(botUsersTable.telegramId));
  await db.update(broadcastsTable).set({ totalRecipients: users.length, status: "processing", updatedAt: new Date() }).where(eq(broadcastsTable.id, broadcast.id));
  let sentCount = 0;
  let failedCount = 0;
  for (const user of users) {
    try {
      await sendBroadcast(broadcast, user.telegramId);
      sentCount += 1;
    } catch (error) {
      const retryAfter = error instanceof Error && "retryAfter" in error ? Number((error as Error & { retryAfter?: number }).retryAfter) : 0;
      if (retryAfter > 0) {
        await sleep(Math.min(retryAfter * 1000, 60_000));
        try {
          await sendBroadcast(broadcast, user.telegramId);
          sentCount += 1;
        } catch {
          failedCount += 1;
        }
      } else {
        failedCount += 1;
      }
    }
    await db.update(broadcastsTable).set({ sentCount, failedCount, updatedAt: new Date() }).where(eq(broadcastsTable.id, broadcast.id));
    await sleep(55);
  }
  await db.update(broadcastsTable).set({ status: failedCount > 0 && sentCount === 0 ? "failed" : "completed", sentCount, failedCount, updatedAt: new Date() }).where(eq(broadcastsTable.id, broadcast.id));
}

export function startBroadcastWorker(): void {
  if (workerStarted || !process.env.TELEGRAM_BOT_TOKEN) return;
  workerStarted = true;
  void (async () => {
    logger.info("Broadcast worker started");
    while (workerStarted) {
      try {
        const [broadcast] = await db.select().from(broadcastsTable)
          .where(eq(broadcastsTable.status, "queued"))
          .orderBy(asc(broadcastsTable.createdAt))
          .limit(1);
        if (broadcast) {
          await processBroadcast(broadcast);
        } else {
          await sleep(5000);
        }
      } catch (error) {
        logger.error({ error }, "Broadcast worker error");
        await sleep(5000);
      }
    }
  })();
}