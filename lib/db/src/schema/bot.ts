import { createInsertSchema } from "drizzle-zod";
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const botUsersTable = pgTable(
  "bot_users",
  {
    telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
    username: text("username").notNull().default(""),
    firstName: text("first_name").notNull().default(""),
    referralCode: text("referral_code").notNull(),
    referredByTelegramId: bigint("referred_by_telegram_id", { mode: "number" }),
    referralState: text("referral_state").notNull().default("pending"),
    referralCount: integer("referral_count").notNull().default(0),
    points: integer("points").notNull().default(0),
    subscribed: boolean("subscribed").notNull().default(false),
    disclaimerAccepted: boolean("disclaimer_accepted").notNull().default(false),
    banned: boolean("banned").notNull().default(false),
    ...timestamps,
  },
  (table) => [uniqueIndex("bot_users_referral_code_idx").on(table.referralCode)],
);

export const referralsTable = pgTable(
  "referrals",
  {
    id: serial("id").primaryKey(),
    referrerTelegramId: bigint("referrer_telegram_id", { mode: "number" })
      .notNull()
      .references(() => botUsersTable.telegramId),
    referredTelegramId: bigint("referred_telegram_id", { mode: "number" })
      .notNull()
      .references(() => botUsersTable.telegramId),
    status: text("status").notNull().default("pending"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("referrals_referred_user_idx").on(table.referredTelegramId)],
);

export const forceChannelsTable = pgTable("force_channels", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  chatId: text("chat_id").notNull(),
  inviteLink: text("invite_link").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
});

export const userChannelSubscriptionsTable = pgTable(
  "user_channel_subscriptions",
  {
    id: serial("id").primaryKey(),
    telegramId: bigint("telegram_id", { mode: "number" })
      .notNull()
      .references(() => botUsersTable.telegramId),
    channelId: integer("channel_id")
      .notNull()
      .references(() => forceChannelsTable.id),
    joined: boolean("joined").notNull().default(false),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("user_channel_subscription_idx").on(table.telegramId, table.channelId)],
);

export const milestonesTable = pgTable("milestones", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  referralTarget: integer("referral_target").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  ...timestamps,
});

export const rewardsTable = pgTable("rewards", {
  id: serial("id").primaryKey(),
  milestoneId: integer("milestone_id")
    .notNull()
    .references(() => milestonesTable.id),
  type: text("type").notNull(),
  label: text("label").notNull(),
  payload: text("payload").notNull(),
  filePath: text("file_path"),
  status: text("status").notNull().default("available"),
  assignedToTelegramId: bigint("assigned_to_telegram_id", { mode: "number" }).references(
    () => botUsersTable.telegramId,
  ),
  assignedAt: timestamp("assigned_at", { withTimezone: true }),
  ...timestamps,
});

export const rewardDeliveriesTable = pgTable(
  "reward_deliveries",
  {
    id: serial("id").primaryKey(),
    rewardId: integer("reward_id")
      .notNull()
      .references(() => rewardsTable.id),
    milestoneId: integer("milestone_id")
      .notNull()
      .references(() => milestonesTable.id),
    telegramUserId: bigint("telegram_user_id", { mode: "number" })
      .notNull()
      .references(() => botUsersTable.telegramId),
    status: text("status").notNull().default("assigned"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("reward_delivery_user_milestone_idx").on(table.telegramUserId, table.milestoneId)],
);

export const adminsTable = pgTable("admins", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  role: text("role").notNull().default("admin"),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  enabled: boolean("enabled").notNull().default(true),
  ...timestamps,
});

export const botSettingsTable = pgTable("bot_settings", {
  id: integer("id").primaryKey().default(1),
  maintenanceMode: boolean("maintenance_mode").notNull().default(false),
  maintenanceMessage: text("maintenance_message").notNull(),
  referralSystemEnabled: boolean("referral_system_enabled").notNull().default(true),
  disclaimerEnabled: boolean("disclaimer_enabled").notNull().default(true),
  supportBotLink: text("support_bot_link").notNull(),
  supportButtonLabel: text("support_button_label").notNull(),
  ownerTelegramId: bigint("owner_telegram_id", { mode: "number" }).notNull(),
  botUsername: text("bot_username"),
  ...timestamps,
});

export const botContentTable = pgTable("bot_content", {
  id: integer("id").primaryKey().default(1),
  welcomeMessage: text("welcome_message").notNull(),
  maintenanceMessage: text("maintenance_message").notNull(),
  disclaimer: text("disclaimer").notNull(),
  forceSubscribeMessage: text("force_subscribe_message").notNull(),
  supportMessage: text("support_message").notNull(),
  howItWorksMessage: text("how_it_works_message").notNull(),
  rewardMessage: text("reward_message").notNull(),
  successMessage: text("success_message").notNull(),
  errorMessage: text("error_message").notNull(),
  ...timestamps,
});

export const broadcastsTable = pgTable("broadcasts", {
  id: serial("id").primaryKey(),
  contentType: text("content_type").notNull(),
  content: text("content").notNull(),
  buttonText: text("button_text"),
  buttonUrl: text("button_url"),
  preview: boolean("preview").notNull().default(true),
  status: text("status").notNull().default("queued"),
  totalRecipients: integer("total_recipients").notNull().default(0),
  sentCount: integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  ...timestamps,
});

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  action: text("action").notNull(),
  actorTelegramId: bigint("actor_telegram_id", { mode: "number" }).notNull(),
  targetTelegramId: bigint("target_telegram_id", { mode: "number" }),
  detail: text("detail").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertBotUserSchema = createInsertSchema(botUsersTable).omit({
  createdAt: true,
  updatedAt: true,
});
export const insertRewardSchema = createInsertSchema(rewardsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type BotUser = typeof botUsersTable.$inferSelect;
export type Reward = typeof rewardsTable.$inferSelect;
export type InsertBotUser = z.infer<typeof insertBotUserSchema>;
export type InsertReward = z.infer<typeof insertRewardSchema>;