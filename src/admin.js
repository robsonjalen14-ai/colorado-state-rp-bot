import { discordApi, requireModerator } from "./discord.js";
import { getOption, getOptionValue, storageCall } from "./utils.js";

const BRAND = { green: 0x2ecc71, orange: 0xe67e22, cyan: 0x00bcd4, red: 0xe74c3c, colors: { success: 0x2ecc71, info: 0x00bcd4, error: 0xe74c3c } };

async function getStored(env, key, fallback) {
  try { const d = await storageCall(env, "get", { key, fallback }); return d.value ?? fallback; }
  catch { return fallback; }
}

async function putStored(env, key, value) { await storageCall(env, "put", { key, value }); }

async function addLegacyModerator(env, userId) {
  const moderators = await getStored(env, "moderators", []);
  const list = Array.isArray(moderators) ? moderators.map(String) : [];
  if (!list.includes(String(userId))) {
    list.push(String(userId));
    await putStored(env, "moderators", list);
  }
}

async function removeLegacyModerator(env, userId) {
  const moderators = await getStored(env, "moderators", []);
  const list = Array.isArray(moderators) ? moderators.map(String).filter((id) => id !== String(userId)) : [];
  await putStored(env, "moderators", list);
}

function createEmbed(o) { return { title: o.title, description: o.description, color: o.color }; }
function messageEmbed(t, d, c) { return { title: t, description: d, color: c }; }

function adminMembersKey(g) { return "admin-members:" + g; }
function adminLogsKey(g) { return "admin-logs:" + g; }
function adminRoleKey(g) { return "admin-role:" + g; }

function getUser(i) { return i.member?.user || i.user; }

async function getAdminOwner(env) { return await getStored(env, "adminOwner", null); }

async function requireOwner(env, interaction) {
  var actor = getUser(interaction);
  var ownerId = await getAdminOwner(env);
  if (ownerId) {
    if (actor.id !== ownerId) throw new Error("Only the bot owner can use this command.");
    return;
  }
  var guild = await discordApi(env, "/guilds/" + interaction.guild_id);
  if (actor.id !== guild.owner_id) throw new Error("Only the guild owner can set the first bot owner.");
  await putStored(env, "adminOwner", actor.id);
}

async function getAdminLevel(env, interaction) {
  var actor = getUser(interaction);
  var ownerId = await getAdminOwner(env);
  if (ownerId && actor.id === ownerId) return 10;
  var guild = await discordApi(env, "/guilds/" + interaction.guild_id);
  if (actor.id === guild.owner_id) return 9;
  var members = await getStored(env, adminMembersKey(interaction.guild_id), []);
  for (var i = 0; i < members.length; i++) {
    if (members[i].userId === actor.id) return 3;
  }
  return 0;
}

async function requireAdminLevel(env, interaction, minLevel) {
  var level = await getAdminLevel(env, interaction);
  if (level < minLevel) throw new Error("You need admin level " + minLevel + " to use this command.");
  return level;
}


function getInteractionOptions(interaction) {
  var opts = interaction.data.options || [];
  var sub = opts.find(function(o) { return o.type === 1; });
  return sub ? (sub.options || []) : opts;
}
async function logAction(env, guildId, actorId, action, targetId, reason) {
  var logs = await getStored(env, adminLogsKey(guildId), []);
  logs.unshift({ action, actor: actorId, target: targetId || null, reason: reason || null, timestamp: new Date().toISOString() });
  if (logs.length > 100) logs = logs.slice(0, 100);
  await putStored(env, adminLogsKey(guildId), logs);
}

// ========== HANDLERS ==========

