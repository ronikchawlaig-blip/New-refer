import { Router, type IRouter } from "express";
import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import {
  ApplyUserActionBody,
  ApplyUserActionParams,
  ApplyUserActionResponse,
  BotContent,
  CreateBroadcastBody,
  CreateBroadcastResponse,
  CreateChannelBody,
  CreateChannelResponse,
  CreateMilestoneBody,
  CreateMilestoneResponse,
  CreateRewardBody,
  CreateRewardResponse,
  DeleteChannelParams,
  DeleteMilestoneParams,
  DeleteRewardParams,
  GetContentResponse,
  GetDashboardResponse,
  GetRewardStockResponse,
  GetSettingsResponse,
  GetUserParams,
  GetUserResponse,
  ListAuditLogsResponse,
  ListBroadcastsResponse,
  ListChannelsResponse,
  ListDeliveriesResponse,
  ListMilestonesResponse,
  ListRewardsQueryParams,
  ListRewardsResponse,
  ListUsersQueryParams,
  ListUsersResponse,
  UpdateChannelBody,
  UpdateChannelParams,
  UpdateChannelResponse,
  UpdateContentBody,
  UpdateContentResponse,
  UpdateMilestoneBody,
  UpdateMilestoneParams,
  UpdateMilestoneResponse,
  UpdateRewardBody,
  UpdateRewardParams,
  UpdateRewardResponse,
  UpdateSettingsBody,
  UpdateSettingsResponse,
} from "@workspace/api-zod";
import {
  adminsTable,
  auditLogsTable,
  botContentTable,
  botSettingsTable,
  botUsersTable,
  broadcastsTable,
  db,
  forceChannelsTable,
  milestonesTable,
  referralsTable,
  rewardDeliveriesTable,
  rewardsTable,
} from "@workspace/db";
import { ensureSeeded, OWNER_TELEGRAM_ID } from "../lib/seed";

const router: IRouter = Router();

const countRows = async (table: any, condition?: any): Promise<number> => {
  const query = db.select({ count: sql<number>`count(*)` }).from(table);
  const rows = condition ? await query.where(condition) : await query;
  return Number(rows[0]?.count ?? 0);
};

const getId = (value: string | string[]): number => Number(Array.isArray(value) ? value[0] : value);

function userView(user: typeof botUsersTable.$inferSelect) {
  return {
    telegramId: user.telegramId,
    username: user.username || "unknown",
    joinDate: user.createdAt,
    referralCount: user.referralCount,
    points: user.points,
    referralStatus: user.referralState,
    disclaimerAccepted: user.disclaimerAccepted,
    banned: user.banned,
  };
}

async function audit(action: string, detail: string, targetTelegramId?: number): Promise<void> {
  await db.insert(auditLogsTable).values({
    action,
    actorTelegramId: OWNER_TELEGRAM_ID,
    targetTelegramId,
    detail,
  });
}

router.use(async (_req, _res, next): Promise<void> => {
  await ensureSeeded();
  next();
});

router.get("/admin/dashboard", async (_req, res): Promise<void> => {
  const [totalUsers, verifiedUsers, successfulReferrals, rewardsDelivered, availableRewards, usedRewards, failedDeliveries] =
    await Promise.all([
      countRows(botUsersTable),
      countRows(botUsersTable, eq(botUsersTable.referralState, "completed")),
      countRows(referralsTable, eq(referralsTable.status, "completed")),
      countRows(rewardDeliveriesTable, eq(rewardDeliveriesTable.status, "delivered")),
      countRows(rewardsTable, eq(rewardsTable.status, "available")),
      countRows(rewardsTable, or(eq(rewardsTable.status, "assigned"), eq(rewardsTable.status, "delivered"))),
      countRows(rewardDeliveriesTable, eq(rewardDeliveriesTable.status, "failed")),
    ]);
  const activity = await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt)).limit(8);
  res.json(GetDashboardResponse.parse({
    metrics: { totalUsers, verifiedUsers, successfulReferrals, rewardsDelivered, availableRewards, usedRewards, failedDeliveries },
    activity: activity.map((item) => ({
      id: item.id,
      label: item.action,
      detail: item.detail,
      createdAt: item.createdAt,
      tone: item.action.includes("failed") ? "red" : item.action.includes("reward") ? "green" : "blue",
    })),
  }));
});

