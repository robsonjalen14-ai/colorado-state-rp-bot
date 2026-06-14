import {
  deferredResponse,
  deferredUpdateResponse,
  discordApi,
  editOriginalInteraction,
  interactionUser,
  isStoredModerator,
  messageResponse,
  modalResponse,
  sendChannelFile,
  sendChannelMessage,
  updateMessageResponse
} from "./discord.js";
import {
  PERMISSIONS,
  getOptionValue,
  getSubcommand,
  hasPermission,
  isAdmin,
  isManageServer,
  normalizeUserId,
  storageCall,
  truncate,
  utcNow
} from "./utils.js";
import { getChannelSetting } from "./channelSettings.js";

const TICKET_LOG_CHANNEL = "1485507520335446147";
const TICKET_CATEGORY_ID = "1485507604049563718";
const COLOR_SUPPORT = 0x5865f2;
const COLOR_DARK = 0x2b2d31;
const COLOR_SUCCESS = 0x57f287;
const COLOR_WARN = 0xfee75c;
const COLOR_DANGER = 0xed4245;
const COMPONENT = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
  USER_SELECT: 5
};
const BUTTON = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4
};
const INPUT = {
  SHORT: 1,
  PARAGRAPH: 2
};

export const TICKET_COMMANDS = new Set(["setticket", "ticket"]);

const TICKET_TYPES = {
  partnership: { label: "🤝 Partnership Request", slug: "partnership" },
  support: { label: "🛠️ Server Support", slug: "support" },
  report: { label: "⚠️ Report a User", slug: "report" },
  staff: { label: "👮 Staff Application", slug: "staff" },
  other: { label: "💬 Other Issue", slug: "other" },
  appeal: { label: "🧾 Appeal", slug: "appeal" }
};

async function logChannel(env) {
  return await getChannelSetting(env, "ticketlog") || TICKET_LOG_CHANNEL;
}

function categoryId(env) {
  return env.TICKET_CATEGORY_ID || TICKET_CATEGORY_ID;
}

function ticketBits(kind) {
  const view = PERMISSIONS.VIEW_CHANNEL;
  const send = PERMISSIONS.SEND_MESSAGES;
  const attach = PERMISSIONS.ATTACH_FILES;
  const history = PERMISSIONS.READ_MESSAGE_HISTORY;
  const manageMessages = PERMISSIONS.MANAGE_MESSAGES;
  const manageChannel = PERMISSIONS.MANAGE_CHANNELS;

  if (kind === "creator-open") return (view | send | attach | history).toString();
  if (kind === "creator-closed") return (view | history).toString();
  if (kind === "admin") return (view | send | history | manageMessages | manageChannel).toString();
  if (kind === "added") return (view | send | history).toString();
  return "0";
}

function denyBits(kind) {
  if (kind === "everyone") return PERMISSIONS.VIEW_CHANNEL.toString();
  if (kind === "creator-closed") return PERMISSIONS.SEND_MESSAGES.toString();
  return "0";
}

function userMention(id) {
  return `<@${id}>`;
}

function channelMention(id) {
  return `<#${id}>`;
}

function timestamp(value = Date.now()) {
  const seconds = Math.floor(new Date(value).getTime() / 1000);
  return `<t:${seconds}:F>`;
}

function cleanChannelPart(value) {
  return String(value || "user")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "user";
}

function typeInfo(type) {
  return TICKET_TYPES[type] || TICKET_TYPES.other;
}

function actionRow(components) {
  return { type: COMPONENT.ACTION_ROW, components };
}

function button(customId, label, style, emoji, disabled = false) {
  return {
    type: COMPONENT.BUTTON,
    custom_id: customId,
    label,
    style,
    emoji: emoji ? { name: emoji } : undefined,
    disabled
  };
}

function ticketOpenComponents(disableClaim = false) {
  return [
    actionRow([
      button("ticket_claim", "Claim", BUTTON.PRIMARY, "👤", disableClaim),
      button("ticket_close", "Close", BUTTON.SECONDARY, "🔒"),
      button("ticket_add_user", "Add User", BUTTON.SUCCESS, "➕"),
      button("ticket_transcript", "Transcript", BUTTON.SECONDARY, "📄"),
      button("ticket_delete", "Delete", BUTTON.DANGER, "🗑️")
    ])
  ];
}

function ticketClosedComponents() {
  return [
    actionRow([
      button("ticket_reopen", "Reopen", BUTTON.PRIMARY, "🔓"),
      button("ticket_transcript", "Transcript", BUTTON.SECONDARY, "📄"),
      button("ticket_delete", "Delete", BUTTON.DANGER, "🗑️")
    ])
  ];
}

function ticketConfirmComponents(channelId) {
  return [
    actionRow([
      button(`ticket_confirm_delete:${channelId}`, "Delete", BUTTON.DANGER, "🗑️"),
      button("ticket_cancel_delete", "Cancel", BUTTON.SECONDARY)
    ])
  ];
}

