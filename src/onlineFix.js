import { fetchWithTimeout, truncate } from "./utils.js";
import Fuse from "fuse.js";

export const PERON_DEPOT_BASE_URL = "https://api.perondepot.xyz/all/";
const CACHE_TTL_MS = 45 * 60 * 1000;
const ARCHIVE_RE = /\.(rar|zip|7z)$/i;
const DIRECTORY_FETCHERS = [
  (url) => url,
  (url) => `https://api.codetabs.com/v1/proxy/?quest=${url}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => url.replace(/^https:\/\//i, "http://")
];

let directoryCache = {
  fetchedAt: 0,
  files: []
};

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}



export function parsePeronDepotDirectory(html) {
  const files = [];
  const seen = new Set();
  const content = String(html || "");
  const hrefRe = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of content.matchAll(hrefRe)) {
    const rawHref = decodeHtml(match[1]);
    if (!rawHref || rawHref === "../" || rawHref.endsWith("/")) continue;
    let fileName;
    try {
      fileName = decodeURIComponent(rawHref);
    } catch {
      fileName = rawHref;
    }
    fileName = fileName.split(/[\\/]/).filter(Boolean).pop() || "";
    if (!ARCHIVE_RE.test(fileName)) continue;
    const key = fileName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(fileName);
  }

  return files;
}

export function onlineFixDownloadUrl(fileName, baseUrl = PERON_DEPOT_BASE_URL) {
  const clean = String(fileName || "").split(/[\\/]/).filter(Boolean).pop();
  if (!clean || !ARCHIVE_RE.test(clean)) throw new Error("Invalid OnlineFix archive filename.");
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(clean)}`;
}

// Platform/fix tags to strip when identifying base game names
const COMMON_TAGS = /(?:Fix|Repair|Generic|Steam|Epic|GDK|VR|OFME|Online|Windows|Win64|X64|X86)/gi;

// Normalize filename into a clean searchable string
function normalizeForSearch(fileName) {
  return String(fileName || "")
    .replace(/\.(rar|zip|7z)$/i, "")
    .replace(/_/g, " ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract base game name by stripping platform/fix/generic tags
function baseGameName(fileName) {
  return normalizeForSearch(fileName)
    .replace(COMMON_TAGS, "")
    .replace(/[-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Small platform priority bonus for tiebreaking within a group
function platformBonus(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.includes("steam")) return 50;
  if (lower.includes("gdk")) return 40;
  if (lower.includes("epic")) return 30;
  if (lower.includes("vr")) return 20;
  return 0;
}

export function searchOnlineFixFiles(files, query, limit = 5) {
  const q = String(query || "").trim();
  if (!q) return [];

  const uniqueFiles = [...new Set((files || []).filter(Boolean))];
  if (!uniqueFiles.length) return [];

  // Build Fuse.js index
  const indexed = uniqueFiles.map((fileName) => ({
    fileName,
    searchable: normalizeForSearch(fileName)
  }));

  const fuse = new Fuse(indexed, {
    keys: ["searchable"],
    threshold: 0.25,
    includeScore: true,
    shouldSort: true,
    minMatchCharLength: 2
  });

  const rawResults = fuse.search(q);
  if (!rawResults.length) return [];

  // Convert Fuse scores to ascending 'goodness' scores (0-1000, higher = better)
  const matches = rawResults.map((r) => ({
    fileName: r.item.fileName,
    score: Math.round((1 - r.score) * 1000) + platformBonus(r.item.fileName)
  }));

  // Group by base game name
  const groups = new Map();
  for (const m of matches) {
    const base = baseGameName(m.fileName);
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(m);
  }

  // Sort groups by best score (highest first)
  const sortedGroups = [...groups.entries()]
    .map(([base, items]) => ({
      base,
      items,
      bestScore: Math.max(...items.map((i) => i.score))
    }))
    .sort((a, b) => b.bestScore - a.bestScore);

  const top = sortedGroups[0];
  if (!top) return [];

  const next = sortedGroups[1];

  // If the best group is clearly better (gap > 200), return only the single best result
  if (!next || top.bestScore - next.bestScore > 200) {
    const bestItem = top.items.sort((a, b) => b.score - a.score)[0];
    return [bestItem];
  }

  // Multiple close groups: return only the top group's platform variants
  return top.items.sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function fetchPeronDepotFiles(env = {}, options = {}) {
  const now = Date.now();
  const ttl = Number(env.ONLINEFIX_CACHE_TTL_MS || CACHE_TTL_MS);
  if (!options.forceRefresh && directoryCache.files.length && now - directoryCache.fetchedAt < ttl) {
    return directoryCache.files;
  }

  const sourceUrl = env.ONLINEFIX_DIRECTORY_URL || PERON_DEPOT_BASE_URL;
  const errors = [];

  for (const makeUrl of DIRECTORY_FETCHERS) {
    try {
      const response = await fetchWithTimeout(makeUrl(sourceUrl), {
        timeout: 15000,
        headers: { Accept: "text/html, */*" },
        cf: { cacheTtl: 1800 }
      });
      if (!response.ok) {
        errors.push(`HTTP ${response.status}`);
        continue;
      }
      const files = parsePeronDepotDirectory(await response.text());
      if (!files.length) {
        errors.push("empty directory");
        continue;
      }
      directoryCache = { fetchedAt: now, files };
      return files;
    } catch (error) {
      errors.push(error.message || "fetch failed");
    }
  }

  throw new Error(`PeronDepot directory unavailable: ${errors.slice(-2).join("; ") || "fetch failed"}`);
}

export async function findOnlineFix(env, gameName) {
  const files = await fetchPeronDepotFiles(env);
  const matches = searchOnlineFixFiles(files, gameName, 5);
  if (!matches.length) return null;
  const best = matches[0];
  return {
    ...best,
    url: onlineFixDownloadUrl(best.fileName, env.ONLINEFIX_DIRECTORY_URL || PERON_DEPOT_BASE_URL),
    matches: matches.map((item) => ({
      ...item,
      url: onlineFixDownloadUrl(item.fileName, env.ONLINEFIX_DIRECTORY_URL || PERON_DEPOT_BASE_URL)
    })),
    alternatives: matches.slice(1)
  };
}

export function onlineFixEmbed(gameName, result) {
  const matches = Array.isArray(result.matches) && result.matches.length
    ? result.matches
    : [{ fileName: result.fileName, url: result.url }];
  const rows = matches
    .slice(0, 5)
    .map((item, index) => `${index + 1}. 📥 [${truncate(item.fileName, 170)}](${item.url})`)
    .join("\n");

  return {
    title: "🌐 Online MultiPlayer Fix Storage Vault",
    description: [
      `**Search Query Keyword:** ${truncate(gameName, 120)}`,
      "",
      "Click any hyperlinked element layout title row text below to download directly via browser:",
      "",
      rows
    ].join("\n"),
    color: 0x5865f2,
    timestamp: new Date().toISOString(),
    footer: { text: "Colorado State RP OnlineFix Vault" }
  };
}

export function onlineFixNotFoundEmbed(gameName) {
  return {
    title: "OnlineFix Not Found",
    description: `No OnlineFix repair archive found for **'${truncate(gameName, 120)}'**.`,
    color: 0xed4245,
    timestamp: new Date().toISOString(),
    footer: { text: "Colorado State RP OnlineFix Search" }
  };
}

export function onlineFixButton(url) {
  return [{
    type: 1,
    components: [{
      type: 2,
      style: 5,
      label: "Download Repair Archive",
      emoji: { name: "🔧" },
      url
    }]
  }];
}