router.get("/admin/settings", async (_req, res): Promise<void> => {
  const [settings] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.id, 1)).limit(1);
  res.json(GetSettingsResponse.parse(settings));
});

router.patch("/admin/settings", async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [settings] = await db.update(botSettingsTable).set({ ...parsed.data, updatedAt: new Date() }).where(eq(botSettingsTable.id, 1)).returning();
  await audit("settings.updated", "Bot settings updated");
  res.json(UpdateSettingsResponse.parse(settings));
});

router.get("/admin/content", async (_req, res): Promise<void> => {
  const [content] = await db.select().from(botContentTable).where(eq(botContentTable.id, 1)).limit(1);
  res.json(GetContentResponse.parse(content));
});

router.patch("/admin/content", async (req, res): Promise<void> => {
  const parsed = UpdateContentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [content] = await db.update(botContentTable).set({ ...parsed.data, updatedAt: new Date() }).where(eq(botContentTable.id, 1)).returning();
  await audit("content.updated", "Editable bot content updated");
  res.json(UpdateContentResponse.parse(content));
});

router.get("/admin/channels", async (_req, res): Promise<void> => {
  const channels = await db.select().from(forceChannelsTable).orderBy(asc(forceChannelsTable.sortOrder), asc(forceChannelsTable.id));
  res.json(ListChannelsResponse.parse(channels.map((channel) => ({ ...channel, memberCount: 0 }))));
});

router.post("/admin/channels", async (req, res): Promise<void> => {
  const parsed = CreateChannelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [channel] = await db.insert(forceChannelsTable).values(parsed.data).returning();
  await audit("channel.created", `Force subscribe channel ${channel.title} created`);
  res.status(201).json(CreateChannelResponse.parse({ ...channel, memberCount: 0 }));
});

router.patch("/admin/channels/:id", async (req, res): Promise<void> => {
  const params = UpdateChannelParams.safeParse({ id: getId(req.params.id) });
  const parsed = UpdateChannelBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid channel update" });
    return;
  }
  const [channel] = await db.update(forceChannelsTable).set({ ...parsed.data, updatedAt: new Date() }).where(eq(forceChannelsTable.id, params.data.id)).returning();
  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  await audit("channel.updated", `Force subscribe channel ${channel.title} updated`);
  res.json(UpdateChannelResponse.parse({ ...channel, memberCount: 0 }));
});

