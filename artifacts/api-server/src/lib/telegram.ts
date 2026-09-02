import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  botContentTable,
  botSettingsTable,
  botUsersTable,
  adminsTable,
  db,
  forceChannelsTable,
  milestonesTable,
  referralsTable,
  rewardDeliveriesTable,
  rewardsTable,
  userChannelSubscriptionsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { ensureSeeded } from "./seed";

type TelegramResponse<T> = { ok: boolean; result: T; description?: string };
type Update = {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
};

const token = () => process.env.TELEGRAM_BOT_TOKEN;
let polling = false;

async function telegram<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const botToken = token();
  if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as TelegramResponse<T>;
  if (!data.ok) throw new Error(data.description ?? `Telegram ${method} failed`);
  return data.result;
}

const button = (text: string, callbackData: string) => ({ text, callback_data: callbackData });

type ReplyKeyboardButton = { text: string; web_app?: { url: string } };

function adminPanelUrl(): string | null {
  if (process.env.ADMIN_PANEL_URL) return process.env.ADMIN_PANEL_URL.replace(/\/+$/, "") + "/";
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, "") + "/admin/";
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/admin/`;
  if (process.env.REPLIT_DEV_DOMAIN) return `https://${process.env.REPLIT_DEV_DOMAIN}/refer-reward-admin/`;
  return null;
}

async function isAdmin(userId: number): Promise<boolean> {
  const [admin] = await db.select({ telegramId: adminsTable.telegramId })
    .from(adminsTable)
    .where(and(eq(adminsTable.telegramId, userId), eq(adminsTable.enabled, true)))
    .limit(1);
  return Boolean(admin);
}

async function mainReplyKeyboard(userId: number): Promise<{ keyboard: ReplyKeyboardButton[][]; resize_keyboard: true; is_persistent: true; input_field_placeholder: string }> {
  const keyboard: ReplyKeyboardButton[][] = [
    [{ text: "👥 Refer & Earn" }, { text: "🎁 My Rewards" }],
    [{ text: "📊 My Progress" }, { text: "💬 Support" }],
  ];
  if (await isAdmin(userId)) {
    keyboard.push([{ text: "⚙️ Admin Panel" }]);
  }
  return { keyboard, resize_keyboard: true, is_persistent: true, input_field_placeholder: "Choose an option…" };
}

async function edit(chatId: number, messageId: number, text: string, replyMarkup?: unknown): Promise<void> {
  await telegram("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  });
}

async function answerCallback(callbackId: string): Promise<void> {
  await telegram("answerCallbackQuery", { callback_query_id: callbackId });
}

async function getSettings() {
  const [settings] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.id, 1)).limit(1);
  return settings;
}

async function getContent() {
  const [content] = await db.select().from(botContentTable).where(eq(botContentTable.id, 1)).limit(1);
  return content;
}

async function upsertUser(update: NonNullable<Update["message"]>, referralCode?: string) {
  const userId = update.from?.id ?? update.chat.id;
  const [existing] = await db.select().from(botUsersTable).where(eq(botUsersTable.telegramId, userId)).limit(1);
  if (existing) return existing;

  const [referrer] = referralCode
    ? await db.select().from(botUsersTable).where(eq(botUsersTable.referralCode, referralCode)).limit(1)
    : [];
  const [created] = await db.insert(botUsersTable).values({
    telegramId: userId,
    username: update.from?.username ?? "",
    firstName: update.from?.first_name ?? "",
    referralCode: `${userId}-${Math.random().toString(36).slice(2, 9)}`,
    referredByTelegramId: referrer && referrer.telegramId !== userId ? referrer.telegramId : null,
  }).returning();
  if (referrer && referrer.telegramId !== userId) {
    await db.insert(referralsTable).values({
      referrerTelegramId: referrer.telegramId,
      referredTelegramId: userId,
      status: "pending",
    }).onConflictDoNothing();
  }
  return created;
}

async function showGate(chatId: number, messageId: number | undefined, text: string, replyMarkup: unknown): Promise<void> {
  if (messageId) {
    await edit(chatId, messageId, text, replyMarkup);
    return;
  }
  await telegram("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", reply_markup: replyMarkup });
}

async function showSubscriptionGate(chatId: number, messageId?: number): Promise<void> {
  const [content] = await Promise.all([getContent()]);
  const channels = await db.select().from(forceChannelsTable).where(eq(forceChannelsTable.enabled, true)).orderBy(asc(forceChannelsTable.sortOrder));
  const rows = channels.map((channel) => [button(`Join ${channel.title}`, `join:${channel.id}`)]);
  rows.push([button("🔄 Check Subscription", "check:subscription")]);
  await showGate(chatId, messageId, content.forceSubscribeMessage, { inline_keyboard: rows });
}

