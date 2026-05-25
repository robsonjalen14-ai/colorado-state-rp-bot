import { DISCORD_API } from "./utils.js";

const DEFAULT_APPLICATION_ID = "947389898531430421";

const TYPE = {
  SUB_COMMAND: 1,
  STRING: 3,
  INTEGER: 4,
  BOOLEAN: 5,
  USER: 6,
  CHANNEL: 7,
  ROLE: 8
};

const appIdOption = {
  name: "appid",
  description: "Steam App ID",
  type: TYPE.INTEGER,
  required: true,
  min_value: 1
};

const userOption = {
  name: "user",
  description: "Target user",
  type: TYPE.USER,
  required: true
};

const roleOption = {
  name: "role",
  description: "Target role",
  type: TYPE.ROLE,
  required: true
};

const channelOption = {
  name: "channel",
  description: "Target channel",
  type: TYPE.CHANNEL,
  required: true
};

const reasonOptional = {
  name: "reason",
  description: "Reason",
  type: TYPE.STRING,
  required: false,
  max_length: 500
};

const amountOption = {
  name: "amount",
  description: "Amount from 1 to 100",
  type: TYPE.INTEGER,
  required: true,
  min_value: 1,
  max_value: 100
};

const durationOption = {
  name: "duration",
  description: "Duration in minutes",
  type: TYPE.INTEGER,
  required: true,
  min_value: 1,
  max_value: 40320
};

const modeOption = {
  name: "mode",
  description: "Mode",
  type: TYPE.STRING,
  required: true,
  choices: [
    { name: "enable", value: "enable" },
    { name: "disable", value: "disable" },
    { name: "status", value: "status" }
  ]
};

const formatOption = {
  name: "format",
  description: "Send as plain text or embed",
  type: TYPE.STRING,
  required: true,
  choices: [
    { name: "Normal message", value: "normal" },
    { name: "Embed", value: "embed" }
  ]
};

const pingOption = {
  name: "ping",
  description: "Allow pings in the sent message",
  type: TYPE.BOOLEAN,
  required: false
};

const priorityOption = {
  name: "level",
  description: "Ticket priority",
  type: TYPE.STRING,
  required: true,
  choices: [
    { name: "Low", value: "low" },
    { name: "Medium", value: "medium" },
    { name: "High", value: "high" }
  ]
};

function sub(name, description, options = []) {
  return { name, description, type: TYPE.SUB_COMMAND, options };
}

function textOption(name, description, required = true, maxLength = 1000) {
  return { name, description, type: TYPE.STRING, required, max_length: maxLength };
}