export async function handleAdminRoleSet(env, interaction) {
  await requireOwner(env, interaction);
  var roleId = String(getOption(getInteractionOptions(interaction), "role") || "").replace(/[<@&>]/g, "").trim();
  if (!roleId || !/^\d{15,25}$/.test(roleId)) throw new Error("Invalid role.");
  await putStored(env, adminRoleKey(interaction.guild_id), roleId);
  return { embeds: [createEmbed({ title: "Admin Role Set", description: "Admin role has been set to <@&" + roleId + ">.", color: BRAND.colors.success })] };
}

export async function handleAdminAdd(env, interaction) {
  await requireModerator(env, interaction);
  var userId = String(getOption(getInteractionOptions(interaction), "user") || "").replace(/[<@!>]/g, "").trim();
  var reason = String(getOption(getInteractionOptions(interaction), "reason") || "").trim();
  if (!userId || !/^\d{15,25}$/.test(userId)) throw new Error("Invalid user.");
  var g = interaction.guild_id;
  var actor = getUser(interaction);
  if (actor.id === userId) throw new Error("You cannot add yourself.");
  var roleId = await getStored(env, adminRoleKey(g), null);
  if (!roleId) throw new Error("No admin role has been set. Use /admin role set first.");
  var members = await getStored(env, adminMembersKey(g), []);
  for (var i = 0; i < members.length; i++) {
    if (members[i].userId === userId) throw new Error("User is already an admin.");
  }
  var userData = await discordApi(env, "/users/" + userId);
  if (userData.bot) throw new Error("Bots cannot be admins.");
  await discordApi(env, "/guilds/" + g + "/members/" + userId + "/roles/" + roleId, { method: "PUT" });
  members.push({ userId, addedBy: actor.id, addedAt: new Date().toISOString(), roleId });
  await putStored(env, adminMembersKey(g), members);
  await addLegacyModerator(env, userId);
  await logAction(env, g, actor.id, "admin_add", userId, reason);
  var desc = "<@" + userId + "> has been added as a bot admin." + (reason ? "\nReason: " + reason : "");
  return { embeds: [messageEmbed("\u2705 Admin Added", desc, BRAND.colors.success)] };
}

export async function handleAdminRemove(env, interaction) {
  await requireAdminLevel(env, interaction, 2);
  var userId = String(getOption(getInteractionOptions(interaction), "user") || "").replace(/[<@!>]/g, "").trim();
  if (!userId || !/^\d{15,25}$/.test(userId)) throw new Error("Invalid user.");
  var g = interaction.guild_id;
  var actor = getUser(interaction);
  if (actor.id === userId) throw new Error("You cannot remove yourself.");
  var ownerId = await getAdminOwner(env);
  if (userId === ownerId) throw new Error("You cannot remove the bot owner.");
  var members = await getStored(env, adminMembersKey(g), []);
  var target = null; var idx = -1;
  for (var i = 0; i < members.length; i++) {
    if (members[i].userId === userId) { target = members[i]; idx = i; break; }
  }
  if (!target) throw new Error("That user is not an admin.");
  if (target.roleId) {
    await discordApi(env, "/guilds/" + g + "/members/" + userId + "/roles/" + target.roleId, { method: "DELETE" });
  }
  members.splice(idx, 1);
  await putStored(env, adminMembersKey(g), members);
  await removeLegacyModerator(env, userId);
  await logAction(env, g, actor.id, "admin_remove", userId, null);
  var desc = "<@" + userId + "> has been removed as a bot admin.";
  return { embeds: [messageEmbed("\uD83D\uDDD1\uFE0F Admin Removed", desc, BRAND.colors.info)] };
}

export async function handleAdminList(env, interaction) {
  await requireModerator(env, interaction);
  var g = interaction.guild_id;
  var ownerId = await getAdminOwner(env);
  var members = await getStored(env, adminMembersKey(g), []);
  var roleId = await getStored(env, adminRoleKey(g), null);
  var desc = "";
  if (ownerId) {
    desc += "\n\uD83D\uDC51 **Owner**\n<@" + ownerId + ">\n";
  }
  if (roleId) {
    desc += "\n<@&" + roleId + ">\n";
  }
  if (members.length === 0) {
    desc += "No bot admins have been added yet.";
  } else {
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      var added = m.addedAt ? new Date(m.addedAt).toLocaleDateString() : "unknown";
      desc += "\n<@" + m.userId + "> (added " + added + ")";
    }
  }
  return { embeds: [messageEmbed("\uD83D\uDC51 Bot Admins", desc.trim(), BRAND.colors.info)] };
}

