# Charon Bot

Cloudflare Workers Discord bot using the Discord Interactions API only.

No Discord Gateway, no websocket connection, and no external database.

## Features

- `/request appid:<number>` forwards requests to the configured request channel.
- `/gen appid:<number>` searches the Charon database in order:
  1. Database 1
  2. Database 2
  3. GameGen external API, including direct ZIP fallback with `format=zip`
- Direct `appid.zip` is returned as-is.
- Direct `appid.lua` is zipped in memory as `appid.zip` containing `appid.lua`.
- Supports optional `manifests/` path through `DATABASE_BASE_PATHS`.
- Shows Steam game details in a Discord embed with the game banner, source, AppID, publisher, and release date.
- Sends game requests and moderation logs as embeds to separate configured channels.
- Sends DM notices for moderation/admin actions such as warn, kick, ban, timeout, role changes, nickname changes, and admin add/remove when Discord allows the DM.
- Moderator/request storage uses a Cloudflare Durable Object.
- Moderation, message moderation, stored automod config, and role-management commands with audit logs.

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
npm run register
```

Register to one guild for instant testing:

```powershell
$env:DISCORD_GUILD_ID="your_guild_id"
npm run register
```

When `DISCORD_GUILD_ID` is set, the script registers guild commands and clears global commands by default. This prevents duplicate command display if you previously registered both global and guild commands.

Without `DISCORD_GUILD_ID`, commands are registered globally and can take time to appear. To clear one guild while using global commands:

```powershell
$env:CLEAR_GUILD_ID="your_guild_id"
npm run register
```

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

- `/admin add userid:<id>`
- `/admin remove userid:<id>`
- `/admin list`
- `/admin manifest appid:<number>`
- `/requests`
- `/request-delete appid:<number>`
- `/announce message:<text>`

Moderation:

- `/kick user:<member> reason:<optional>`
- `/ban user:<member> reason:<optional> days:<0-7>`
- `/tempban user:<member> duration:<minutes> reason:<optional>`
- `/unban userid:<id>`
- `/softban user:<member>`
- `/mute user:<member> duration:<minutes> reason:<optional>`
- `/unmute user:<member>`
- `/timeout user:<member> duration:<minutes> reason:<optional>`
- `/untimeout user:<member>`
- `/warn user:<member> reason:<required>`
- `/warnings user:<member>`
- `/clearwarns user:<member>`
- `/note user:<member> note:<text>`
- `/cases user:<member>`
- `/modlogs user:<optional>`

Message moderation:

- `/purge recent amount:<1-100>`
- `/purge user user:<member> amount:<1-100>`
- `/purge bots amount:<1-100>`
- `/purge embeds amount:<1-100>`
- `/purge links amount:<1-100>`
- `/purge attachments amount:<1-100>`
- `/clean amount:<optional>`
- `/nuke confirm:NUCLEAR`
- `/slowmode seconds:<0-21600>`
- `/lock`
- `/unlock`
- `/sticky set|clear|show`

Automod config:

- `/automod enable|disable|config`
- `/antispam mode:<enable|disable|status>`
- `/antilink mode:<enable|disable|status>`
- `/antiinvite mode:<enable|disable|status>`
- `/antiscam mode:<enable|disable|status>`
- `/antiraid mode:<enable|disable|status>`
- `/antiemoji mode:<enable|disable|status>`
- `/antimention mode:<enable|disable|status>`
- `/antibot mode:<enable|disable|status>`
- `/wordfilter add|remove|list`
- `/whitelist add|remove|list`
- `/blacklist add|remove|list`

Role management:

- `/role add|remove|create|delete|edit`
- `/autorole set|clear|show`
- `/reactionrole set|remove|list`
- `/selfrole add|remove`
- `/temprole user:<member> role:<role> duration:<minutes>`
- `/roleall role:<role>`
- `/msg user:<member> message:<text>`
- `/send msg channel:<channel> message:<text>`
- `/nick user:<member> nickname:<text>`
- `/userinfo user:<member>`
- `/serverinfo`

Automod, autorole, reaction-role, and sticky settings are stored in the Worker Durable Object. Since this bot intentionally uses Interactions API only and no Gateway, real-time message/member-event enforcement requires Discord-native rules or a Gateway/event source.