async function showDisclaimer(chatId: number, messageId?: number): Promise<void> {
  const content = await getContent();
  await showGate(chatId, messageId, content.disclaimer, { inline_keyboard: [[button("✅ Accept & Continue", "accept:disclaimer")]] });
}

async function showMenu(chatId: number, messageId?: number): Promise<void> {
  if (messageId) {
    await edit(chatId, messageId, "✅ <b>Verified successfully.</b>\n\nUse the menu below.", { inline_keyboard: [] });
  }
  await telegram("sendMessage", {
    chat_id: chatId,
    text: "✨ <b>Access unlocked</b>\n\nChoose an option to continue.",
    parse_mode: "HTML",
    reply_markup: await mainReplyKeyboard(chatId),
  });
}

async function showAdminPanel(chatId: number, userId: number): Promise<void> {
  if (!(await isAdmin(userId))) {
    await telegram("sendMessage", { chat_id: chatId, text: "⛔ Admin access is restricted." });
    return;
  }
  const url = adminPanelUrl();
  if (!url) {
    await telegram("sendMessage", { chat_id: chatId, text: "⚠️ Admin Panel URL is not configured yet." });
    return;
  }
  await telegram("sendMessage", {
    chat_id: chatId,
    text: "⚙️ <b>Admin Control Center</b>\n\nManage rewards, users, channels, content and broadcasts from inside Telegram.",
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "🚀 Open Admin Panel", url }]] },
  });
}

async function handleStart(update: NonNullable<Update["message"]>): Promise<void> {
  const chatId = update.chat.id;
  const referralCode = update.text?.split(/\s+/)[1];
  const user = await upsertUser(update, referralCode);
  const settings = await getSettings();
  const content = await getContent();
  if (user.banned) {
    await telegram("sendMessage", { chat_id: chatId, text: content.errorMessage });
    return;
  }
  if (settings.maintenanceMode && user.telegramId !== settings.ownerTelegramId) {
    await telegram("sendMessage", { chat_id: chatId, text: settings.maintenanceMessage });
    return;
  }
  if (user.disclaimerAccepted) {
    await showMenu(chatId);
    return;
  }
  await telegram("sendMessage", { chat_id: chatId, text: content.welcomeMessage, parse_mode: "HTML" });
  const channels = await db.select({ id: forceChannelsTable.id }).from(forceChannelsTable).where(eq(forceChannelsTable.enabled, true));
  if (channels.length > 0 && !user.subscribed) {
    await showSubscriptionGate(chatId);
    return;
  }
  if (settings.disclaimerEnabled) await showDisclaimer(chatId);
  else {
    await completeReferral(user.telegramId);
    await showMenu(chatId);
  }
}

async function handleMenuText(update: NonNullable<Update["message"]>): Promise<void> {
  const text = update.text?.trim();
  const userId = update.from?.id ?? update.chat.id;
  if (!text) return;
  if (text === "/admin" || text === "⚙️ Admin Panel") {
    await showAdminPanel(update.chat.id, userId);
    return;
  }
  const actions: Record<string, string> = {
    "👥 Refer & Earn": "menu:refer",
    "🎁 My Rewards": "menu:rewards",
    "📊 My Progress": "menu:progress",
    "💬 Support": "menu:support",
  };
  const action = actions[text];
  if (action) await handleCallback({ id: "", from: { id: userId }, data: action, message: { chat: { id: update.chat.id, }, message_id: 0 } });
}

async function verifySubscription(userId: number): Promise<boolean> {
  const channels = await db.select().from(forceChannelsTable).where(eq(forceChannelsTable.enabled, true)).orderBy(asc(forceChannelsTable.sortOrder));
  for (const channel of channels) {
    const member = await telegram<{ status: string }>("getChatMember", { chat_id: channel.chatId, user_id: userId });
    const joined = ["creator", "administrator", "member"].includes(member.status);
    await db.insert(userChannelSubscriptionsTable).values({ telegramId: userId, channelId: channel.id, joined, checkedAt: new Date() })
      .onConflictDoUpdate({ target: [userChannelSubscriptionsTable.telegramId, userChannelSubscriptionsTable.channelId], set: { joined, checkedAt: new Date() } });
    if (!joined) return false;
  }
  await db.update(botUsersTable).set({ subscribed: true, referralState: "subscribed", updatedAt: new Date() }).where(eq(botUsersTable.telegramId, userId));
  await db.update(referralsTable).set({ status: "subscribed" }).where(and(eq(referralsTable.referredTelegramId, userId), eq(referralsTable.status, "pending")));
  return true;
}