function categorySelectComponents() {
  return [
    actionRow([{
      type: COMPONENT.STRING_SELECT,
      custom_id: "ticket_category_select",
      placeholder: "Select a support category",
      min_values: 1,
      max_values: 1,
      options: Object.entries(TICKET_TYPES)
        .filter(([key]) => key !== "appeal")
        .map(([value, item]) => ({
          label: item.label.replace(/^[^\s]+\s*/, ""),
          value,
          emoji: { name: item.label.split(" ")[0] },
          description: value === "other" ? "Anything that does not fit the other categories" : item.label.replace(/^[^\s]+\s*/, "")
        }))
    }])
  ];
}

function userSelectComponents(channelId) {
  return [
    actionRow([{
      type: COMPONENT.USER_SELECT,
      custom_id: `ticket_add_select:${channelId}`,
      placeholder: "Select a member to add",
      min_values: 1,
      max_values: 1
    }])
  ];
}

function descriptionModal(category) {
  return modalResponse(`ticket_modal:${category}`, "Support", [
    actionRow([{
      type: COMPONENT.TEXT_INPUT,
      custom_id: "description",
      label: "Describe your issue",
      style: INPUT.PARAGRAPH,
      required: true,
      placeholder: "Explain your issue...",
      max_length: 1000
    }])
  ]);
}

function successEmbed(description = "✅ Done.") {
  return {
    description,
    color: COLOR_SUCCESS,
    footer: { text: "Support System" },
    timestamp: new Date().toISOString()
  };
}

function errorEmbed(description = "❌ Something went wrong.") {
  return {
    description,
    color: COLOR_DANGER,
    footer: { text: "Support System" },
    timestamp: new Date().toISOString()
  };
}

function ticketPanelEmbed(guild, guildId) {
  const embed = {
    title: "**Create a Ticket**",
    description: "Please click on the button below to create a support ticket.",
    color: COLOR_SUPPORT,
    footer: { text: "Support System" },
    timestamp: new Date().toISOString()
  };
  if (guild?.icon) {
    embed.thumbnail = { url: `https://cdn.discordapp.com/icons/${guildId}/${guild.icon}.png?size=128` };
  }
  return embed;
}

function ticketCreatedEmbeds(ticket) {
  return [
    {
      title: "🎫 **Ticket Created**",
      description: [
        `Welcome ${userMention(ticket.userId)} 👋`,
        "",
        "Thanks for contacting **Support**.",
        "",
        "Please provide complete information below.",
        "",
        "Staff will assist shortly.",
        "",
        "Avoid unnecessary pings."
      ].join("\n"),
      color: COLOR_SUPPORT,
      footer: { text: "Support System" },
      timestamp: new Date().toISOString()
    },
    {
      title: "📝 **Ticket Information**",
      color: COLOR_DARK,
      fields: [
        { name: "👉 **What do you need help with?**", value: ticket.typeLabel, inline: false },
        { name: "📄 **Description**", value: truncate(ticket.description, 1000), inline: false },
        { name: "🕒 **Opened**", value: timestamp(ticket.createdAt), inline: true },
        { name: "🧾 **Ticket ID**", value: ticket.id, inline: true },
        { name: "Priority", value: ticket.priority || "medium", inline: true }
      ],
      footer: { text: "Ticket Information" },
      timestamp: new Date().toISOString()
    }
  ];
}

function ticketLogEmbed(title, fields, color = COLOR_SUPPORT) {
  return {
    title,
    color,
    fields,
    footer: { text: "Support System" },
    timestamp: new Date().toISOString()
  };
}

async function getStored(env, key, fallback) {
  const data = await storageCall(env, "get", { key, fallback });
  return data.value ?? fallback;
}

async function putStored(env, key, value) {
  await storageCall(env, "put", { key, value });
}

async function ticketsData(env) {
  const tickets = await getStored(env, "tickets", []);
  return Array.isArray(tickets) ? tickets : [];
}

async function saveTickets(env, tickets) {
  await putStored(env, "tickets", tickets.slice(0, 1000));
}

async function updateTicket(env, channelId, updater) {
  const tickets = await ticketsData(env);
  const index = tickets.findIndex((ticket) => ticket.channelId === channelId);
  if (index === -1) throw new Error("This channel is not a tracked ticket.");
  tickets[index] = await updater({ ...tickets[index] });
  await saveTickets(env, tickets);
  return tickets[index];
}

async function ticketByChannel(env, channelId) {
  return (await ticketsData(env)).find((ticket) => ticket.channelId === channelId && ticket.status !== "deleted") || null;
}

async function openTicketByUser(env, userId) {
  return (await ticketsData(env)).find((ticket) => ticket.userId === userId && ticket.status === "open") || null;
}

async function nextTicketId(env) {
  const current = Number(await getStored(env, "ticketCounter", 0)) + 1;
  await putStored(env, "ticketCounter", current);
  return `T-${String(current).padStart(4, "0")}`;
}

async function ticketAdmins(env) {
  const admins = await getStored(env, "moderators", []);
  return Array.isArray(admins) ? [...new Set(admins.map(String))] : [];
}

async function isTicketAdmin(env, userId) {
  return isStoredModerator(env, userId);
}

async function requireTicketAdmin(env, interaction, message = "❌ **Only support staff can use this.**") {
  const user = interactionUser(interaction);
  if (!(await isTicketAdmin(env, user.id))) throw new Error(message);
}

