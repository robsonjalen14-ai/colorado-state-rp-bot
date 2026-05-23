import { DISCORD_API } from "./utils.js";

const TYPE = {
  SUB_COMMAND: 1,
  STRING: 3,
  INTEGER: 4,
  USER: 6
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

const reasonOptional = {
  name: "reason",
  description: "Reason",
  type: TYPE.STRING,
  required: false
};

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
    name: "mod",
    description: "Manage stored Charon bot moderators",
    options: [
      {
        name: "add",
        description: "Add a stored moderator",
        type: TYPE.SUB_COMMAND,
        options: [{ name: "userid", description: "Discord user ID", type: TYPE.STRING, required: true }]
      },
      {
        name: "remove",
        description: "Remove a stored moderator",
        type: TYPE.SUB_COMMAND,
        options: [{ name: "userid", description: "Discord user ID", type: TYPE.STRING, required: true }]
      },
      {
        name: "list",
        description: "List stored moderators",
        type: TYPE.SUB_COMMAND
      }
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
    options: [{ name: "message", description: "Announcement text", type: TYPE.STRING, required: true }]
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
    name: "unban",
    description: "Unban a user ID",
    options: [{ name: "userid", description: "Discord user ID", type: TYPE.STRING, required: true }]
  },
  {
    name: "mute",
    description: "Timeout a member",
    options: [
      userOption,
      { name: "duration", description: "Duration in minutes", type: TYPE.INTEGER, required: true, min_value: 1, max_value: 40320 },
      reasonOptional
    ]
  },
  {
    name: "unmute",
    description: "Remove timeout from a member",
    options: [userOption]
  },
  {
    name: "warn",
    description: "Warn a member",
    options: [
      userOption,
      { name: "reason", description: "Warning reason", type: TYPE.STRING, required: true }
    ]
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
    name: "purge",
    description: "Bulk delete recent messages",
    options: [{ name: "amount", description: "Amount from 1 to 100", type: TYPE.INTEGER, required: true, min_value: 1, max_value: 100 }]
  },
  {
    name: "slowmode",
    description: "Set channel slowmode",
    options: [{ name: "seconds", description: "Seconds from 0 to 21600", type: TYPE.INTEGER, required: true, min_value: 0, max_value: 21600 }]
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
    name: "nick",
    description: "Change a member nickname",
    options: [
      userOption,
      { name: "nickname", description: "New nickname", type: TYPE.STRING, required: true, max_length: 32 }
    ]
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
    name: "modlogs",
    description: "Show recent moderation logs"
  }
];

export async function registerCommands({ token, applicationId, guildId }) {
  if (!token) throw new Error("DISCORD_TOKEN is required.");
  if (!applicationId) throw new Error("DISCORD_APPLICATION_ID is required.");
  const route = guildId
    ? `/applications/${applicationId}/guilds/${guildId}/commands`
    : `/applications/${applicationId}/commands`;
  const response = await fetch(`${DISCORD_API}${route}`, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(COMMANDS)
  });
  if (!response.ok) {
    throw new Error(`Command registration failed: HTTP ${response.status} ${await response.text()}`);
  }
  return response.json();
}

if (typeof process !== "undefined" && process.argv[1]?.endsWith("commands.js")) {
  registerCommands({
    token: process.env.DISCORD_TOKEN,
    applicationId: process.env.DISCORD_APPLICATION_ID,
    guildId: process.env.DISCORD_GUILD_ID
  })
    .then((commands) => {
      console.log(`Registered ${commands.length} command(s).`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
