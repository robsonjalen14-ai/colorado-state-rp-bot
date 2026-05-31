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
- Direct `appid.lua` is zipped in memory as `appid.zip`; when possible the bot also parses the Lua, resolves required depot manifests, and adds found `.manifest` files under `/manifests/`.
- Supports optional `manifests/` path through `DATABASE_BASE_PATHS`.
- Shows Steam game details in a single premium Discord embed with the game banner, source, AppID, publisher, release date, and a dynamic artwork-based accent color.
- Shows a polished no-results embed with the `/request` follow-up when no package is available.
- `/website` opens the official Charon website.
- Tickety-style support tickets with `/setticket`, category selection, modal descriptions, private channels, claim/close/reopen/delete buttons, user picker add, transcripts, and ticket logs.
- Ticket staff permissions use stored bot admins from `/admin add`; no Discord staff role is required.
- `/gen appid` supports Steam game-name autocomplete while preserving numeric AppID generation.
- `/request` checks Charon repositories before creating a request, then supports direct-URL upload and 60-second chat attachment upload publishing to both database folders.
- `/fix` creates repair jobs that replace existing AppID ZIP/LUA variants in both database folders.
- Request/fix workflow supports queue, claim, unclaim, cancel, status, history, stats, polished upload logs, and game-added announcements.
- Utility commands for pings, publishing, embeds, welcome config, self-role panels, mail, suggestions, reports, appeals, backups, and server/message tools.
- Sends game requests and moderation logs as embeds to separate configured channels.
- Sends DM notices for moderation/admin actions such as warn, kick, ban, timeout, role changes, nickname changes, and admin add/remove when Discord allows the DM.
- If GameGen blocks Cloudflare Worker downloads, `/gen` still shows `Used External API` with a direct Download ZIP button instead of saying no files were found.
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
wrangler secret put GITHUB_TOKEN
```

Paste your Discord bot token when prompted.
Paste a GitHub token with `repo` access for `GITHUB_TOKEN`; it is required for `/request` and `/fix` publishing.

`wrangler.toml` already contains non-secret config:

- `DISCORD_PUBLIC_KEY`
- `DISCORD_APPLICATION_ID`
- `REQUEST_CHANNEL`
- `MOD_LOG_CHANNEL`
- `TICKET_LOG_CHANNEL`
- `TICKET_CATEGORY_ID`
- database URLs
- GameGen API URL
- GitHub owner/repo/branch for Charon Database
- `CHAT_UPLOAD_MAX_BYTES` for the temporary chat upload size limit

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
- `/fix appid:<number>`
- `/website`
- `/help`
- `/botstatus`
- `/ping`
- `/status`
- `/history appid:<number>`
- `/cancel appid:<number>`
- `/stats`
- `/avatar`
- `/banner`
- `/channelinfo`
- `/serverinfo`
- `/vote`
- `/feedback`
- `/suggest`
- `/bug`
- `/report`
- `/appeal`

Moderator:

- `/admin add userid:<id>`
- `/admin remove userid:<id>`
- `/admin list`
- `/admin transfer userid:<id>`
- `/admin permissions`
- `/admin logs`
- `/admin manifest appid:<number>`
- `/setticket`
- `/ticket panel|claim|unclaim|close|reopen|rename|priority|move|transfer|transcript|notes|delete`
- `/requests`
- `/request-delete appid:<number>`
- `/claim id:<request_or_fix_id>`
- `/unclaim id:<request_or_fix_id>`
- `/queue`
- `/announce message:<text>`
- `/publish`
- `/embed`
- `/welcome setup|preview|disable`
- `/mail send|inbox|delete`
- `/mail channel`
- `/selfroles panel|list`
- `/backup create|restore|list`
- `/logs`
- `/history`
- `/search user|ticket`
- `/settings`
- `/config`
- `/reset`

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
- `/poll question:<text> option1:<text> option2:<text> option3:<optional> option4:<optional>`
- `/nick user:<member> nickname:<text>`
- `/userinfo user:<member>`
- `/serverinfo`

Automod, autorole, reaction-role, and sticky settings are stored in the Worker Durable Object. Since this bot intentionally uses Interactions API only and no Gateway, real-time message/member-event enforcement requires Discord-native rules or a Gateway/event source.