function canManageServer(interaction) {
  return isAdmin(interaction) || isManageServer(interaction) || hasPermission(interaction, PERMISSIONS.MANAGE_GUILD);
}

function optionValue(interaction, name, fallback = undefined) {
  const sub = getSubcommand(interaction.data);
  return getOptionValue(sub?.options || interaction.data.options || [], name, fallback);
}

function subcommand(interaction) {
  return getSubcommand(interaction.data)?.name || "";
}

async function logTicket(env, title, fields, color = COLOR_SUPPORT) {
  await sendChannelMessage(env, await logChannel(env), "", {
    embeds: [ticketLogEmbed(title, fields, color)]
  }).catch(() => null);
}

async function uniqueTicketName(env, guildId, baseName) {
  const channels = await discordApi(env, `/guilds/${guildId}/channels`);
  const names = new Set(channels.map((channel) => channel.name));
  if (!names.has(baseName)) return baseName;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${baseName}-${index}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${baseName}-${Date.now().toString(36).slice(-4)}`;
}

async function ensureTicketCategory(env, guildId) {
  const configured = categoryId(env);
  if (configured) {
    const existing = await discordApi(env, `/channels/${configured}`).catch(() => null);
    if (existing?.id) return existing.id;
  }
  const created = await discordApi(env, `/guilds/${guildId}/channels`, {
    method: "POST",
    body: {
      name: "Charon Support",
      type: 4,
      permission_overwrites: [{ id: guildId, type: 0, allow: "0", deny: denyBits("everyone") }]
    }
  });
  return created.id;
}

function permissionOverwrites(guildId, creatorId, adminIds, status = "open", addedUsers = []) {
  const creatorKind = status === "closed" ? "creator-closed" : "creator-open";
  const overwrites = [
    { id: guildId, type: 0, allow: "0", deny: denyBits("everyone") },
    { id: creatorId, type: 1, allow: ticketBits(creatorKind), deny: denyBits(creatorKind) }
  ];
  for (const adminId of adminIds) {
    if (adminId !== creatorId) overwrites.push({ id: adminId, type: 1, allow: ticketBits("admin"), deny: "0" });
  }
  for (const userId of addedUsers || []) {
    if (userId !== creatorId && !adminIds.includes(userId)) {
      overwrites.push({ id: userId, type: 1, allow: ticketBits("added"), deny: "0" });
    }
  }
  return overwrites.slice(0, 95);
}

async function applyTicketPermissions(env, ticket) {
  const admins = await ticketAdmins(env);
  const overwrites = permissionOverwrites(ticket.guildId, ticket.userId, admins, ticket.status, ticket.addedUsers || []);
  for (const overwrite of overwrites) {
    await discordApi(env, `/channels/${ticket.channelId}/permissions/${overwrite.id}`, {
      method: "PUT",
      body: { type: overwrite.type, allow: overwrite.allow, deny: overwrite.deny }
    }).catch(() => null);
  }
}

async function sendTicketPanel(env, interaction) {
  if (!canManageServer(interaction)) throw new Error("❌ You need Manage Server to set up tickets.");
  const guild = await discordApi(env, `/guilds/${interaction.guild_id}`).catch(() => null);
  await sendChannelMessage(env, interaction.channel_id, "", {
    embeds: [ticketPanelEmbed(guild, interaction.guild_id)],
    components: [actionRow([button("create_ticket", "Create Ticket", BUTTON.PRIMARY, "🎫")])]
  });
  return "Ticket panel created.";
}

function ticketChannelBase(type, username, closed = false) {
  const prefix = closed ? "closed" : "ticket";
  return `${prefix}-${typeInfo(type).slug}-${cleanChannelPart(username)}`.slice(0, 90);
}

async function createTicketCore(env, interaction, type, description) {
  const user = interactionUser(interaction);
  const existing = await openTicketByUser(env, user.id);
  if (existing) {
    throw new Error(`❌ You already have an open ticket: ${channelMention(existing.channelId)}`);
  }

  const cooldowns = await getStored(env, "ticketCooldowns", {});
  const previous = Number(cooldowns[user.id] || 0);
  if (Date.now() - previous < 30000) {
    throw new Error("❌ Please wait before creating another ticket.");
  }
  cooldowns[user.id] = Date.now();
  await putStored(env, "ticketCooldowns", cooldowns);

  const admins = await ticketAdmins(env);
  const id = await nextTicketId(env);
  const name = await uniqueTicketName(env, interaction.guild_id, ticketChannelBase(type, user.username));
  const parentId = await ensureTicketCategory(env, interaction.guild_id);
  const info = typeInfo(type);
  const created = await discordApi(env, `/guilds/${interaction.guild_id}/channels`, {
    method: "POST",
    body: {
      name,
      type: 0,
      parent_id: parentId,
      permission_overwrites: permissionOverwrites(interaction.guild_id, user.id, admins, "open", [])
    }
  });

  const ticket = {
    id,
    guildId: interaction.guild_id,
    channelId: created.id,
    userId: user.id,
    username: user.username,
    type,
    typeLabel: info.label,
    description,
    status: "open",
    priority: "medium",
    addedUsers: [],
    notes: [],
    reopenedCount: 0,
    createdAt: new Date().toISOString(),
    claimedBy: null,
    claimedAt: null,
    controlMessageId: null
  };

  await discordApi(env, `/channels/${created.id}/typing`, { method: "POST" }).catch(() => null);
  const control = await sendChannelMessage(env, created.id, "", {
    embeds: ticketCreatedEmbeds(ticket),
    components: ticketOpenComponents(false)
  });

  ticket.controlMessageId = control.id;
  const tickets = await ticketsData(env);
  tickets.unshift(ticket);
  await saveTickets(env, tickets);

  await logTicket(env, "🎫 **Ticket Created**", [
    { name: "User", value: userMention(user.id), inline: true },
    { name: "Category", value: info.label, inline: true },
    { name: "Ticket ID", value: id, inline: true },
    { name: "Channel", value: channelMention(created.id), inline: true },
    { name: "Created", value: timestamp(ticket.createdAt), inline: false }
  ]);

  return ticket;
}

async function createTicketFromModal(env, interaction, type, description) {
  const ticket = await createTicketCore(env, interaction, type, description);
  await editOriginalInteraction(env, interaction, "", null, {
    embeds: [successEmbed(`✅ Ticket created: ${channelMention(ticket.channelId)}`)]
  });
}

async function editTicketControls(env, ticket, components) {
  if (!ticket.controlMessageId) return;
  await discordApi(env, `/channels/${ticket.channelId}/messages/${ticket.controlMessageId}`, {
    method: "PATCH",
    body: { components }
  }).catch(() => null);
}

async function claimTicket(env, interaction) {
  await requireTicketAdmin(env, interaction, "❌ **Only support staff can claim tickets.**");
  const admin = interactionUser(interaction);
  let ticket = await ticketByChannel(env, interaction.channel_id);
  if (!ticket) throw new Error("This channel is not a tracked ticket.");
  if (ticket.userId === admin.id) throw new Error("❌ **Only support staff can claim tickets.**");
  if (ticket.claimedBy) throw new Error("This ticket is already claimed.");

  ticket = await updateTicket(env, ticket.channelId, (current) => ({
    ...current,
    claimedBy: admin.id,
    claimedAt: new Date().toISOString()
  }));
  await editTicketControls(env, ticket, ticketOpenComponents(true));

  const claimMs = new Date(ticket.claimedAt).getTime() - new Date(ticket.createdAt).getTime();
  const claimMinutes = Math.max(0, Math.round(claimMs / 60000));
  await sendChannelMessage(env, ticket.channelId, "", {
    embeds: [{
      title: "👤 **Ticket Claimed**",
      description: [
        "**This ticket has been claimed by**",
        "",
        userMention(admin.id),
        "",
        "Please wait while support assists you."
      ].join("\n"),
      color: COLOR_SUCCESS,
      fields: [{ name: "First Response", value: `${claimMinutes} minute(s)`, inline: true }],
      footer: { text: "Support System" },
      timestamp: new Date().toISOString()
    }]
  });
  await logTicket(env, "👤 **Ticket Claimed**", [
    { name: "Claimed By", value: userMention(admin.id), inline: true },
    { name: "Ticket ID", value: ticket.id, inline: true },
    { name: "Channel", value: channelMention(ticket.channelId), inline: true }
  ], COLOR_SUCCESS);
}

async function unclaimTicket(env, interaction) {
  await requireTicketAdmin(env, interaction);
  let ticket = await ticketByChannel(env, interaction.channel_id);
  if (!ticket) throw new Error("This channel is not a tracked ticket.");
  ticket = await updateTicket(env, ticket.channelId, (current) => ({ ...current, claimedBy: null, claimedAt: null }));
  await editTicketControls(env, ticket, ticketOpenComponents(false));
  await sendChannelMessage(env, ticket.channelId, "", { embeds: [successEmbed("👤 Ticket unclaimed.")] });
  await logTicket(env, "👤 **Ticket Unclaimed**", [
    { name: "By", value: userMention(interactionUser(interaction).id), inline: true },
    { name: "Ticket ID", value: ticket.id, inline: true }
  ]);
}

async function closeTicket(env, interaction) {
  const actor = interactionUser(interaction);
  let ticket = await ticketByChannel(env, interaction.channel_id);
  if (!ticket) throw new Error("This channel is not a tracked ticket.");
  const isAdminUser = await isTicketAdmin(env, actor.id);
  if (ticket.userId !== actor.id && !isAdminUser) throw new Error("❌ **You cannot close this ticket.**");
  if (ticket.status === "closed") throw new Error("This ticket is already closed.");

  const closedName = ticketChannelBase(ticket.type, ticket.username, true);
  await discordApi(env, `/channels/${ticket.channelId}`, {
    method: "PATCH",
    body: { name: closedName }
  });

  ticket = await updateTicket(env, ticket.channelId, (current) => ({
    ...current,
    status: "closed",
    closedBy: actor.id,
    closedAt: new Date().toISOString()
  }));
  await applyTicketPermissions(env, ticket);
  await editTicketControls(env, ticket, ticketClosedComponents());

  await sendChannelMessage(env, ticket.channelId, "", {
    embeds: [{
      title: isAdminUser ? "🔒 **Ticket Closed by Staff**" : "🔒 **Ticket Closed**",
      description: isAdminUser
        ? [`Closed by:`, userMention(actor.id), "", "Support has marked this issue as resolved."].join("\n")
        : [`Closed by:`, userMention(actor.id), "", "This ticket has been moved into closed state.", "", "Staff may reopen if needed."].join("\n"),
      color: COLOR_WARN,
      footer: { text: "Support System" },
      timestamp: new Date().toISOString()
    }]
  });
  await logTicket(env, "🔒 **Ticket Closed**", [
    { name: "Closed By", value: userMention(actor.id), inline: true },
    { name: "Ticket ID", value: ticket.id, inline: true },
    { name: "Channel", value: channelMention(ticket.channelId), inline: true }
  ], COLOR_WARN);
}

async function reopenTicket(env, interaction) {
  await requireTicketAdmin(env, interaction);
  let ticket = await ticketByChannel(env, interaction.channel_id);
  if (!ticket) throw new Error("This channel is not a tracked ticket.");
  if (ticket.status === "open") throw new Error("This ticket is already open.");

  await discordApi(env, `/channels/${ticket.channelId}`, {
    method: "PATCH",
    body: { name: ticketChannelBase(ticket.type, ticket.username, false) }
  });
  ticket = await updateTicket(env, ticket.channelId, (current) => ({
    ...current,
    status: "open",
    reopenedCount: Number(current.reopenedCount || 0) + 1,
    reopenedAt: new Date().toISOString()
  }));
  await applyTicketPermissions(env, ticket);
  await editTicketControls(env, ticket, ticketOpenComponents(Boolean(ticket.claimedBy)));
  await sendChannelMessage(env, ticket.channelId, "", {
    embeds: [successEmbed(`🔓 Ticket reopened by ${userMention(interactionUser(interaction).id)}.`)]
  });
  await logTicket(env, "🔓 **Ticket Reopened**", [
    { name: "Reopened By", value: userMention(interactionUser(interaction).id), inline: true },
    { name: "Ticket ID", value: ticket.id, inline: true },
    { name: "Reopen Count", value: String(ticket.reopenedCount), inline: true }
  ], COLOR_SUCCESS);
}

async function addUserToTicket(env, interaction, userId) {
  await requireTicketAdmin(env, interaction);
  let ticket = await ticketByChannel(env, interaction.channel_id);
  if (!ticket) ticket = await ticketByChannel(env, interaction.data.custom_id?.split(":")[1]);
  if (!ticket) throw new Error("This channel is not a tracked ticket.");
  if (!ticket.addedUsers?.includes(userId)) {
    ticket = await updateTicket(env, ticket.channelId, (current) => ({
      ...current,
      addedUsers: [...new Set([...(current.addedUsers || []), userId])]
    }));
  }
  await discordApi(env, `/channels/${ticket.channelId}/permissions/${userId}`, {
    method: "PUT",
    body: { type: 1, allow: ticketBits("added"), deny: "0" }
  });
  await sendChannelMessage(env, ticket.channelId, "", {
    embeds: [successEmbed(`✅ ${userMention(userId)} added to this ticket.`)]
  });
  await logTicket(env, "➕ **User Added**", [
    { name: "Added User", value: userMention(userId), inline: true },
    { name: "Added By", value: userMention(interactionUser(interaction).id), inline: true },
    { name: "Ticket ID", value: ticket.id, inline: true }
  ], COLOR_SUCCESS);
}

async function fetchTranscriptMessages(env, channelId) {
  const all = [];
  let before = "";
  for (let page = 0; page < 10; page += 1) {
    const query = before ? `?limit=100&before=${before}` : "?limit=100";
    const messages = await discordApi(env, `/channels/${channelId}/messages${query}`, { timeout: 20000 });
    if (!messages.length) break;
    all.push(...messages);
    before = messages[messages.length - 1].id;
    if (messages.length < 100) break;
  }
  return all.reverse();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function transcriptHtml(ticket, messages) {
  const rows = messages.map((message) => {
    const attachments = (message.attachments || []).map((item) => `<li><a href="${escapeHtml(item.url)}">${escapeHtml(item.filename || item.url)}</a></li>`).join("");
    const embeds = (message.embeds || []).map((item) => `<pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>`).join("");
    return `
      <article class="msg">
        <div class="meta">${escapeHtml(message.timestamp)} • ${escapeHtml(message.author?.username || "Unknown")} (${escapeHtml(message.author?.id || "")})</div>
        <div class="content">${escapeHtml(message.content || "").replace(/\n/g, "<br>") || "<em>No text content</em>"}</div>
        ${attachments ? `<ul>${attachments}</ul>` : ""}
        ${embeds}
      </article>`;
  }).join("\n");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Transcript ${escapeHtml(ticket.id)}</title>
  <style>
    body{font-family:Inter,Segoe UI,Arial,sans-serif;background:#0b0d12;color:#f5f5f5;margin:0;padding:32px}
    .wrap{max-width:980px;margin:0 auto}
    h1{margin:0 0 8px;font-size:30px}
    .sub{color:#a1a1aa;margin-bottom:28px}
    .msg{border:1px solid rgba(255,255,255,.08);background:#11141b;border-radius:14px;padding:16px;margin:12px 0}
    .meta{color:#8b5cf6;font-size:13px;margin-bottom:8px}
    .content{line-height:1.55}
    a{color:#05fff7}
    pre{white-space:pre-wrap;background:#090b10;border-radius:10px;padding:12px;overflow:auto}
  </style>
</head>
<body>
  <main class="wrap">
    <h1>Charon Ticket Transcript</h1>
    <div class="sub">${escapeHtml(ticket.id)} • ${escapeHtml(ticket.typeLabel)} • ${escapeHtml(ticket.channelId)}</div>
    ${rows || "<p>No messages found.</p>"}
  </main>
</body>
</html>`;
}

