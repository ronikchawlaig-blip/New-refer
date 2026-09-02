# Telegram Refer & Reward Bot

## Required secure configuration

Add these as Replit Secrets; never paste them into chat or commit them:

- `TELEGRAM_BOT_TOKEN` — token from BotFather
- `NEON_DATABASE_URL` — the rotated Neon pooled connection string
- `SESSION_SECRET` — a long random value for future session integrations

The database package prefers `NEON_DATABASE_URL` and falls back to the provisioned `DATABASE_URL` for local development.

## Start the project

```bash
pnpm install
pnpm --filter @workspace/db run push
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/refer-reward-admin run dev
```

The API starts the Telegram long-polling bot and broadcast worker from the same server process. The admin panel is the `refer-reward-admin` artifact.

## Telegram setup

1. Add the bot to every force-subscribe channel as an administrator with permission to read member status.
2. Add each channel in **Admin → Channels**, including its chat ID and invite link.
3. Add milestone reward inventory in **Admin → Rewards**. Rewards are allocated with a database transaction and can only be delivered once per user and milestone.
4. Set editable bot copy, support link, maintenance mode, and referral settings in **Admin → Content** and **Admin → Settings**.

The user flow is:

1. `/start` creates a Telegram user exactly once and records a referral only when the referral target is a genuinely new user.
2. The user joins every enabled force-subscribe channel.
3. The bot verifies each membership through Telegram before allowing the disclaimer step.
4. Disclaimer acceptance completes the referral once and increments the referrer atomically.
5. The main menu exposes **Refer & Earn**, **My Rewards**, **My Progress**, and **Support**.

## Broadcasts

Use **Admin → Broadcasts → New broadcast** to queue a text, photo, video, animation, or document broadcast. An optional inline CTA button and link preview setting are stored with the broadcast.

The worker:

- sends only to non-banned users;
- processes the queue oldest-first;
- updates total, sent, and failed counts after every recipient;
- retries Telegram rate-limit responses using Telegram's `retry_after`;
- records a failed broadcast instead of silently dropping it.

## Verification

```bash
pnpm run typecheck
curl http://127.0.0.1:8080/api/healthz
```

The admin API is intended to be placed behind Replit's authenticated deployment boundary before public production use. The database and Telegram operations themselves are server-side; secrets are never exposed to the browser.