router.delete("/admin/channels/:id", async (req, res): Promise<void> => {
  const params = DeleteChannelParams.safeParse({ id: getId(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [channel] = await db.delete(forceChannelsTable).where(eq(forceChannelsTable.id, params.data.id)).returning();
  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  await audit("channel.deleted", `Force subscribe channel ${channel.title} deleted`);
  res.sendStatus(204);
});

router.get("/admin/milestones", async (_req, res): Promise<void> => {
  const milestones = await db.select().from(milestonesTable).orderBy(asc(milestonesTable.referralTarget));
  const counts = await db.select({ milestoneId: rewardsTable.milestoneId, count: sql<number>`count(*)` }).from(rewardsTable).groupBy(rewardsTable.milestoneId);
  const delivered = await db.select({ milestoneId: rewardDeliveriesTable.milestoneId, count: sql<number>`count(*)` }).from(rewardDeliveriesTable).where(eq(rewardDeliveriesTable.status, "delivered")).groupBy(rewardDeliveriesTable.milestoneId);
  const countMap = new Map(counts.map((row) => [row.milestoneId, Number(row.count)]));
  const deliveredMap = new Map(delivered.map((row) => [row.milestoneId, Number(row.count)]));
  res.json(ListMilestonesResponse.parse(milestones.map((item) => ({ ...item, rewardCount: countMap.get(item.id) ?? 0, claimedCount: deliveredMap.get(item.id) ?? 0 }))));
});

router.post("/admin/milestones", async (req, res): Promise<void> => {
  const parsed = CreateMilestoneBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [milestone] = await db.insert(milestonesTable).values(parsed.data).returning();
  await audit("milestone.created", `${milestone.name} milestone created`);
  res.status(201).json(CreateMilestoneResponse.parse({ ...milestone, rewardCount: 0, claimedCount: 0 }));
});

router.patch("/admin/milestones/:id", async (req, res): Promise<void> => {
  const params = UpdateMilestoneParams.safeParse({ id: getId(req.params.id) });
  const parsed = UpdateMilestoneBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid milestone update" });
    return;
  }
  const [milestone] = await db.update(milestonesTable).set({ ...parsed.data, updatedAt: new Date() }).where(eq(milestonesTable.id, params.data.id)).returning();
  if (!milestone) {
    res.status(404).json({ error: "Milestone not found" });
    return;
  }
  await audit("milestone.updated", `${milestone.name} milestone updated`);
  res.json(UpdateMilestoneResponse.parse({ ...milestone, rewardCount: 0, claimedCount: 0 }));
});

router.delete("/admin/milestones/:id", async (req, res): Promise<void> => {
  const params = DeleteMilestoneParams.safeParse({ id: getId(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [milestone] = await db.delete(milestonesTable).where(eq(milestonesTable.id, params.data.id)).returning();
  if (!milestone) {
    res.status(404).json({ error: "Milestone not found" });
    return;
  }
  await audit("milestone.deleted", `${milestone.name} milestone deleted`);
  res.sendStatus(204);
});

router.get("/admin/rewards", async (req, res): Promise<void> => {
  const parsed = ListRewardsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const rewards = await db.select().from(rewardsTable).where(parsed.data.status && parsed.data.status !== "all" ? eq(rewardsTable.status, parsed.data.status) : undefined).orderBy(desc(rewardsTable.createdAt));
  res.json(ListRewardsResponse.parse(rewards.map((item) => ({ ...item, assignedTo: item.assignedToTelegramId }))));
});

router.post("/admin/rewards", async (req, res): Promise<void> => {
  const parsed = CreateRewardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [reward] = await db.insert(rewardsTable).values({
    milestoneId: parsed.data.milestoneId,
    type: parsed.data.type,
    label: parsed.data.label,
    payload: parsed.data.payload,
    filePath: parsed.data.filePath ?? null,
    status: parsed.data.enabled === false ? "disabled" : "available",
  }).returning();
  await audit("reward.created", `${reward.label} added to inventory`);
  res.status(201).json(CreateRewardResponse.parse({ ...reward, assignedTo: reward.assignedToTelegramId }));
});

router.patch("/admin/rewards/:id", async (req, res): Promise<void> => {
  const params = UpdateRewardParams.safeParse({ id: getId(req.params.id) });
  const parsed = UpdateRewardBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid reward update" });
    return;
  }
  const update = {
    ...parsed.data,
    status: parsed.data.enabled === false ? "disabled" : parsed.data.enabled === true ? "available" : undefined,
    updatedAt: new Date(),
  };
  const [reward] = await db.update(rewardsTable).set(update).where(eq(rewardsTable.id, params.data.id)).returning();
  if (!reward) {
    res.status(404).json({ error: "Reward not found" });
    return;
  }
  await audit("reward.updated", `${reward.label} updated`);
  res.json(UpdateRewardResponse.parse({ ...reward, assignedTo: reward.assignedToTelegramId }));
});

router.delete("/admin/rewards/:id", async (req, res): Promise<void> => {
  const params = DeleteRewardParams.safeParse({ id: getId(req.params.id) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [reward] = await db.delete(rewardsTable).where(and(eq(rewardsTable.id, params.data.id), eq(rewardsTable.status, "available"))).returning();
  if (!reward) {
    res.status(409).json({ error: "Only available rewards can be deleted" });
    return;
  }
  await audit("reward.deleted", `${reward.label} removed from inventory`);
  res.sendStatus(204);
});

router.get("/admin/rewards/stock", async (_req, res): Promise<void> => {
  const rows = await db.select({
    milestoneId: milestonesTable.id,
    milestoneName: milestonesTable.name,
    target: milestonesTable.referralTarget,
    available: sql<number>`count(${rewardsTable.id}) filter (where ${rewardsTable.status} = 'available')`,
    assigned: sql<number>`count(${rewardsTable.id}) filter (where ${rewardsTable.status} = 'assigned')`,
    delivered: sql<number>`count(${rewardsTable.id}) filter (where ${rewardsTable.status} = 'delivered')`,
    failed: sql<number>`count(${rewardsTable.id}) filter (where ${rewardsTable.status} = 'failed')`,
  }).from(milestonesTable)
    .leftJoin(rewardsTable, eq(milestonesTable.id, rewardsTable.milestoneId))
    .groupBy(milestonesTable.id, milestonesTable.name, milestonesTable.referralTarget)
    .orderBy(asc(milestonesTable.referralTarget));
  const stock = rows.map((row) => ({ milestoneId: row.milestoneId, milestoneName: row.milestoneName, target: row.target, available: Number(row.available), assigned: Number(row.assigned), delivered: Number(row.delivered), failed: Number(row.failed) }));
  res.json(GetRewardStockResponse.parse(stock));
});

router.get("/admin/rewards/deliveries", async (_req, res): Promise<void> => {
  const rows = await db.select().from(rewardDeliveriesTable).orderBy(desc(rewardDeliveriesTable.createdAt)).limit(100);
  res.json(ListDeliveriesResponse.parse(rows));
});

router.get("/admin/users", async (req, res): Promise<void> => {
  const parsed = ListUsersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const search = parsed.data.search?.trim();
  const condition = search ? (/^\d+$/.test(search) ? eq(botUsersTable.telegramId, Number(search)) : ilike(botUsersTable.username, `%${search}%`)) : undefined;
  const users = await db.select().from(botUsersTable).where(condition).orderBy(desc(botUsersTable.createdAt)).limit(parsed.data.limit ?? 50);
  res.json(ListUsersResponse.parse(users.map(userView)));
});

router.get("/admin/users/:telegramId", async (req, res): Promise<void> => {
  const params = GetUserParams.safeParse({ telegramId: Number(Array.isArray(req.params.telegramId) ? req.params.telegramId[0] : req.params.telegramId) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [user] = await db.select().from(botUsersTable).where(eq(botUsersTable.telegramId, params.data.telegramId)).limit(1);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const referralHistory = await db.select().from(referralsTable).where(eq(referralsTable.referrerTelegramId, user.telegramId)).orderBy(desc(referralsTable.createdAt));
  const rewardHistory = await db.select().from(rewardDeliveriesTable).where(eq(rewardDeliveriesTable.telegramUserId, user.telegramId)).orderBy(desc(rewardDeliveriesTable.createdAt));
  res.json(GetUserResponse.parse({ user: userView(user), referralHistory, rewardHistory }));
});

router.post("/admin/users/:telegramId/actions", async (req, res): Promise<void> => {
  const params = ApplyUserActionParams.safeParse({ telegramId: Number(Array.isArray(req.params.telegramId) ? req.params.telegramId[0] : req.params.telegramId) });
  const parsed = ApplyUserActionBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Invalid user action" });
    return;
  }
  const [existing] = await db.select().from(botUsersTable).where(eq(botUsersTable.telegramId, params.data.telegramId)).limit(1);
  if (!existing) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const amount = parsed.data.amount ?? 1;
  const updates: Partial<typeof botUsersTable.$inferInsert> = { updatedAt: new Date() };
  if (parsed.data.action === "ban") updates.banned = true;
  if (parsed.data.action === "unban") updates.banned = false;
  if (parsed.data.action === "add_referrals") updates.referralCount = existing.referralCount + amount;
  if (parsed.data.action === "remove_referrals") updates.referralCount = Math.max(0, existing.referralCount - amount);
  if (parsed.data.action === "add_points") updates.points = existing.points + amount;
  if (parsed.data.action === "remove_points") updates.points = Math.max(0, existing.points - amount);
  if (parsed.data.action === "reset_progress") {
    updates.referralCount = 0;
    updates.points = 0;
    updates.referralState = "pending";
  }
  const [user] = await db.update(botUsersTable).set(updates).where(eq(botUsersTable.telegramId, params.data.telegramId)).returning();
  await audit(`user.${parsed.data.action}`, parsed.data.reason ?? "Manual user action", user.telegramId);
  res.json(ApplyUserActionResponse.parse(userView(user)));
});

router.get("/admin/broadcasts", async (_req, res): Promise<void> => {
  const broadcasts = await db.select().from(broadcastsTable).orderBy(desc(broadcastsTable.createdAt)).limit(50);
  res.json(ListBroadcastsResponse.parse(broadcasts));
});

router.post("/admin/broadcasts", async (req, res): Promise<void> => {
  const parsed = CreateBroadcastBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [broadcast] = await db.insert(broadcastsTable).values({ ...parsed.data, status: "queued" }).returning();
  await audit("broadcast.queued", `${broadcast.contentType} broadcast queued`);
  res.status(201).json(CreateBroadcastResponse.parse(broadcast));
});

router.get("/admin/audit-logs", async (_req, res): Promise<void> => {
  const logs = await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt)).limit(100);
  res.json(ListAuditLogsResponse.parse(logs));
});

export default router;