async function generateTranscript(env, ticket) {
  const messages = await fetchTranscriptMessages(env, ticket.channelId);
  const html = transcriptHtml(ticket, messages);
  const filename = `transcript-${cleanChannelPart(ticket.type)}-${cleanChannelPart(ticket.username)}.html`;
  const bytes = new TextEncoder().encode(html);
  await sendChannelFile(env, await logChannel(env), "", {
    filename,
    bytes,
    contentType: "text/html; charset=utf-8"
  }, {
    embeds: [ticketLogEmbed("📄 **Ticket Transcript**", [
      { name: "Ticket ID", value: ticket.id, inline: true },
      { name: "User", value: userMention(ticket.userId), inline: true },
      { name: "Channel", value: channelMention(ticket.channelId), inline: true },
      { name: "Messages", value: String(messages.length), inline: true }
    ])]
  });
  return { filename, count: messages.length };
}

async function deleteTicket(env, interaction, channelId = interaction.channel_id) {
  await requireTicketAdmin(env, interaction, "❌ **Only support staff can delete tickets.**");
  const ticket = await ticketByChannel(env, channelId);
  if (!ticket) throw new Error("This channel is not a tracked ticket.");

  await generateTranscript(env, ticket).catch(() => null);
  await logTicket(env, "🗑 **Ticket Deleted**", [
    { name: "Deleted By", value: userMention(interactionUser(interaction).id), inline: true },
    { name: "User", value: userMention(ticket.userId), inline: true },
    { name: "Ticket ID", value: ticket.id, inline: true }
  ], COLOR_DANGER);

  await updateTicket(env, ticket.channelId, (current) => ({
    ...current,
    status: "deleted",
    deletedBy: interactionUser(interaction).id,
    deletedAt: new Date().toISOString()
  }));
  await new Promise((resolve) => setTimeout(resolve, 5000));
  await discordApi(env, `/channels/${ticket.channelId}`, { method: "DELETE" }).catch(() => null);
}