async function completeReferral(userId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(botUsersTable).where(eq(botUsersTable.telegramId, userId)).limit(1);
    if (!user || user.disclaimerAccepted) return;
    await tx.update(botUsersTable).set({ disclaimerAccepted: true, referralState: "completed", updatedAt: new Date() }).where(eq(botUsersTable.telegramId, userId));
    const [referral] = await tx.update(referralsTable)
      .set({ status: "completed", completedAt: new Date() })
      .where(and(eq(referralsTable.referredTelegramId, userId), eq(referralsTable.status, "subscribed")))
      .returning();
    if (referral) {
      await tx.update(botUsersTable)
        .set({ referralCount: sql`${botUsersTable.referralCount} + 1`, points: sql`${botUsersTable.points} + 1`, updatedAt: new Date() })
        .where(eq(botUsersTable.telegramId, referral.referrerTelegramId));
    }
  });
}

async function deliverReward(chatId: number, reward: typeof rewardsTable.$inferSelect): Promise<void> {
  const payload = reward.payload;
  if (reward.type === "photo") await telegram("sendPhoto", { chat_id: chatId, photo: payload, caption: reward.label });
  else if (reward.type === "video") await telegram("sendVideo", { chat_id: chatId, video: payload, caption: reward.label });
  else if (reward.type === "animation") await telegram("sendAnimation", { chat_id: chatId, animation: payload, caption: reward.label });
  else if (["file", "document", "apk"].includes(reward.type)) await telegram("sendDocument", { chat_id: chatId, document: payload, caption: reward.label });
  else await telegram("sendMessage", { chat_id: chatId, text: `<b>${reward.label}</b>\n\n${payload}`, parse_mode: "HTML" });
}

async function claimReward(userId: number, milestoneId: number): Promise<typeof rewardsTable.$inferSelect | null> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(rewardDeliveriesTable).where(and(eq(rewardDeliveriesTable.telegramUserId, userId), eq(rewardDeliveriesTable.milestoneId, milestoneId))).limit(1);
    if (existing) return null;
    const [reward] = await tx.select().from(rewardsTable).where(and(eq(rewardsTable.milestoneId, milestoneId), eq(rewardsTable.status, "available"))).orderBy(asc(rewardsTable.id)).limit(1).for("update");
    if (!reward) return null;
    const [assigned] = await tx.update(rewardsTable).set({ status: "assigned", assignedToTelegramId: userId, assignedAt: new Date(), updatedAt: new Date() }).where(and(eq(rewardsTable.id, reward.id), eq(rewardsTable.status, "available"))).returning();
    if (!assigned) return null;
    await tx.insert(rewardDeliveriesTable).values({ rewardId: reward.id, milestoneId, telegramUserId: userId, status: "assigned" });
    return assigned;
  });
}