export async function handleAdminTransfer(env, interaction) {
  await requireOwner(env, interaction);
  var userId = String(getOption(getInteractionOptions(interaction), "user") || "").replace(/[<@!>]/g, "").trim();
  if (!userId || !/^\d{15,25}$/.test(userId)) throw new Error("Invalid user.");
  var actor = getUser(interaction);
  if (actor.id === userId) throw new Error("You cannot transfer to yourself.");
  await putStored(env, "adminOwner", userId);
  await logAction(env, interaction.guild_id, actor.id, "transfer", userId, null);
  return { embeds: [messageEmbed("\uD83D\uDC51 Ownership Transferred", "Bot admin ownership has been transferred to <@" + userId + ">.", BRAND.colors.success)] };
}

export async function handleAdminLogs(env, interaction) {
  await requireModerator(env, interaction);
  var logs = await getStored(env, adminLogsKey(interaction.guild_id), []);
  if (logs.length === 0) {
    return { embeds: [messageEmbed("\uD83D\uDCCB Admin Logs", "No admin actions have been logged yet.", BRAND.colors.info)] };
  }
  var desc = "";
  for (var i = 0; i < Math.min(logs.length, 10); i++) {
    var log = logs[i];
    var date = log.timestamp ? new Date(log.timestamp).toLocaleDateString() : "unknown";
    desc += "\n**" + log.action + "** by <@" + log.actor + ">";
    if (log.target) desc += " on <@" + log.target + ">";
    if (log.reason) desc += " (" + log.reason + ")";
    desc += " - " + date;
  }
  return { embeds: [messageEmbed("\uD83D\uDCCB Admin Logs (Last 10)", desc.trim(), BRAND.colors.info)] };
}

export async function handleAdminPermissions(env, interaction) {
  await requireModerator(env, interaction);
  var ownerId = await getAdminOwner(env);
  var roleId = await getStored(env, adminRoleKey(interaction.guild_id), null);
  var desc = "**Permission Levels:**\n";
  desc += "\n\uD83D\uDC51 **Owner (Level 10)** - Full access to all admin commands";
  desc += "\n\uD83D\uDEE1\uFE0F **Admin (Level 3)** - Add/remove/list admins";
  desc += "\n\uD83D\uDD30 **Moderator** - Can view admin list and logs";
  if (ownerId) desc += "\n\n**Current Owner:** <@" + ownerId + ">";
  if (roleId) desc += "\n**Admin Role:** <@&" + roleId + ">";
  return { embeds: [messageEmbed("\uD83D\uDCCB Admin Permissions", desc.trim(), BRAND.colors.info)] };
}

export async function handleAdminAutocomplete(env, interaction) {
  var opts = getInteractionOptions(interaction);
  var focused = opts.find(function(item) { return item.focused; }) || (interaction.data.options || []).flatMap(function(item) { return item.options || []; }).find(function(item) { return item.focused; });
  var search = (focused && typeof focused.value === "string" ? focused.value.toLowerCase() : "");
  var g = interaction.guild_id;
  var results = [];
  var optName = focused ? focused.name : "";
  if (optName === "user") {
    var members = await getStored(env, adminMembersKey(g), []);
    for (var i = 0; i < members.length; i++) {
      if (!search || members[i].userId.indexOf(search) !== -1) {
        results.push({ name: members[i].userId + " (admin)", value: members[i].userId });
      }
    }
  }
  return results.slice(0, 25);
}