async function renameTicket(env, interaction) {
  await requireTicketAdmin(env, interaction);
  const name = cleanChannelPart(optionValue(interaction, "name", ""));
  if (!name) throw new Error("Give a valid name.");
  const ticket = await ticketByChannel(env, interaction.channel_id);
  if (!ticket) throw new Error("This channel is not a tracked ticket.");
  await discordApi(env, `/channels/${ticket.channelId}`, { method: "PATCH", body: { name } });
  await updateTicket(env, ticket.channelId, (current) => ({ ...current, customName: name }));
  await logTicket(env, "✏️ **Ticket Renamed**", [
    { name: "Ticket ID", value: ticket.id, inline: true },
    { name: "New Name", value: name, inline: true }
  ]);
  return "Ticket renamed.";
}

async function setPriority(env, interaction) {
  await requireTicketAdmin(env, interaction);
  const priority = String(optionValue(interaction, "level", "medium"));
  const ticket = await updateTicket(env, interaction.channel_id, (current) => ({ ...current, priority }));
  await sendChannelMessage(env, ticket.channelId, "", { embeds: [successEmbed(`Priority updated to **${priority}**.`)] });
  await logTicket(env, "⭐ **Ticket Priority Updated**", [
    { name: "Ticket ID", value: ticket.id, inline: true },
    { name: "Priority", value: priority, inline: true }
  ]);
  return "Ticket priority updated.";
}

