import { and, asc, eq } from "drizzle-orm";
import { db, adminsTable, botContentTable, botSettingsTable, forceChannelsTable, milestonesTable } from "@workspace/db";

export const OWNER_TELEGRAM_ID = 713914937;
export const DEFAULT_SUPPORT_LINK = "https://t.me/Referrsupportt_bot";

const defaults = {
  maintenanceMessage: "The bot is taking a short maintenance break. Please try again soon.",
  welcomeMessage: "Welcome. Complete the quick verification to unlock your referral dashboard.",
  forceSubscribeMessage: "Join every required channel, then tap Check Subscription to continue.",
  disclaimer:
    "⚠️ IMPORTANT WARNING: Rewards are added to the bot in bulk, so occasionally you may receive a duplicate, expired, already-used, invalid, or non-working reward. If you receive only 1–2 such rewards, please do not contact Support, as minor issues can happen during bulk distribution. However, if you repeatedly receive the same issue across multiple rewards, you may contact the Support Bot and an admin will review the situation and assist where possible. By clicking Accept & Continue, you confirm that you understand and accept these terms.",
  supportMessage: "Leave your message on our Support Bot. Our team will respond as soon as possible.",
  howItWorksMessage: "Invite genuinely new users. A referral is counted after subscription verification and disclaimer acceptance.",
  rewardMessage: "Your reward has been unlocked and is ready to claim.",
  successMessage: "Verified. Your access is unlocked.",
  errorMessage: "Something went wrong. Please try again in a moment.",
};

let seedPromise: Promise<void> | null = null;

export function ensureSeeded(): Promise<void> {
  seedPromise ??= (async () => {
    const [settings, content, owner] = await Promise.all([
      db.select({ id: botSettingsTable.id }).from(botSettingsTable).where(eq(botSettingsTable.id, 1)).limit(1),
      db.select({ id: botContentTable.id }).from(botContentTable).where(eq(botContentTable.id, 1)).limit(1),
      db.select({ telegramId: adminsTable.telegramId }).from(adminsTable).where(eq(adminsTable.telegramId, OWNER_TELEGRAM_ID)).limit(1),
    ]);

    if (!settings[0]) {
      await db.insert(botSettingsTable).values({
        id: 1,
        maintenanceMessage: defaults.maintenanceMessage,
        supportBotLink: DEFAULT_SUPPORT_LINK,
        supportButtonLabel: "Contact Support",
        ownerTelegramId: OWNER_TELEGRAM_ID,
      });
    }
    if (!content[0]) {
      await db.insert(botContentTable).values({ id: 1, ...defaults });
    }
    if (!owner[0]) {
      await db.insert(adminsTable).values({
        telegramId: OWNER_TELEGRAM_ID,
        role: "owner",
        permissions: ["*"],
      });
    }

    const milestones = await db.select({ id: milestonesTable.id }).from(milestonesTable).orderBy(asc(milestonesTable.referralTarget)).limit(1);
    if (!milestones[0]) {
      await db.insert(milestonesTable).values([
        { name: "First unlock", referralTarget: 5 },
        { name: "Momentum reward", referralTarget: 10 },
        { name: "Power reward", referralTarget: 20 },
      ]);
    }
  })().catch((error) => {
    seedPromise = null;
    throw error;
  });
  return seedPromise;
}