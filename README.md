# Charon Bot

Cloudflare Workers Discord bot using the Discord Interactions API only.

No Discord Gateway, no websocket connection, and no external database.

## Features

- `/request appid:<number>` forwards requests to the configured request channel.
- `/gen appid:<number>` searches the Charon database in order:
  1. Database 1
  2. Database 2
  3. GameGen external API
- Direct `appid.zip` is returned as-is.
- Direct `appid.lua` is zipped in memory as `appid.zip` containing `appid.lua`.
- Supports optional `manifests/` path through `DATABASE_BASE_PATHS`.
- Shows Steam game details in a Discord embed with the game banner, source, AppID, publisher, and release date.
- Moderator/request storage uses a Cloudflare Durable Object.
- Full moderation command set with audit logs.

## Security

Do not commit `DISCORD_TOKEN` to GitHub. Store it as a Cloudflare Worker secret.

The token pasted into any chat or source code should be regenerated in the Discord Developer Portal before deploy.

## Install

```bash
npm install
```

## Cloudflare setup

```bash
wrangler login
wrangler secret put DISCORD_TOKEN
```

Paste your Discord bot token when prompted.

`wrangler.toml` already contains non-secret config:

- `DISCORD_PUBLIC_KEY`
- `DISCORD_APPLICATION_ID`
- `REQUEST_CHANNEL`
- `MOD_LOG_CHANNEL`
- database URLs
- GameGen API URL

## Register slash commands

Set local env vars before running:

PowerShell:

```powershell
$env:DISCORD_TOKEN="your_rotated_discord_token"
$env:DISCORD_APPLICATION_ID="947389898531430421"
npm run register
```

Register to one guild for instant testing:

```powershell
$env:DISCORD_GUILD_ID="your_guild_id"
npm run register
```

Without `DISCORD_GUILD_ID`, commands are registered globally and can take time to appear.

## Deploy

```bash
wrangler deploy
```

After deploy, copy the Worker URL into Discord Developer Portal:

```text
Interactions Endpoint URL:
https://your-worker.your-subdomain.workers.dev/
```

## Local development

```bash
wrangler dev
```

Use a tunnel URL if testing Discord interactions locally.

## Commands

Public:

- `/request appid:<number>`
- `/gen appid:<number>`

Moderator:

- `/mod add userid:<id>`
- `/mod remove userid:<id>`
- `/mod list`
- `/requests`
- `/request-delete appid:<number>`
- `/announce message:<text>`

Moderation:

- `/kick user:<member> reason:<optional>`
- `/ban user:<member> reason:<optional> days:<0-7>`
- `/unban userid:<id>`
- `/mute user:<member> duration:<minutes> reason:<optional>`
- `/unmute user:<member>`
- `/warn user:<member> reason:<required>`
- `/warnings user:<member>`
- `/clearwarns user:<member>`
- `/purge amount:<1-100>`
- `/slowmode seconds:<0-21600>`
- `/lock`
- `/unlock`
- `/nick user:<member> nickname:<text>`
- `/userinfo user:<member>`
- `/serverinfo`
- `/modlogs`