async function moveTicket(env, interaction) {
  await requireTicketAdmin(env, interaction);
  const parentId = String(optionValue(interaction, "category", ""));
  const ticket = await ticketByChannel(env, interaction.channel_id);
  if (!ticket) throw new Error("This channel is not a tracked ticket.");
  await discordApi(env, `/channels/${ticket.channelId}`, { method: "PATCH", body: { parent_id: parentId } });
  await logTicket(env, "📂 **Ticket Moved**", [
    { name: "Ticket ID", value: ticket.id, inline: true },
    { name: "Category", value: channelMention(parentId), inline: true }
  ]);
  return "Ticket moved.";
}

async function transferTicket(env, interaction) {
  await requireTicketAdmin(env, interaction);
  const newUserId = String(optionValue(interaction, "user", ""));
  let ticket = await ticketByChannel(env, interaction.channel_id);
  if (!ticket) throw new Error("This channel is not a tracked ticket.");
  ticket = await updateTicket(env, ticket.channelId, (current) => ({
    ...current,
    userId: newUserId,
    transferredAt: new Date().toISOString(),
    transferredBy: interactionUser(interaction).id
  }));
  await applyTicketPermissions(env, ticket);
  await logTicket(env, "🔁 **Ticket Transferred**", [
    { name: "Ticket ID", value: ticket.id, inline: true },
    { name: "New Creator", value: userMention(newUserId), inline: true }
  ]);
  return "Ticket transferred.";
}

