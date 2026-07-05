import { createFlatZipFromEntries, createLuaManifestZip, readZipEntries } from "./zip.js";
import { enqueueManifestBackfill, recordMissingManifest } from "./backfillQueue.js";
import { publishManifestVaultFile, readManifestVaultFile } from "./publisher.js";
import { fetchJson, fetchWithTimeout, getConfiguredBasePaths, joinUrl } from "./utils.js";

const STORE_DETAILS_URL = "https://store.steampowered.com/api/appdetails?appids=";
const STORE_DETAILS_FILTERS = "basic,release_date,publishers,developers,genres";
const STEAMSPY_DETAILS_URL = "https://steamspy.com/api.php?request=appdetails&appid=";
const STEAM_SUGGEST_URL = "https://store.steampowered.com/search/suggest";
const STEAMCMD_INFO_URL = "https://api.steamcmd.net/v1/info/";
const DEFAULT_PRIMARY_MANIFEST_REPOSITORIES = "https://raw.githubusercontent.com/BlissBlender/ManifestVault/main";
const DEFAULT_FALLBACK_MANIFEST_REPOSITORIES = "https://raw.githubusercontent.com/qwe213312/k25FCdfEOoEJ42S6/main";
const DEPOT_ADDAPPID_RE = /addappid\s*\(\s*(\d+)\s*,\s*\d+\s*,\s*["'][a-fA-F0-9]+["']/gi;
const DIRECT_MANIFEST_FILE_RE = /\b(\d{3,})_(\d{3,})\.manifest\b/gi;

const PROXIES = [
  (url) => url,
  (url) => `https://api.codetabs.com/v1/proxy/?quest=${url.replace(/&/g, "%26")}`,
  (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`
];

async function parseProxyJson(response, proxyIndex) {
  if (proxyIndex === 3) {
    const data = await response.json();
    if (typeof data.contents === "string") return JSON.parse(data.contents);
    return data;
  }
  return response.json();
}

async function fetchJsonAny(url, timeout = 12000) {
  const attempts = PROXIES.map(async (makeUrl, index) => {
    const response = await fetchWithTimeout(makeUrl(url), {
      timeout,
      headers: { Accept: "application/json, text/plain" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseProxyJson(response, index);
  });
  return Promise.any(attempts);
}

export function databaseConfigs(env) {
  return [
    { id: "database-1", base: env.DATABASE_1_URL },
    { id: "database-2", base: env.DATABASE_2_URL }
  ].filter((database) => database.base);
}

async function headExists(url) {
  try {
    const response = await fetchWithTimeout(url, {
      method: "HEAD",
      timeout: 8000
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function downloadBytes(url, timeout = 30000) {
  const response = await fetchWithTimeout(url, { timeout });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function parseUrlList(value, fallback = "") {
  const raw = String(value || fallback || "");
  return raw
    .split(/[\n,]+/)
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function manifestRepositoryGroups(env) {
  return [
    {
      type: "primary",
      repositories: parseUrlList(env.MANIFEST_PRIMARY_URLS || env.PRIMARY_MANIFEST_REPOSITORIES, DEFAULT_PRIMARY_MANIFEST_REPOSITORIES)
    },
    {
      type: "fallback",
      repositories: parseUrlList(env.MANIFEST_FALLBACK_URLS || env.FALLBACK_MANIFEST_REPOSITORIES, DEFAULT_FALLBACK_MANIFEST_REPOSITORIES)
    }
  ].filter((group) => group.repositories.length);
}

function configuredManifestPaths(env) {
  const raw = env.MANIFEST_REPOSITORY_BASE_PATHS ?? "";
  const paths = String(raw)
    .split(/[\n,]+/)
    .map((item) => item.trim().replace(/^\/+|\/+$/g, ""))
    .filter((item, index, array) => array.indexOf(item) === index);
  return paths.length ? paths : [""];
}

function manifestRepositoryCandidates(env, fileName) {
  const paths = configuredManifestPaths(env);
  return manifestRepositoryGroups(env).map((group) => ({
    ...group,
    candidates: group.repositories.flatMap((repository) =>
      paths.map((basePath) => {
        const path = basePath ? `${basePath}/${fileName}` : fileName;
        return {
          repository,
          fileName,
          url: joinUrl(repository, path)
        };
      })
    )
  }));
}

export function extractDepotIdsFromLua(luaText) {
  const depots = new Set();
  const content = String(luaText || "");
  for (const match of content.matchAll(DEPOT_ADDAPPID_RE)) {
    depots.add(match[1]);
  }
  return [...depots];
}

export function extractDirectManifestFileNames(luaText) {
  const files = new Set();
  const content = String(luaText || "");
  for (const match of content.matchAll(DIRECT_MANIFEST_FILE_RE)) {
    files.add(`${match[1]}_${match[2]}.manifest`);
  }
  return [...files];
}

async function fetchSteamCmdAppInfo(appId) {
  try {
    const data = await fetchJson(`${STEAMCMD_INFO_URL}${appId}`, { timeout: 12000 });
    return data?.status === "success" ? data : null;
  } catch (error) {
    logManifestBundle(`SteamCMD app info unavailable for ${appId}: ${error.message}`);
    return null;
  }
}

function manifestFileNamesFromAppInfo(appInfo, appId, depotIds) {
  const files = new Set();
  const depots = appInfo?.data?.[appId]?.depots;
  if (!depots || typeof depots !== "object") return [];

  for (const depotId of depotIds) {
    const manifestId = depots?.[depotId]?.manifests?.public?.gid;
    if (manifestId) files.add(`${depotId}_${manifestId}.manifest`);
  }

  return [...files];
}

async function findManifestInRepositories(env, fileName, cache, options = {}) {
  if (cache.has(fileName)) return cache.get(fileName);

  for (const group of manifestRepositoryCandidates(env, fileName)) {
    if (group.type === "primary" && env.GITHUB_TOKEN) {
      try {
        logManifestBundle(`Checking ManifestVault API for ${fileName}`);
        const apiFile = await readManifestVaultFile(env, fileName);
        if (apiFile) {
          logManifestBundle(`Found manifest ${fileName} in primary via GitHub API.`);
          cache.set(fileName, apiFile);
          return apiFile;
        }
      } catch (error) {
        logManifestBundle(`ManifestVault API check skipped for ${fileName}: ${error.message}`);
      }
    }

    const attempts = group.candidates.map(async (candidate) => {
      logManifestBundle(`Searching ${group.type} manifest source: ${candidate.url}`);
      try {
        const bytes = await downloadBytes(candidate.url, 15000);
        if (!bytes.length) return null;
        return {
          fileName,
          bytes,
          source: group.type,
          url: candidate.url
        };
      } catch {
        return null;
      }
    });

    const settled = await Promise.allSettled(attempts);
    const found = settled.find((result) => result.status === "fulfilled" && result.value)?.value;
    if (found) {
      logManifestBundle(`Found manifest ${fileName} in ${found.source}: ${found.url}`);
      cache.set(fileName, found);
      const backfill = scheduleManifestVaultBackfill(env, found, options);
      if (backfill && options.awaitBackfills) await backfill;
      return found;
    }
  }

  logManifestBundle(`Skipped missing manifest ${fileName}; no configured source had it.`);
  const missingTask = recordMissingManifest(env, {
    fileName,
    appId: options.appId,
    sources: manifestRepositoryCandidates(env, fileName).flatMap((group) => group.candidates.map((candidate) => candidate.url))
  });
  if (typeof options.waitUntil === "function") options.waitUntil(missingTask);
  else if (options.awaitBackfills) await missingTask;
  cache.set(fileName, null);
  return null;
}

async function requiredManifestFileNamesForLuaEntries(appId, luaEntries) {
  const requiredFiles = new Set();
  const depotIds = new Set();

  for (const luaEntry of luaEntries) {
    try {
      const luaText = new TextDecoder().decode(luaEntry.bytes);
      for (const fileName of extractDirectManifestFileNames(luaText)) {
        requiredFiles.add(fileName);
      }
      for (const depotId of extractDepotIdsFromLua(luaText)) {
        depotIds.add(depotId);
      }
    } catch (error) {
      logManifestBundle(`Lua parsing skipped for ${luaEntry.name || appId}: ${error.message}`);
    }
  }

  if (depotIds.size) {
    const appInfo = await fetchSteamCmdAppInfo(appId);
    for (const fileName of manifestFileNamesFromAppInfo(appInfo, appId, [...depotIds])) {
      requiredFiles.add(fileName);
    }
  }

  return [...requiredFiles];
}

async function downloadManifestFiles(env, fileNames, appId, options = {}) {
  if (!fileNames.length) {
    logManifestBundle(`No missing manifest files to fetch for AppID ${appId}.`);
    return [];
  }

  const cache = new Map();
  const manifests = [];
  const added = new Set();
  const uniqueFiles = [...new Set(fileNames)];
  const batchSize = Number(options.manifestBatchSize || 48);

  for (let index = 0; index < uniqueFiles.length; index += batchSize) {
    const batch = uniqueFiles.slice(index, index + batchSize);
    const results = await Promise.all(batch.map((fileName) =>
      findManifestInRepositories(env, fileName, cache, { ...options, appId }).catch(() => null)
    ));
    for (const found of results) {
      if (!found || added.has(found.fileName)) continue;
      added.add(found.fileName);
      manifests.push(found);
    }
  }

  logManifestBundle(`AppID ${appId}: bundled ${manifests.length}/${uniqueFiles.length} missing optional manifest file(s).`);
  return manifests;
}

async function collectRequiredManifests(env, appId, luaBytes, options = {}) {
  try {
    const requiredFiles = await requiredManifestFileNamesForLuaEntries(appId, [{ name: `${appId}.lua`, bytes: luaBytes }]);

    if (!requiredFiles.length) {
      logManifestBundle(`No manifest identifiers detected for AppID ${appId}; returning Lua-only package.`);
      return [];
    }

        if (requiredFiles.length > 20) {
      logManifestBundle(`Manifest collection skipped for AppID ${appId}: too many manifests. Returning Lua-only package.`);
      return [];
    }

    return downloadManifestFiles(env, requiredFiles, appId, options);
  } catch (error) {
    logManifestBundle(`Manifest bundling skipped for AppID ${appId}: ${error.message}`);
    return [];
  }
}

async function enrichZipWithMissingManifests(env, appId, zipBytes, options = {}) {
  try {
    const entries = readZipEntries(zipBytes);
    const luaEntries = entries.filter((entry) => /\.lua$/i.test(entry.name));
    if (!luaEntries.length) {
      logManifestBundle(`Database ZIP for AppID ${appId} has no Lua files; returning original ZIP.`);
            return { bytes: zipBytes, manifestSource: "", manifestCount: 0 };
    }

    const requiredFiles = await requiredManifestFileNamesForLuaEntries(appId, luaEntries);
    const existingManifests = new Set(
      entries
        .filter((entry) => /\.manifest$/i.test(entry.name))
        .map((entry) => entry.name.toLowerCase())
    );
    const missingFiles = requiredFiles.filter((fileName) => !existingManifests.has(fileName.toLowerCase()));
    const existingCount = entries.filter((e) => /\.manifest$/i.test(e.name)).length;
        if (missingFiles.length > 20) {
      logManifestBundle(`ZIP enrichment skipped for AppID ${appId}: too many missing manifests. Returning original ZIP.`);
      const existingCount = entries.filter((e) => /.manifest$/i.test(e.name)).length;
      return { bytes: zipBytes, manifestSource: "", manifestCount: existingCount };
    }

    const manifests = await downloadManifestFiles(env, missingFiles, appId, options);

    return {
      bytes: createFlatZipFromEntries(entries, manifests),
      manifestSource: summarizeManifestSources(manifests),
      manifestCount: manifests.length + existingCount
    };
  } catch (error) {
    logManifestBundle(`Database ZIP enrichment skipped for AppID ${appId}: ${error.message}`);
        let existingCount = 0;
    try { const zipEntries = readZipEntries(zipBytes); existingCount = zipEntries.filter((e) => /.manifest$/i.test(e.name)).length; } catch (err) { logManifestBundle(`Failed to count existing manifests in fallback ZIP: ${err.message}`); }
    return { bytes: zipBytes, manifestSource: "", manifestCount: existingCount };
  }
}

function manifestSourceLabel(source) {
  return source === "primary" ? "Manifest Vault" : "External Vault";
}

function summarizeManifestSources(manifests) {
  const labels = [...new Set(
    manifests
      .map((manifest) => manifestSourceLabel(manifest.source))
      .filter(Boolean)
  )];
  return labels.join(" + ");
}

function logManifestBundle(message) {
  console.log(`[manifest-bundle] ${message}`);
}

function scheduleManifestVaultBackfill(env, manifest, options = {}) {
  if (manifest?.source !== "fallback" || !manifest.bytes?.length) return null;
  if (typeof options.waitUntil !== "function" && !options.awaitBackfills) return null;

  const task = publishManifestVaultFile(env, manifest.fileName, manifest.bytes, "External Vault")
    .then((result) => {
      if (result?.uploaded) {
        logManifestBundle(`Backfilled ${manifest.fileName} into ManifestVault at ${result.path}.`);
      } else {
        logManifestBundle(`ManifestVault backfill skipped for ${manifest.fileName}: ${result?.reason || "not uploaded"}.`);
      }
      return result;
    })
    .catch((error) => {
      logManifestBundle(`ManifestVault backfill failed for ${manifest.fileName}: ${error.message}`);
      return enqueueManifestBackfill(env, {
        fileName: manifest.fileName,
        url: manifest.url,
        source: "External Vault"
      }).then((queued) => ({
        uploaded: false,
        queued: queued?.queued || false,
        error: error.message
      }));
    });

  if (typeof options.waitUntil === "function") {
    options.waitUntil(task);
  }
  if (options.awaitBackfills) {
    return task;
  }
  return null;
}

function candidatePaths(env, appId, fileName) {
  const paths = getConfiguredBasePaths(env);
  return databaseConfigs(env).flatMap((database) =>
    paths.map((basePath) => {
      const path = basePath ? `${basePath}/${fileName}` : fileName;
      return {
        database,
        fileName,
        url: joinUrl(database.base, path)
      };
    })
  );
}

async function getIndexEntry(indexUrl, appId) {
  try {
    const index = await fetchJson(indexUrl, { timeout: 8000 });
    const apps = index?.apps && typeof index.apps === "object" ? index.apps : index;
    const entry = apps?.[appId];
    if (!entry) return null;
    if (typeof entry === "string") return { zip: entry };
    if (typeof entry === "object") return entry;
    return null;
  } catch {
    return null;
  }
}

async function findIndexedZip(env, appId) {
  const paths = getConfiguredBasePaths(env);
  for (const database of databaseConfigs(env)) {
    for (const basePath of paths) {
      const indexPath = basePath ? `${basePath}/index.json` : "index.json";
      const entry = await getIndexEntry(joinUrl(database.base, indexPath), appId);
      if (!entry?.zip) continue;
      const zipPath = basePath ? `${basePath}/${entry.zip}` : entry.zip;
      const url = joinUrl(database.base, zipPath);
      if (await headExists(url)) {
        return { database, fileName: entry.zip, url };
      }
    }
  }
  return null;
}

async function resolveExternalApi(env, appId) {
  const directUrl = env.GAMEGEN_API_URL
    ? buildGameGenGenerateUrl(env.GAMEGEN_API_URL, appId)
    : null;
  const keyedUrl = env.GAMEGEN_API_KEY
    ? `${(env.GAMEGEN_API_BASE || "https://gamegen.lol/api").replace(/\/$/, "")}/${env.GAMEGEN_API_KEY}/generate/${appId}`
    : null;
  const url = directUrl || keyedUrl;
  if (!url) return null;

  try {
    const data = await fetchJsonAny(url, 15000);
    if (data?.success === false) return null;
    const downloadUrl =
      data?.data?.manifest?.downloadUrl ||
      data?.manifest?.downloadUrl ||
      data?.downloadUrl ||
      data?.download_url;
    if (!downloadUrl) return null;

    const result = await downloadExternalZip(absoluteFromUrl(url, downloadUrl), appId, { allowLink: true });
    return result?.kind === "api" || result?.kind === "api-link" ? result : null;
  } catch {
    const directZip = await downloadExternalZip(withQuery(url, "format", "zip"), appId, { allowLink: false }).catch(() => null);
    if (directZip?.kind === "api") return directZip;
  }

  return null;
}

export async function lookupRepositoryPackage(env, appId, options = {}) {
  const includeBytes = options.includeBytes !== false;
  for (const candidate of candidatePaths(env, appId, `${appId}.zip`)) {
    if (await headExists(candidate.url)) {
      const zipBytes = includeBytes ? await downloadBytes(candidate.url) : undefined;
      const enriched = includeBytes ? await enrichZipWithMissingManifests(env, appId, zipBytes, options) : null;
      return {
        source: "Used Colorado State RP Repo",
        manifestSource: enriched?.manifestSource || "",
        manifestCount: enriched?.manifestCount || 0,
        kind: "zip",
        fileName: candidate.fileName,
        bytes: enriched?.bytes ?? zipBytes,
        url: candidate.url
      };
    }
  }

  for (const candidate of candidatePaths(env, appId, `${appId}.lua`)) {
    if (await headExists(candidate.url)) {
      const luaBytes = includeBytes ? await downloadBytes(candidate.url) : null;
      const manifests = includeBytes ? await collectRequiredManifests(env, appId, luaBytes, options) : [];
      return {
        source: "Used Colorado State RP Repo",
        manifestSource: summarizeManifestSources(manifests),
        manifestCount: manifests.length,
        kind: "lua",
        fileName: `${appId}.zip`,
        bytes: includeBytes ? createLuaManifestZip(appId, luaBytes, manifests) : undefined,
        url: candidate.url
      };
    }
  }

  const indexed = await findIndexedZip(env, appId);
  if (indexed) {
    const zipBytes = includeBytes ? await downloadBytes(indexed.url) : undefined;
    const enriched = includeBytes ? await enrichZipWithMissingManifests(env, appId, zipBytes, options) : null;
    return {
      source: "Used Colorado State RP Repo",
      manifestSource: enriched?.manifestSource || "",
        manifestCount: enriched?.manifestCount || 0,
      kind: "indexed-zip",
      fileName: indexed.fileName.endsWith(".zip") ? indexed.fileName : `${appId}.zip`,
      bytes: enriched?.bytes ?? zipBytes,
      url: indexed.url
    };
  }

  return null;
}

async function downloadExternalZip(url, appId, options = {}) {
  const zipResponse = await fetchWithTimeout(url, {
    timeout: 30000,
    headers: {
      Accept: "application/zip, application/octet-stream, */*",
      "Cache-Control": "no-cache",
      "User-Agent": "ColoradoStateRPBot/1.0"
    },
    cf: { cacheTtl: 0 }
  });
  const bytes = new Uint8Array(await zipResponse.arrayBuffer());
  if (zipResponse.ok && isZipBytes(bytes)) {
    return {
      source: "Used External API",
      kind: "api",
      manifestCount: 0,
      fileName: `${appId}.zip`,
      bytes,
      url
    };
  }
  if (isVpnBlocked(bytes)) {
    if (!options.allowLink) return null;
    return {
      source: "Used External API",
      kind: "api-link",
      fileName: `${appId}.zip`,
      downloadUrl: url,
      blockedReason: "GameGen blocked Cloudflare Worker file download."
    };
  }
  return null;
}

export function isZipBytes(bytes) {
  return bytes?.[0] === 0x50 && bytes?.[1] === 0x4b && bytes?.[2] === 0x03 && bytes?.[3] === 0x04;
}

function isVpnBlocked(bytes) {
  try {
    return new TextDecoder().decode(bytes).includes("VPN_BLOCKED");
  } catch {
    return false;
  }
}

export function externalDownloadUrl(env, appId) {
  const directUrl = env.GAMEGEN_API_URL
    ? buildGameGenGenerateUrl(env.GAMEGEN_API_URL, appId)
    : env.GAMEGEN_API_KEY
      ? `${(env.GAMEGEN_API_BASE || "https://gamegen.lol/api").replace(/\/$/, "")}/${env.GAMEGEN_API_KEY}/generate/${appId}`
      : "";
  return directUrl ? withQuery(directUrl, "format", "zip") : "";
}

function externalLinkResult(env, appId, reason = "External API file is available as a direct download.") {
  const downloadUrl = externalDownloadUrl(env, appId);
  if (!downloadUrl) return null;
  return {
    source: "Used External API",
    kind: "api-link",
    fileName: `${appId}.zip`,
    downloadUrl,
    blockedReason: reason
  };
}

export function buildGameGenGenerateUrl(baseUrl, appId) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  if (raw.includes("{APP_ID}")) return raw.replace("{APP_ID}", appId);
  return `${raw.replace(/\/+$/, "")}/${appId}`;
}

function absoluteFromUrl(baseUrl, value) {
  const raw = String(value || "");
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, baseUrl).toString();
}

function withQuery(url, key, value) {
  const result = new URL(url);
  result.searchParams.set(key, value);
  return result.toString();
}

export async function lookupPackage(env, appId, options = {}) {
  const repositoryResult = await lookupRepositoryPackage(env, appId, options);
  if (repositoryResult) return repositoryResult;
  return resolveExternalApi(env, appId);
}

function steamAsset(appId, fileName) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/${fileName}`;
}

function normalizeGameDetails(appId, game) {
  const name = String(game?.name || "").trim();
  if (!name) throw new Error("Missing game name.");
  const publishers = Array.isArray(game.publishers)
    ? game.publishers.filter(Boolean)
    : game.publisher
      ? [game.publisher]
      : [];
  const release = game.release_date && typeof game.release_date === "object"
    ? game.release_date.date
    : game.release_date || game.releaseDate || "Unknown";
  const developers = Array.isArray(game.developers)
    ? game.developers.filter(Boolean)
    : game.developer
      ? String(game.developer).split(",").map((item) => item.trim()).filter(Boolean)
      : [];
  const genres = Array.isArray(game.genres)
    ? game.genres.map((genre) => genre?.description || genre).filter(Boolean)
    : game.genre
      ? String(game.genre).split(",").map((item) => item.trim()).filter(Boolean)
      : [];
  return {
    appId,
    name,
    publishers,
    developers,
    genres,
    releaseDate: release || "Unknown",
    banner: game.header_image || steamAsset(appId, "header.jpg")
  };
}

export async function fetchGameDetails(appId) {
  const steamUrl = `${STORE_DETAILS_URL}${appId}&filters=${STORE_DETAILS_FILTERS}`;
  const steamPromise = fetchJsonAny(steamUrl, 12000).then((data) => {
    const entry = data?.[appId];
    if (!entry?.success || !entry.data) throw new Error("Steam returned no game data.");
    return normalizeGameDetails(appId, entry.data);
  });

  const spyPromise = fetchJsonAny(`${STEAMSPY_DETAILS_URL}${appId}`, 12000).then((data) =>
    normalizeGameDetails(appId, {
      name: data.name,
      publishers: data.publisher ? [data.publisher] : [],
      developers: data.developer ? [data.developer] : [],
      genre: data.genre || "",
      release_date: { date: data.release_date || "Unknown" },
      header_image: steamAsset(appId, "header.jpg")
    })
  );

  const settled = await Promise.allSettled([steamPromise, spyPromise]);
  const games = settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);

  if (games.length) {
    return games.sort((a, b) => gameDetailScore(b) - gameDetailScore(a))[0];
  }

  return {
    appId,
    name: `Steam App ${appId}`,
    publishers: [],
    developers: [],
    genres: [],
    releaseDate: "Unknown",
    banner: steamAsset(appId, "header.jpg")
  };
}

function gameDetailScore(game) {
  let score = 0;
  if (game.name && game.name !== `Steam App ${game.appId}`) score += 3;
  if (game.releaseDate && game.releaseDate !== "Unknown") score += 3;
  if (game.publishers.length) score += 2;
  if (game.banner && !game.banner.endsWith("/header.jpg")) score += 1;
  return score;
}

export function formatGameDetails(game) {
  return [
    `Game: ${game.name}`,
    `AppID: ${game.appId}`,
    `Publisher: ${game.publishers.length ? game.publishers.join(", ") : "Unknown"}`,
    `Release: ${game.releaseDate}`
  ].join("\n");
}

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

export function parseSteamSuggestHtml(html) {
  const choices = [];
  const seen = new Set();
  const blocks = String(html || "").match(/<a\b[\s\S]*?<\/a>/gi) || [];

  for (const block of blocks) {
    const appMatch = block.match(/\/app\/(\d+)(?:\/|["?])/i);
    if (!appMatch) continue;
    const appId = appMatch[1];
    if (seen.has(appId)) continue;
    const nameMatch =
      block.match(/class=["'][^"']*match_name[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i) ||
      block.match(/data-ds-appid=["']\d+["'][\s\S]*?>([\s\S]*?)<\/a>/i);
    const rawName = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, " ") : "";
    const name = decodeHtml(rawName);
    if (!name) continue;
    const imageMatch = block.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
    seen.add(appId);
    const choice = {
      name: `${name} (${appId})`.slice(0, 100),
      value: appId
    };
    if (imageMatch) choice.image = decodeHtml(imageMatch[1]);
    choices.push(choice);
    if (choices.length >= 25) break;
  }

  return choices;
}

export async function searchSteamSuggestions(term) {
  const query = String(term || "").trim();
  if (!query || /^\d+$/.test(query)) return [];
  const url = `${STEAM_SUGGEST_URL}?term=${encodeURIComponent(query)}&f=games&cc=US&l=english`;
  const response = await fetchWithTimeout(url, {
    timeout: 8000,
    headers: { Accept: "text/html, */*" }
  });
  if (!response.ok) return [];
  return parseSteamSuggestHtml(await response.text());
}
