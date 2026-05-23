import { createLuaZip } from "./zip.js";
import { fetchJson, fetchWithTimeout, getConfiguredBasePaths, joinUrl } from "./utils.js";

const STORE_DETAILS_URL = "https://store.steampowered.com/api/appdetails?appids=";
const STORE_DETAILS_FILTERS = "basic,release_date,publishers";
const STEAMSPY_DETAILS_URL = "https://steamspy.com/api.php?request=appdetails&appid=";

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

  const directZip = await downloadExternalZip(withQuery(url, "format", "zip"), appId);
  if (directZip) return directZip;

  try {
    const data = await fetchJsonAny(url, 15000);
    if (data?.success === false) return null;
    const downloadUrl =
      data?.data?.manifest?.downloadUrl ||
      data?.manifest?.downloadUrl ||
      data?.downloadUrl ||
      data?.download_url;
    if (downloadUrl) {
      const bytes = await downloadBytes(absoluteFromUrl(url, downloadUrl), 30000);
      if (!isZipBytes(bytes)) return null;
      return {
        source: "Used External API",
        kind: "api",
        fileName: `${appId}.zip`,
        bytes
      };
    }
  } catch {
    return null;
  }

  return null;
}

async function downloadExternalZip(url, appId) {
  const zipResponse = await fetchWithTimeout(url, {
    timeout: 30000,
    headers: { Accept: "application/zip" }
  });
  if (!zipResponse.ok) return null;
  const bytes = new Uint8Array(await zipResponse.arrayBuffer());
  if (!isZipBytes(bytes)) return null;
  return {
    source: "Used External API",
    kind: "api",
    fileName: `${appId}.zip`,
    bytes
  };
}

export function isZipBytes(bytes) {
  return bytes?.[0] === 0x50 && bytes?.[1] === 0x4b && bytes?.[2] === 0x03 && bytes?.[3] === 0x04;
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

export async function lookupPackage(env, appId) {
  for (const candidate of candidatePaths(env, appId, `${appId}.zip`)) {
    if (await headExists(candidate.url)) {
      return {
        source: "Used Charon Repo",
        kind: "zip",
        fileName: candidate.fileName,
        bytes: await downloadBytes(candidate.url),
        url: candidate.url
      };
    }
  }

  for (const candidate of candidatePaths(env, appId, `${appId}.lua`)) {
    if (await headExists(candidate.url)) {
      const luaBytes = await downloadBytes(candidate.url);
      return {
        source: "Used Charon Repo",
        kind: "lua",
        fileName: `${appId}.zip`,
        bytes: createLuaZip(appId, luaBytes),
        url: candidate.url
      };
    }
  }

  const indexed = await findIndexedZip(env, appId);
  if (indexed) {
    return {
      source: "Used Charon Repo",
      kind: "indexed-zip",
      fileName: indexed.fileName.endsWith(".zip") ? indexed.fileName : `${appId}.zip`,
      bytes: await downloadBytes(indexed.url),
      url: indexed.url
    };
  }

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
  return {
    appId,
    name,
    publishers,
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