async function ticketNotes(env, interaction) {
  await requireTicketAdmin(env, interaction);
  const note = String(optionValue(interaction, "note", "")).trim();
  const ticket = await ticketByChannel(env, interaction.channel_id);
  if (!ticket) throw new Error("This channel is not a tracked ticket.");
  if (note) {
    await updateTicket(env, ticket.channelId, (current) => ({
      ...current,
      notes: [
        { by: interactionUser(interaction).id, note, time: utcNow() },
        ...(current.notes || [])
      ].slice(0, 50)
    }));
    return "Ticket note added.";
  }
  const notes = ticket.notes || [];
  return {
    embeds: [ticketLogEmbed("🗒️ **Ticket Notes**", [{
      name: ticket.id,
      value: notes.length
        ? notes.slice(0, 10).map((item, index) => `${index + 1}. ${item.note}\n- ${userMention(item.by)} • ${item.time}`).join("\n\n")
        : "No notes yet.",
      inline: false
    }])]
  };
}

export async function handleSetTicketCommand(env, interaction) {
  return sendTicketPanel(env, interaction);
}

export async function handleTicketCommand(env, interaction) {
  const action = subcommand(interaction);
  if (action === "panel") return sendTicketPanel(env, interaction);
  if (action === "claim") {
    await claimTicket(env, interaction);
    return "Ticket claimed.";
  }
  if (action === "unclaim") {
    await unclaimTicket(env, interaction);
    return "Ticket unclaimed.";
  }
  if (action === "close") {
    await closeTicket(env, interaction);
    return "Ticket closed.";
  }
  if (action === "reopen") {
    await reopenTicket(env, interaction);
    return "Ticket reopened.";
  }
  if (action === "delete") {
    await requireTicketAdmin(env, interaction, "❌ **Only support staff can delete tickets.**");
    return {
      embeds: [{
        title: "⚠️ **Delete Ticket**",
        description: "This action cannot be undone.\n\nAre you sure?",
        color: COLOR_DANGER,
        footer: { text: "Support System" },
        timestamp: new Date().toISOString()
      }],
      components: ticketConfirmComponents(interaction.channel_id)
    };
  }
  if (action === "rename") return renameTicket(env, interaction);
  if (action === "priority") return setPriority(env, interaction);
  if (action === "move") return moveTicket(env, interaction);
  if (action === "transfer") return transferTicket(env, interaction);
  if (action === "transcript") {
    await requireTicketAdmin(env, interaction);
    const ticket = await ticketByChannel(env, interaction.channel_id);
    if (!ticket) throw new Error("This channel is not a tracked ticket.");
    const transcript = await generateTranscript(env, ticket);
    return `Transcript saved (${transcript.count} message(s)).`;
  }
  if (action === "notes") return ticketNotes(env, interaction);
  throw new Error("Unknown ticket subcommand.");
}

export async function createQuickTicket(env, interaction, type, description) {
  const ticket = await createTicketCore(env, interaction, type, description);
  return `Ticket created: ${channelMention(ticket.channelId)}`;
}

export function isTicketComponent(customId = "") {
  return customId === "create_ticket" ||
    customId === "ticket_category_select" ||
    customId.startsWith("ticket_");
}

export function isTicketModal(customId = "") {
  return customId.startsWith("ticket_modal:");
}