export const COMMANDS = [
  {
    name: "request",
    description: "Submit a Charon AppID request",
    options: [appIdOption]
  },
  {
    name: "gen",
    description: "Generate a Charon ZIP for a Steam App ID",
    options: [appIdOption]
  },
  {
    name: "website",
    description: "Open the official Charon website"
  },
  {
    name: "help",
    description: "Show Charon bot command help"
  },
  {
    name: "botstatus",
    description: "Show Charon bot health"
  },
  {
    name: "ping",
    description: "View bot latency"
  },
  {
    name: "poll",
    description: "Create a simple reaction poll",
    options: [
      textOption("question", "Poll question", true, 300),
      textOption("option1", "First option", true, 100),
      textOption("option2", "Second option", true, 100),
      textOption("option3", "Third option", false, 100),
      textOption("option4", "Fourth option", false, 100)
    ]
  },
  {
    name: "admin",
    description: "Charon bot administration",
    options: [
      sub("add", "Add a stored moderator", [textOption("userid", "Discord user ID")]),
      sub("remove", "Remove a stored moderator", [textOption("userid", "Discord user ID")]),
      sub("list", "List stored moderators"),
      sub("transfer", "Transfer bot admin ownership", [textOption("userid", "Discord user ID")]),
      sub("permissions", "Show admin permission model"),
      sub("logs", "Show recent admin actions"),
      sub("manifest", "Check whether an AppID exists in Charon or the external API", [appIdOption])
    ]
  },
  {
    name: "setticket",
    description: "Create the premium ticket panel"
  },
  {
    name: "ticket",
    description: "Manage support tickets",
    options: [
      sub("panel", "Create the premium ticket panel"),
      sub("claim", "Claim the current ticket"),
      sub("unclaim", "Unclaim the current ticket"),
      sub("close", "Close the current ticket"),
      sub("reopen", "Reopen the current ticket"),
      sub("delete", "Delete the current ticket"),
      sub("rename", "Rename the current ticket", [textOption("name", "New channel name", true, 90)]),
      sub("priority", "Set ticket priority", [priorityOption]),
      sub("move", "Move ticket to another category", [{ name: "category", description: "Target category channel ID", type: TYPE.STRING, required: true }]),
      sub("transfer", "Transfer ticket ownership", [userOption]),
      sub("transcript", "Export a ticket transcript"),
      sub("notes", "Add or view internal ticket notes", [textOption("note", "Internal note text", false, 1000)])
    ]
  },
  {
    name: "requests",
    description: "View latest AppID requests"
  },
  {
    name: "request-delete",
    description: "Delete request entries for an AppID",
    options: [appIdOption]
  },
  {
    name: "announce",
    description: "Send an announcement to the request channel",
    options: [
      textOption("message", "Announcement text", true, 1800),
      formatOption,
      pingOption,
      textOption("image", "Optional image URL for embeds", false, 500)
    ]
  },
  {
    name: "publish",
    description: "Publish a message to a channel",
    options: [channelOption, textOption("message", "Message", true, 1800), formatOption, pingOption, textOption("image", "Optional image URL for embeds", false, 500)]
  },
  {
    name: "embed",
    description: "Send a clean custom embed",
    options: [channelOption, textOption("message", "Embed text", true, 1800), textOption("title", "Optional title", false, 200), pingOption, textOption("image", "Optional image URL", false, 500)]
  },
  {
    name: "kick",
    description: "Kick a member",
    options: [userOption, reasonOptional]
  },
  {
    name: "ban",
    description: "Ban a member",
    options: [
      userOption,
      reasonOptional,
      { name: "days", description: "Message delete days, 0-7", type: TYPE.INTEGER, required: false, min_value: 0, max_value: 7 }
    ]
  },
  {
    name: "tempban",
    description: "Temporarily ban a member",
    options: [userOption, durationOption, reasonOptional]
  },
  {
    name: "unban",
    description: "Unban a user ID",
    options: [textOption("userid", "Discord user ID"), reasonOptional]
  },
  {
    name: "softban",
    description: "Ban and immediately unban to clear recent messages",
    options: [
      userOption,
      reasonOptional,
      { name: "days", description: "Message delete days, 0-7", type: TYPE.INTEGER, required: false, min_value: 0, max_value: 7 }
    ]
  },
  {
    name: "mute",
    description: "Timeout a member",
    options: [userOption, durationOption, reasonOptional]
  },
  {
    name: "unmute",
    description: "Remove timeout from a member",
    options: [userOption]
  },
  {
    name: "timeout",
    description: "Timeout a member",
    options: [userOption, durationOption, reasonOptional]
  },
  {
    name: "untimeout",
    description: "Remove timeout from a member",
    options: [userOption]
  },
  {
    name: "warn",
    description: "Warn a member",
    options: [userOption, textOption("reason", "Warning reason", true, 500)]
  },
  {
    name: "warnings",
    description: "Show warnings for a member",
    options: [userOption]
  },
  {
    name: "clearwarns",
    description: "Clear warnings for a member",
    options: [userOption]
  },
  {
    name: "note",
    description: "Add a private moderation note",
    options: [userOption, textOption("note", "Note text", true, 1000)]
  },
  {
    name: "cases",
    description: "Show warnings and notes for a member",
    options: [userOption]
  },
  {
    name: "modlogs",
    description: "Show recent moderation logs",
    options: [{ name: "user", description: "Optional target user", type: TYPE.USER, required: false }]
  },
  {
    name: "purge",
    description: "Bulk delete recent messages",
    options: [
      sub("recent", "Delete recent messages", [amountOption]),
      sub("user", "Delete recent messages from a user", [userOption, amountOption]),
      sub("bots", "Delete recent bot messages", [amountOption]),
      sub("embeds", "Delete recent messages with embeds", [amountOption]),
      sub("links", "Delete recent messages with links", [amountOption]),
      sub("attachments", "Delete recent messages with attachments", [amountOption])
    ]
  },
  {
    name: "clean",
    description: "Clean recent messages",
    options: [{ ...amountOption, required: false }]
  },
  {
    name: "nuke",
    description: "Clone and delete the current channel",
    options: [textOption("confirm", "Type NUCLEAR to confirm", true, 20)]
  },
  {
    name: "lock",
    description: "Lock the current channel"
  },
  {
    name: "unlock",
    description: "Unlock the current channel"
  },
  {
    name: "slowmode",
    description: "Set channel slowmode",
    options: [{ name: "seconds", description: "Seconds from 0 to 21600", type: TYPE.INTEGER, required: true, min_value: 0, max_value: 21600 }]
  },
  {
    name: "sticky",
    description: "Manage a stored sticky message",
    options: [
      sub("set", "Set sticky message for this channel", [textOption("message", "Sticky message", true, 1800)]),
      sub("clear", "Clear sticky message for this channel"),
      sub("show", "Show sticky config for this channel")
    ]
  },
  {
    name: "automod",
    description: "Manage stored automod config",
    options: [
      sub("enable", "Enable automod"),
      sub("disable", "Disable automod"),
      sub("config", "Show automod config")
    ]
  },
  ...["antispam", "antilink", "antiinvite", "antiscam", "antiraid", "antiemoji", "antimention", "antibot"].map((name) => ({
    name,
    description: `Configure ${name}`,
    options: [modeOption]
  })),
  {
    name: "wordfilter",
    description: "Manage filtered words",
    options: [
      sub("add", "Add a filtered word", [textOption("word", "Word or phrase", true, 100)]),
      sub("remove", "Remove a filtered word", [textOption("word", "Word or phrase", true, 100)]),
      sub("list", "List filtered words")
    ]
  },
  {
    name: "whitelist",
    description: "Manage whitelist entries",
    options: [
      sub("add", "Add an entry", [textOption("target", "Role/user/channel ID or pattern", true, 100)]),
      sub("remove", "Remove an entry", [textOption("target", "Role/user/channel ID or pattern", true, 100)]),
      sub("list", "List entries")
    ]
  },
  {
    name: "blacklist",
    description: "Manage blacklist entries",
    options: [
      sub("add", "Add an entry", [textOption("target", "Role/user/channel ID or pattern", true, 100)]),
      sub("remove", "Remove an entry", [textOption("target", "Role/user/channel ID or pattern", true, 100)]),
      sub("list", "List entries")
    ]
  },
  {
    name: "role",
    description: "Manage roles",
    options: [
      sub("add", "Add a role to a member", [userOption, roleOption]),
      sub("remove", "Remove a role from a member", [userOption, roleOption]),
      sub("create", "Create a role", [textOption("name", "Role name", true, 100), textOption("color", "Hex color, example #8b5cf6", false, 20)]),
      sub("delete", "Delete a role", [roleOption]),
      sub("edit", "Edit a role", [roleOption, textOption("name", "New role name", false, 100), textOption("color", "Hex color", false, 20)])
    ]
  },
  {
    name: "autorole",
    description: "Manage stored autorole config",
    options: [
      sub("set", "Set autorole", [roleOption]),
      sub("clear", "Clear autorole"),
      sub("show", "Show autorole")
    ]
  },
  {
    name: "reactionrole",
    description: "Manage stored reaction-role config",
    options: [
      sub("set", "Store reaction role mapping", [textOption("messageid", "Message ID"), textOption("emoji", "Emoji"), roleOption]),
      sub("remove", "Remove reaction role mapping", [textOption("messageid", "Message ID"), textOption("emoji", "Emoji")]),
      sub("list", "List reaction role mappings")
    ]
  },
  {
    name: "selfrole",
    description: "Give or remove a role from yourself",
    options: [
      sub("add", "Add a self role", [roleOption]),
      sub("remove", "Remove a self role", [roleOption])
    ]
  },
  {
    name: "temprole",
    description: "Temporarily add a role to a member",
    options: [userOption, roleOption, durationOption, reasonOptional]
  },
  {
    name: "roleall",
    description: "Add a role to all fetched members",
    options: [roleOption]
  },
  {
    name: "msg",
    description: "Send a DM to a user",
    options: [userOption, textOption("message", "Message", true, 1800)]
  },
  {
    name: "send",
    description: "Send a message through the bot",
    options: [
      sub("msg", "Send a message to a channel", [
        channelOption,
        textOption("message", "Message", true, 1800),
        formatOption,
        pingOption
      ])
    ]
  },
  {
    name: "nick",
    description: "Change a member nickname",
    options: [userOption, textOption("nickname", "New nickname", true, 32)]
  },
  {
    name: "userinfo",
    description: "Show member information",
    options: [userOption]
  },
  {
    name: "serverinfo",
    description: "Show server information"
  },
  {
    name: "avatar",
    description: "Show a user avatar",
    options: [{ ...userOption, required: false }]
  },
  {
    name: "banner",
    description: "Show a user banner",
    options: [{ ...userOption, required: false }]
  },
  {
    name: "channelinfo",
    description: "Show channel information",
    options: [{ ...channelOption, required: false }]
  },
  {
    name: "inviteinfo",
    description: "Show invite information",
    options: [textOption("code", "Invite code or URL", true, 200)]
  },
  {
    name: "pin",
    description: "Pin a message",
    options: [textOption("messageid", "Message ID")]
  },
  {
    name: "unpin",
    description: "Unpin a message",
    options: [textOption("messageid", "Message ID")]
  },
  {
    name: "quote",
    description: "Quote a message by ID",
    options: [textOption("messageid", "Message ID")]
  },
  {
    name: "archive",
    description: "Export recent channel messages to the log channel",
    options: [{ ...amountOption, required: false }]
  },
  {
    name: "welcome",
    description: "Configure welcome messages",
    options: [
      sub("setup", "Save welcome settings", [channelOption, textOption("message", "Welcome message", true, 1000)]),
      sub("preview", "Preview welcome message"),
      sub("disable", "Disable welcome config")
    ]
  },
  {
    name: "mail",
    description: "Send and manage private server mail",
    options: [
      sub("send", "Send server mail to a user", [userOption, textOption("message", "Mail message", true, 1500)]),
      sub("inbox", "View your inbox"),
      sub("delete", "Delete one inbox item", [textOption("id", "Mail ID")])
    ]
  },
  {
    name: "selfroles",
    description: "Manage self role panels",
    options: [
      sub("panel", "Create a self role panel", [roleOption, textOption("label", "Button label", false, 80)]),
      sub("list", "List configured self roles")
    ]
  },
  {
    name: "vote",
    description: "Create a yes/no vote",
    options: [textOption("question", "Vote question", true, 300)]
  },
  {
    name: "giveaway",
    description: "Manage giveaways",
    options: [
      sub("start", "Start a button-entry giveaway", [textOption("prize", "Prize", true, 300)]),
      sub("reroll", "Reroll a stored giveaway", [textOption("messageid", "Giveaway message ID")])
    ]
  },
  {
    name: "feedback",
    description: "Send private feedback to staff",
    options: [textOption("message", "Feedback", true, 1000)]
  },
  {
    name: "suggest",
    description: "Send a community suggestion",
    options: [textOption("message", "Suggestion", true, 1000)]
  },
  {
    name: "bug",
    description: "Report a bug",
    options: [textOption("message", "Bug report", true, 1000)]
  },
  {
    name: "report",
    description: "Create a report ticket",
    options: [textOption("message", "Report details", true, 1000)]
  },
  {
    name: "appeal",
    description: "Create an appeal ticket",
    options: [textOption("message", "Appeal details", true, 1000)]
  },
  {
    name: "backup",
    description: "Manage bot configuration backups",
    options: [
      sub("create", "Create a settings backup"),
      sub("list", "List backups"),
      sub("restore", "Restore a backup", [textOption("id", "Backup ID")])
    ]
  },
  {
    name: "logs",
    description: "Show recent bot logs"
  },
  {
    name: "history",
    description: "Show recent ticket history"
  },
  {
    name: "search",
    description: "Search stored bot records",
    options: [
      sub("user", "Search records for a user", [userOption]),
      sub("ticket", "Search a ticket ID", [textOption("id", "Ticket ID")])
    ]
  },
  {
    name: "settings",
    description: "Show bot settings"
  },
  {
    name: "config",
    description: "Show bot configuration summary"
  },
  {
    name: "reset",
    description: "Reset a stored config area",
    options: [textOption("area", "welcome, automod, roleconfig, sticky", true, 50)]
  },
  {
    name: "status",
    description: "Show public bot status"
  }
];