async function handleCallback(update: NonNullable<Update["callback_query"]>): Promise<void> {
  const chatId = update.message?.chat.id;
  const messageId = update.message?.message_id;
  if (!chatId || !update.data) return;
  const userId = update.from.id;
  const user = await db.select().from(botUsersTable).where(eq(botUsersTable.telegramId, userId)).limit(1).then((rows) => rows[0]);
  if (!user) return;
  if (update.data.startsWith("join:")) {
    const channelId = Number(update.data.split(":")[1]);
    const [channel] = await db.select().from(forceChannelsTable).where(eq(forceChannelsTable.id, channelId)).limit(1);
    if (channel) {
      await telegram("answerCallbackQuery", { callback_query_id: update.id, url: channel.inviteLink });
    } else {
      await answerCallback(update.id);
    }
    return;
  }
  if (update.id) await answerCallback(update.id);
  if (update.data === "check:subscription") {
    await showGate(chatId, messageId, "🔍 <b>Checking your subscription…</b>", { inline_keyboard: [] });
    try {
      const valid = await verifySubscription(userId);
      if (!valid) await showSubscriptionGate(chatId, messageId);
      else if ((await getSettings()).disclaimerEnabled) await showDisclaimer(chatId, messageId);
      else {
        await completeReferral(userId);
        await showMenu(chatId, messageId);
      }
    } catch (error) {
      logger.warn({ error, userId }, "Telegram subscription check failed");
      await showSubscriptionGate(chatId, messageId);
    }
    return;
  }
  if (update.data === "accept:disclaimer") {
    await completeReferral(userId);
    await showMenu(chatId, messageId);
    return;
  }
  if (update.data === "menu:refer") {
    const settings = await getSettings();
    const botUsername = settings.botUsername ?? "your_bot";
    const link = `https://t.me/${botUsername}?start=${user.referralCode}`;
    await showGate(chatId, messageId, `<b>Refer & Earn</b>\n\nYour personal link:\n<code>${link}</code>\n\nSuccessful referrals: <b>${user.referralCount}</b>\nInvite genuinely new users to unlock the next reward.`, { inline_keyboard: [[button("← Back", "menu:back")]] });
    return;
  }
  if (update.data === "menu:progress") {
    const [next] = await db.select().from(milestonesTable).where(and(eq(milestonesTable.enabled, true), sql`${milestonesTable.referralTarget} > ${user.referralCount}`)).orderBy(asc(milestonesTable.referralTarget)).limit(1);
    await showGate(chatId, messageId, `<b>My Progress</b>\n\nSuccessful referrals: <b>${user.referralCount}</b>\nCurrent milestone: <b>${next ? "In progress" : "All milestones reached"}</b>\nNext target: <b>${next?.referralTarget ?? "—"}</b>\nRemaining: <b>${next ? Math.max(0, next.referralTarget - user.referralCount) : 0}</b>`, { inline_keyboard: [[button("← Back", "menu:back")]] });
    return;
  }
  if (update.data === "menu:support") {
    const [settings, content] = await Promise.all([getSettings(), getContent()]);
    await showGate(chatId, messageId, content.supportMessage, { inline_keyboard: [[{ text: settings.supportButtonLabel, url: settings.supportBotLink }], [button("← Back", "menu:back")]] });
    return;
  }
  if (update.data === "menu:rewards") {
    const milestones = await db.select().from(milestonesTable).where(and(eq(milestonesTable.enabled, true), sql`${milestonesTable.referralTarget} <= ${user.referralCount}`)).orderBy(asc(milestonesTable.referralTarget));
    const claimable = [];
    for (const milestone of milestones) {
      const [delivery] = await db.select().from(rewardDeliveriesTable).where(and(eq(rewardDeliveriesTable.telegramUserId, userId), eq(rewardDeliveriesTable.milestoneId, milestone.id))).limit(1);
      if (!delivery) claimable.push([button(`Claim ${milestone.name}`, `claim:${milestone.id}`)]);
    }
    await showGate(chatId, messageId, claimable.length ? "🎁 <b>My Rewards</b>\n\nYour unlocked rewards are ready to claim." : "🎁 <b>My Rewards</b>\n\nNo unlocked rewards are waiting right now.", { inline_keyboard: [...claimable, [button("← Back", "menu:back")]] });
    return;
  }
  if (update.data.startsWith("claim:")) {
    const milestoneId = Number(update.data.split(":")[1]);
    const reward = await claimReward(userId, milestoneId);
    if (!reward) {
      await showMenu(chatId, messageId);
      return;
    }
    try {
      await deliverReward(chatId, reward);
      await db.update(rewardDeliveriesTable).set({ status: "delivered" }).where(and(eq(rewardDeliveriesTable.rewardId, reward.id), eq(rewardDeliveriesTable.telegramUserId, userId)));
      await db.update(rewardsTable).set({ status: "delivered", updatedAt: new Date() }).where(eq(rewardsTable.id, reward.id));
    } catch (error) {
      await db.update(rewardDeliveriesTable).set({ status: "failed", errorMessage: error instanceof Error ? error.message : "Telegram delivery failed" }).where(and(eq(rewardDeliveriesTable.rewardId, reward.id), eq(rewardDeliveriesTable.telegramUserId, userId)));
      await db.update(rewardsTable).set({ status: "failed", updatedAt: new Date() }).where(eq(rewardsTable.id, reward.id));
      logger.error({ error, rewardId: reward.id, userId }, "Reward delivery failed");
      await telegram("sendMessage", { chat_id: chatId, text: "Reward delivery failed safely. It will not be assigned to another user." });
    }
    return;
  }
  if (update.data === "menu:back") await showMenu(chatId, messageId);
}

async function processUpdates(updates: Update[]): Promise<void> {
  for (const update of updates) {
    try {
      if (update.message?.text?.startsWith("/start")) await handleStart(update.message);
      else if (update.message?.text) await handleMenuText(update.message);
      else if (update.callback_query) await handleCallback(update.callback_query);
    } catch (error) {
      logger.error({ error, updateId: update.update_id }, "Telegram update failed");
    }
  }
}

export function startTelegramBot(): void {
  if (polling || !token()) {
    if (!token()) logger.warn("TELEGRAM_BOT_TOKEN is not configured; Telegram polling is disabled");
    return;
  }
  polling = true;
  void (async () => {
    await ensureSeeded();
    try {
      const me = await telegram<{ username?: string }>("getMe", {});
      if (me.username) await db.update(botSettingsTable).set({ botUsername: me.username, updatedAt: new Date() }).where(eq(botSettingsTable.id, 1));
    } catch (error) {
      logger.warn({ error }, "Telegram bot identity lookup failed");
    }
    let offset = 0;
    logger.info("Telegram polling started");
    while (polling) {
      try {
        const updates = await telegram<Update[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
        if (updates.length) {
          offset = updates[updates.length - 1].update_id + 1;
          await processUpdates(updates);
        }
      } catch (error) {
        logger.error({ error }, "Telegram polling error");
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  })();
}