export async function handleTicketComponent(env, interaction, ctx) {
  const customId = interaction.data.custom_id || "";
  const user = interactionUser(interaction);

  if (customId === "create_ticket") {
    const existing = await openTicketByUser(env, user.id);
    if (existing) {
      return messageResponse("", true, {
        embeds: [errorEmbed(`❌ You already have an open ticket: ${channelMention(existing.channelId)}`)]
      });
    }
    return messageResponse("", true, {
      embeds: [{
        title: "Support",
        description: "⚠ Do not share passwords or sensitive information.\n\nChoose the topic that best matches your request.",
        color: COLOR_SUPPORT,
        footer: { text: "Support System" },
        timestamp: new Date().toISOString()
      }],
      components: categorySelectComponents()
    });
  }

  if (customId === "ticket_category_select") {
    const category = interaction.data.values?.[0] || "other";
    return descriptionModal(category);
  }

  async function runTicketAction(action) {
    try {
      await action();
    } catch (error) {
      await sendChannelMessage(env, interaction.channel_id, "", {
        embeds: [errorEmbed(error.message || "❌ Something went wrong.")]
      }).catch(() => null);
    }
  }

  if (customId === "ticket_claim") {
    if (!(await isTicketAdmin(env, user.id)) || (await ticketByChannel(env, interaction.channel_id))?.userId === user.id) {
      return messageResponse("", true, { embeds: [errorEmbed("❌ **Only support staff can claim tickets.**")] });
    }
    ctx.waitUntil(runTicketAction(() => claimTicket(env, interaction)));
    return deferredUpdateResponse();
  }

  if (customId === "ticket_close") {
    const ticket = await ticketByChannel(env, interaction.channel_id);
    const admin = await isTicketAdmin(env, user.id);
    if (!ticket || (ticket.userId !== user.id && !admin)) {
      return messageResponse("", true, { embeds: [errorEmbed("❌ **You cannot close this ticket.**")] });
    }
    ctx.waitUntil(runTicketAction(() => closeTicket(env, interaction)));
    return deferredUpdateResponse();
  }

  if (customId === "ticket_reopen") {
    if (!(await isTicketAdmin(env, user.id))) return messageResponse("", true, { embeds: [errorEmbed("❌ **Only support staff can reopen tickets.**")] });
    ctx.waitUntil(runTicketAction(() => reopenTicket(env, interaction)));
    return deferredUpdateResponse();
  }

  if (customId === "ticket_add_user") {
    if (!(await isTicketAdmin(env, user.id))) return messageResponse("", true, { embeds: [errorEmbed("❌ **Only support staff can add users.**")] });
    return messageResponse("", true, {
      embeds: [successEmbed("Select a member to add to this ticket.")],
      components: userSelectComponents(interaction.channel_id)
    });
  }

  if (customId.startsWith("ticket_add_select:")) {
    if (!(await isTicketAdmin(env, user.id))) return messageResponse("", true, { embeds: [errorEmbed("❌ **Only support staff can add users.**")] });
    const channelId = customId.split(":")[1];
    const selected = interaction.data.values?.[0];
    ctx.waitUntil(
      addUserToTicket(env, { ...interaction, channel_id: channelId }, selected)
        .then(() => editOriginalInteraction(env, interaction, "", null, { embeds: [successEmbed("✅ User added.")], components: [] }))
        .catch((error) => editOriginalInteraction(env, interaction, "", null, { embeds: [errorEmbed(error.message)], components: [] }))
    );
    return deferredResponse(true);
  }

  if (customId === "ticket_transcript") {
    if (!(await isTicketAdmin(env, user.id))) return messageResponse("", true, { embeds: [errorEmbed("❌ **Only support staff can export transcripts.**")] });
    ctx.waitUntil(runTicketAction(async () => {
      const ticket = await ticketByChannel(env, interaction.channel_id);
      if (!ticket) throw new Error("This channel is not a tracked ticket.");
      const transcript = await generateTranscript(env, ticket);
      await sendChannelMessage(env, interaction.channel_id, "", { embeds: [successEmbed(`📄 Transcript saved (${transcript.count} message(s)).`)] });
    }));
    return deferredUpdateResponse();
  }

  if (customId === "ticket_delete") {
    if (!(await isTicketAdmin(env, user.id))) return messageResponse("", true, { embeds: [errorEmbed("❌ **Only support staff can delete tickets.**")] });
    return messageResponse("", true, {
      embeds: [{
        title: "⚠️ **Delete Ticket**",
        description: "This action cannot be undone.\n\nAre you sure?",
        color: COLOR_DANGER,
        footer: { text: "Support System" },
        timestamp: new Date().toISOString()
      }],
      components: ticketConfirmComponents(interaction.channel_id)
    });
  }

  if (customId.startsWith("ticket_confirm_delete:")) {
    if (!(await isTicketAdmin(env, user.id))) return messageResponse("", true, { embeds: [errorEmbed("❌ **Only support staff can delete tickets.**")] });
    const channelId = customId.split(":")[1];
    ctx.waitUntil(
      deleteTicket(env, { ...interaction, channel_id: channelId }, channelId)
        .then(() => editOriginalInteraction(env, interaction, "", null, { embeds: [successEmbed("✅ Ticket queued for deletion.")], components: [] }).catch(() => null))
        .catch((error) => editOriginalInteraction(env, interaction, "", null, { embeds: [errorEmbed(error.message)], components: [] }).catch(() => null))
    );
    return deferredResponse(true);
  }

  if (customId === "ticket_cancel_delete") {
    return updateMessageResponse({ embeds: [successEmbed("Delete cancelled.")], components: [] });
  }

  return messageResponse("", true, { embeds: [errorEmbed()] });
}

export async function handleTicketModal(env, interaction, ctx) {
  const customId = interaction.data.custom_id || "";
  const type = customId.split(":")[1] || "other";
  const description = interaction.data.components?.[0]?.components?.[0]?.value || "";
  ctx.waitUntil(
    createTicketFromModal(env, interaction, type, description)
      .catch((error) => editOriginalInteraction(env, interaction, "", null, { embeds: [errorEmbed(error.message || "❌ Something went wrong.")] }).catch(() => null))
  );
  return deferredResponse(true);
}