async function putCommands(token, applicationId, route, commands) {
  const response = await fetch(`${DISCORD_API}${route}`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });
  if (!response.ok) {
    throw new Error(`Command registration failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

export async function registerCommands({ token, applicationId, guildId, clearGlobal = true, clearGuildId = "" }) {
  if (!token) throw new Error("DISCORD_TOKEN is required.");
  if (!applicationId) throw new Error("DISCORD_APPLICATION_ID is required.");

  const route = guildId
    ? `/applications/${applicationId}/guilds/${guildId}/commands`
    : `/applications/${applicationId}/commands`;
  const commands = await putCommands(token, applicationId, route, COMMANDS);

  if (guildId && clearGlobal) {
    await putCommands(token, applicationId, `/applications/${applicationId}/commands`, []);
    console.log("Cleared global commands to prevent duplicate command display in this server.");
  }

  if (!guildId && clearGuildId) {
    await putCommands(token, applicationId, `/applications/${applicationId}/guilds/${clearGuildId}/commands`, []);
    console.log(`Cleared guild commands for ${clearGuildId}.`);
  }

  return commands;
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("commands.js")) {
  registerCommands({
    token: process.env.DISCORD_TOKEN,
    applicationId: process.env.DISCORD_APPLICATION_ID || DEFAULT_APPLICATION_ID,
    guildId: process.env.DISCORD_GUILD_ID,
    clearGlobal: process.env.CLEAR_GLOBAL !== "false",
    clearGuildId: process.env.CLEAR_GUILD_ID || ""
  })
    .then((commands) => {
      console.log(`Registered ${commands.length} command(s).`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
