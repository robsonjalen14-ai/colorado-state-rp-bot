import { fetchWithTimeout, getConfiguredBasePaths, normalizeBasePath, truncate } from "./utils.js";

const GITHUB_API = "https://api.github.com";

function githubConfig(env) {
  const owner = env.GITHUB_OWNER || "BlissBlender";
  const repo = env.GITHUB_REPO || "Colorado-State-RP-Database";
  const branch = env.GITHUB_BRANCH || "main";
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured.");
  return { owner, repo, branch, token: env.GITHUB_TOKEN };
}

function manifestVaultConfig(env) {
  const owner = env.MANIFEST_VAULT_OWNER || env.GITHUB_OWNER || "BlissBlender";
  const repo = env.MANIFEST_VAULT_REPO || "ManifestVault";
  const branch = env.MANIFEST_VAULT_BRANCH || env.GITHUB_BRANCH || "main";
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured.");
  return { owner, repo, branch, token: env.GITHUB_TOKEN };
}

function databaseFolder(databaseId) {
  return databaseId === "database-2" ? "database-2" : "database-1";
}

function uploadBasePath(env) {
  const first = getConfiguredBasePaths(env).find((path) => normalizeBasePath(path) === "");
  return first ?? "";
}

export function databaseUploadPaths(env, fileName) {
  const basePath = uploadBasePath(env);
  return ["database-1", "database-2"].map((database) => {
    const folder = databaseFolder(database);
    return [folder, basePath, fileName].filter(Boolean).join("/");
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.slice(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || "").replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function githubRequestWithConfig(config, path, options = {}) {
  const response = await fetchWithTimeout(`${GITHUB_API}${path}`, {
    timeout: options.timeout ?? 30000,
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ColoradoStateRPBot/1.0",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`GitHub ${response.status}: ${truncate(text, 300)}`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

async function githubRequest(env, path, options = {}) {
  return githubRequestWithConfig(githubConfig(env), path, options);
}

function contentPathForConfig(config, filePath) {
  return `/repos/${config.owner}/${config.repo}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}`;
}

function contentPath(env, filePath) {
  return contentPathForConfig(githubConfig(env), filePath);
}

async function getFile(env, filePath) {
  const config = githubConfig(env);
  try {
    return await githubRequest(env, `${contentPath(env, filePath)}?ref=${encodeURIComponent(config.branch)}`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function getFileWithConfig(config, filePath) {
  try {
    return await githubRequestWithConfig(config, `${contentPathForConfig(config, filePath)}?ref=${encodeURIComponent(config.branch)}`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function existingFileBytes(existing) {
  if (!existing) return null;
  if (existing.content) return base64ToBytes(existing.content);
  if (existing.download_url) {
    const response = await fetchWithTimeout(existing.download_url, { timeout: 60000 });
    if (!response.ok) throw new Error(`GitHub raw download failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  return null;
}

async function putFile(env, filePath, bytes, message, sha = undefined) {
  const config = githubConfig(env);
  return githubRequest(env, contentPath(env, filePath), {
    method: "PUT",
    timeout: 60000,
    body: {
      message,
      content: bytesToBase64(bytes),
      branch: config.branch,
      sha
    }
  });
}

async function putFileWithConfig(config, filePath, bytes, message, sha = undefined) {
  return githubRequestWithConfig(config, contentPathForConfig(config, filePath), {
    method: "PUT",
    timeout: 60000,
    body: {
      message,
      content: bytesToBase64(bytes),
      branch: config.branch,
      sha
    }
  });
}

async function deleteFile(env, filePath, sha, message) {
  const config = githubConfig(env);
  return githubRequest(env, contentPath(env, filePath), {
    method: "DELETE",
    timeout: 60000,
    body: {
      message,
      sha,
      branch: config.branch
    }
  });
}

async function restoreSnapshot(env, snapshot, message) {
  if (!snapshot.existed) {
    const current = await getFile(env, snapshot.path);
    if (current?.sha) await deleteFile(env, snapshot.path, current.sha, message).catch(() => null);
    return;
  }
  if (!snapshot.bytes) return;
  const current = await getFile(env, snapshot.path);
  await putFile(env, snapshot.path, snapshot.bytes, message, current?.sha);
}

export async function publishNewManifest(env, appId, fileName, bytes, uploadedBy) {
  const paths = databaseUploadPaths(env, fileName);
  const snapshots = [];
  const uploaded = [];

  try {
    for (const path of paths) {
      const existing = await getFile(env, path);
      if (existing) throw new Error(`${path} already exists.`);
      snapshots.push({ path, existed: false });
    }

    for (const path of paths) {
      await putFile(env, path, bytes, `Publish manifest ${fileName} for ${appId} by ${uploadedBy}`);
      uploaded.push(path);
    }

    return { paths: uploaded };
  } catch (error) {
    await Promise.allSettled(snapshots.map((snapshot) =>
      restoreSnapshot(env, snapshot, `Rollback failed publish for ${fileName}`)
    ));
    throw error;
  }
}

function manifestVaultUploadPath(env, fileName) {
  const cleanFileName = String(fileName || "").split(/[\\/]/).filter(Boolean).pop();
  if (!/^\d+_\d+\.manifest$/i.test(cleanFileName || "")) {
    throw new Error(`Invalid manifest filename: ${fileName}`);
  }
  const basePath = String(env.MANIFEST_VAULT_BASE_PATH || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  return [basePath, cleanFileName].filter(Boolean).join("/");
}

export async function publishManifestVaultFile(env, fileName, bytes, sourceLabel = "External Vault") {
  const config = manifestVaultConfig(env);
  const path = manifestVaultUploadPath(env, fileName);
  const existing = await getFileWithConfig(config, path);
  if (existing) {
    return { uploaded: false, path, reason: "exists" };
  }

  await putFileWithConfig(
    config,
    path,
    bytes,
    `Backfill ${fileName} from ${sourceLabel}`
  );

  return { uploaded: true, path };
}

export async function readManifestVaultFile(env, fileName) {
  const config = manifestVaultConfig(env);
  const path = manifestVaultUploadPath(env, fileName);
  const existing = await getFileWithConfig(config, path);
  if (!existing) return null;
  const bytes = await existingFileBytes(existing);
  return bytes?.length ? { fileName, path, bytes, source: "primary", url: existing.download_url || "" } : null;
}

export async function healthCheck(env) {
  const checks = {
    githubToken: Boolean(env.GITHUB_TOKEN),
    discordToken: Boolean(env.DISCORD_TOKEN),
    botStorage: Boolean(env.BOT_STORAGE),
    coloradoStateRpDatabase: false,
    manifestVault: false
  };

  const errors = [];
  try {
    const config = githubConfig(env);
    await githubRequestWithConfig(config, `/repos/${config.owner}/${config.repo}`);
    checks.coloradoStateRpDatabase = true;
  } catch (error) {
    errors.push(`Colorado State RP database: ${error.message}`);
  }

  try {
    const config = manifestVaultConfig(env);
    await githubRequestWithConfig(config, `/repos/${config.owner}/${config.repo}`);
    checks.manifestVault = true;
  } catch (error) {
    errors.push(`ManifestVault: ${error.message}`);
  }

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    errors
  };
}

export async function publishFixManifest(env, appId, fileName, bytes, uploadedBy) {
  return publishReplacingManifest(env, appId, fileName, bytes, uploadedBy, "Repair");
}

export async function publishReplacingManifest(env, appId, fileName, bytes, uploadedBy, label = "Publish") {
  const extPaths = [`${appId}.zip`, `${appId}.lua`].flatMap((name) => databaseUploadPaths(env, name));
  const uploadPaths = databaseUploadPaths(env, fileName);
  const allPaths = [...new Set([...extPaths, ...uploadPaths])];
  const snapshots = [];

  try {
    for (const path of allPaths) {
      const existing = await getFile(env, path);
      snapshots.push({
        path,
        existed: Boolean(existing),
        sha: existing?.sha,
        bytes: await existingFileBytes(existing)
      });
    }

    for (const snapshot of snapshots) {
      if (snapshot.existed) {
        await deleteFile(env, snapshot.path, snapshot.sha, `Remove old manifest variant for ${appId}`);
      }
    }

    for (const path of uploadPaths) {
      await putFile(env, path, bytes, `${label} manifest ${fileName} for ${appId} by ${uploadedBy}`);
    }

    return { paths: uploadPaths };
  } catch (error) {
    await Promise.allSettled(snapshots.map((snapshot) =>
      restoreSnapshot(env, snapshot, `Rollback failed ${label.toLowerCase()} for ${fileName}`)
    ));
    throw error;
  }
}

export async function countDatabaseFiles(env) {
  const config = githubConfig(env);
  const result = {};
  for (const folder of ["database-1", "database-2"]) {
    try {
      const items = await githubRequest(env, `/repos/${config.owner}/${config.repo}/contents/${folder}?ref=${encodeURIComponent(config.branch)}`);
      result[folder] = Array.isArray(items)
        ? items.filter((item) => /\.(zip|lua)$/i.test(item.name || "")).length
        : 0;
    } catch {
      result[folder] = 0;
    }
  }
  return result;
}
