const axios = require("axios");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const {
  ONEDRIVE_TENANT_ID,
  ONEDRIVE_CLIENT_ID,
  ONEDRIVE_CLIENT_SECRET,
  ONEDRIVE_DRIVE_ID,
  ONEDRIVE_FOLDER_ID,
  ONEDRIVE_SITE_ID,
  ONEDRIVE_FOLDER_URL
} = process.env;

const ONEDRIVE_CACHE_TTL_MS = Number(process.env.ONEDRIVE_CACHE_TTL_MS) || 5 * 60 * 1000;
const ONEDRIVE_CONTEXT_DOCUMENTS = Number(process.env.ONEDRIVE_CONTEXT_DOCUMENTS) || 3;
const ONEDRIVE_MAX_FILE_SIZE_BYTES = Number(process.env.ONEDRIVE_MAX_FILE_SIZE_BYTES) || 2 * 1024 * 1024;

const graphClient = axios.create({
  baseURL: "https://graph.microsoft.com/v1.0",
  timeout: 20000
});

const tokenCache = {
  token: null,
  expiresAt: 0
};

const oneDriveCache = {
  documents: null,
  expiresAt: 0
};

function sanitizeEnvValue(value = "") {
  return String(value).trim();
}

function maskSecret(value = "") {
  const normalized = sanitizeEnvValue(value);

  if (!normalized) {
    return "(empty)";
  }

  if (normalized.length <= 6) {
    return "***";
  }

  return `${normalized.slice(0, 3)}***${normalized.slice(-3)}`;
}

function isConfigured() {
  const hasCredentials = [
    ONEDRIVE_TENANT_ID,
    ONEDRIVE_CLIENT_ID,
    ONEDRIVE_CLIENT_SECRET
  ].every((value) => Boolean(sanitizeEnvValue(value)));

  const hasDirectTarget = [
    ONEDRIVE_DRIVE_ID,
    ONEDRIVE_FOLDER_ID
  ].every((value) => Boolean(sanitizeEnvValue(value)));

  return hasCredentials && (hasDirectTarget || Boolean(sanitizeEnvValue(ONEDRIVE_FOLDER_URL)));
}

function hasPartialConfig() {
  return [
    ONEDRIVE_TENANT_ID,
    ONEDRIVE_CLIENT_ID,
    ONEDRIVE_CLIENT_SECRET,
    ONEDRIVE_DRIVE_ID,
    ONEDRIVE_FOLDER_ID,
    ONEDRIVE_SITE_ID,
    ONEDRIVE_FOLDER_URL
  ].some((value) => Boolean(sanitizeEnvValue(value))) && !isConfigured();
}

function getOneDriveConfigSummary() {
  return {
    enabled: isConfigured(),
    partialConfig: hasPartialConfig(),
    tenantId: sanitizeEnvValue(ONEDRIVE_TENANT_ID),
    clientId: sanitizeEnvValue(ONEDRIVE_CLIENT_ID),
    clientSecretPreview: maskSecret(ONEDRIVE_CLIENT_SECRET),
    driveId: sanitizeEnvValue(ONEDRIVE_DRIVE_ID),
    siteId: sanitizeEnvValue(ONEDRIVE_SITE_ID),
    folderId: sanitizeEnvValue(ONEDRIVE_FOLDER_ID),
    folderUrl: sanitizeEnvValue(ONEDRIVE_FOLDER_URL)
  };
}

if (hasPartialConfig()) {
  console.warn(
    "OneDrive environment variables are partially configured. OneDrive knowledge retrieval stays disabled until all required values are present."
  );
}

function stripHtml(html = "") {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(text = "") {
  return stripHtml(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text = "") {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length >= 2);
}

function scoreDocument(document, query) {
  const normalizedQuery = normalizeText(query);
  const queryTokens = tokenize(query);
  const title = normalizeText(document.title || "");
  const searchText = normalizeText(`${document.title || ""} ${document.body || ""}`);

  if (!normalizedQuery || queryTokens.length === 0 || !searchText) {
    return 0;
  }

  let score = 0;

  if (title.includes(normalizedQuery)) {
    score += 15;
  }

  if (searchText.includes(normalizedQuery)) {
    score += 10;
  }

  for (const token of queryTokens) {
    if (title.includes(token)) {
      score += 4;
    }

    if (searchText.includes(token)) {
      score += 1;
    }
  }

  return score;
}

function truncateText(text, maxLength = 1800) {
  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength).trim()}...`;
}

function getFileExtension(fileName = "") {
  return path.extname(String(fileName)).toLowerCase();
}

function isSupportedDocument(item = {}) {
  const extension = getFileExtension(item.name);
  return [".txt", ".md", ".csv", ".json", ".html", ".htm", ".docx"].includes(extension);
}

async function getAccessToken() {
  if (!isConfigured()) {
    return null;
  }

  const now = Date.now();

  if (tokenCache.token && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: sanitizeEnvValue(ONEDRIVE_CLIENT_ID),
    client_secret: sanitizeEnvValue(ONEDRIVE_CLIENT_SECRET),
    scope: "https://graph.microsoft.com/.default"
  });

  const response = await axios.post(
    `https://login.microsoftonline.com/${sanitizeEnvValue(ONEDRIVE_TENANT_ID)}/oauth2/v2.0/token`,
    body.toString(),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      timeout: 20000
    }
  );

  tokenCache.token = response.data?.access_token || null;
  tokenCache.expiresAt = now + (Number(response.data?.expires_in) || 3600) * 1000;

  return tokenCache.token;
}

async function graphGet(url, accessToken, config = {}) {
  return graphClient.get(url, {
    ...config,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(config.headers || {})
    }
  });
}

function encodeGraphPath(pathname = "") {
  return String(pathname)
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function parseSharePointFolderUrl(folderUrl = "") {
  const normalizedUrl = sanitizeEnvValue(folderUrl);

  if (!normalizedUrl) {
    return null;
  }

  const parsedUrl = new URL(normalizedUrl);
  const rawId = sanitizeEnvValue(parsedUrl.searchParams.get("id"));
  const decodedId = rawId ? decodeURIComponent(rawId) : "";
  const normalizedId = decodedId.replace(/\/+$/, "");

  if (!normalizedId.startsWith("/")) {
    throw new Error("ONEDRIVE_FOLDER_URL is missing a valid SharePoint folder path.");
  }

  let sitePath = "/";
  let documentPath = normalizedId;

  const multiSegmentRoots = ["/sites/", "/teams/", "/personal/"];
  const matchingRoot = multiSegmentRoots.find((root) => normalizedId.startsWith(root));

  if (matchingRoot) {
    const pathSegments = normalizedId.split("/").filter(Boolean);

    if (pathSegments.length < 3) {
      throw new Error("ONEDRIVE_FOLDER_URL does not contain a resolvable SharePoint site path.");
    }

    sitePath = `/${pathSegments.slice(0, 2).join("/")}`;
    documentPath = `/${pathSegments.slice(2).join("/")}`;
  }

  const libraryPrefixes = ["/Shared Documents/", "/Documents/"];
  const matchingLibraryPrefix = libraryPrefixes.find((prefix) => documentPath.startsWith(prefix));
  const driveRelativePath = matchingLibraryPrefix
    ? documentPath.slice(matchingLibraryPrefix.length)
    : documentPath.replace(/^\/+/, "");

  if (!driveRelativePath) {
    throw new Error("ONEDRIVE_FOLDER_URL points to a document library root instead of a folder.");
  }

  return {
    hostname: parsedUrl.hostname,
    sitePath,
    documentPath,
    driveRelativePath
  };
}

async function resolveSiteId(accessToken, folderUrlDetails) {
  const configuredSiteId = sanitizeEnvValue(ONEDRIVE_SITE_ID);

  if (!folderUrlDetails && configuredSiteId) {
    return configuredSiteId;
  }

  if (!folderUrlDetails || folderUrlDetails.sitePath === "/") {
    const response = await graphGet("/sites/root", accessToken);
    return response.data?.id || null;
  }

  const response = await graphGet(
    `/sites/${folderUrlDetails.hostname}:${folderUrlDetails.sitePath}`,
    accessToken
  );

  return response.data?.id || null;
}

async function resolveTarget(accessToken) {
  const configuredFolderUrl = sanitizeEnvValue(ONEDRIVE_FOLDER_URL);

  if (configuredFolderUrl) {
    const folderUrlDetails = parseSharePointFolderUrl(configuredFolderUrl);
    const siteId = await resolveSiteId(accessToken, folderUrlDetails);

    if (!siteId) {
      throw new Error("Unable to resolve SharePoint site from ONEDRIVE_FOLDER_URL.");
    }

    const driveResponse = await graphGet(`/sites/${siteId}/drive`, accessToken);
    const driveId = driveResponse.data?.id || null;

    if (!driveId) {
      throw new Error("Unable to resolve SharePoint document library drive from ONEDRIVE_FOLDER_URL.");
    }

    const encodedPath = encodeGraphPath(folderUrlDetails.driveRelativePath);
    const folderResponse = await graphGet(
      `/drives/${driveId}/root:/${encodedPath}:?$select=id,name,webUrl,parentReference,folder`,
      accessToken
    );
    const folderId = folderResponse.data?.id || null;

    if (!folderId) {
      throw new Error("Unable to resolve SharePoint folder from ONEDRIVE_FOLDER_URL.");
    }

    return {
      driveId,
      folderId,
      source: "url",
      siteId,
      path: folderUrlDetails.driveRelativePath
    };
  }

  return {
    driveId: sanitizeEnvValue(ONEDRIVE_DRIVE_ID),
    folderId: sanitizeEnvValue(ONEDRIVE_FOLDER_ID),
    source: "direct",
    siteId: sanitizeEnvValue(ONEDRIVE_SITE_ID) || null,
    path: null
  };
}

async function listFolderChildren(accessToken, driveId, itemId) {
  const children = [];
  let nextPageUrl = `/drives/${driveId}/items/${itemId}/children?$top=200&select=id,name,size,webUrl,lastModifiedDateTime,file,folder,parentReference,@microsoft.graph.downloadUrl`;

  while (nextPageUrl) {
    const response = await graphGet(nextPageUrl, accessToken);
    const pageItems = Array.isArray(response.data?.value) ? response.data.value : [];
    children.push(...pageItems);
    nextPageUrl = response.data?.["@odata.nextLink"] || null;
  }

  return children;
}

async function collectDocuments(accessToken, driveId, folderId) {
  const documents = [];
  const queue = [folderId];

  while (queue.length > 0) {
    const currentFolderId = queue.shift();
    const children = await listFolderChildren(accessToken, driveId, currentFolderId);

    for (const child of children) {
      if (child.folder) {
        queue.push(child.id);
        continue;
      }

      if (!child.file || !isSupportedDocument(child)) {
        continue;
      }

      if (Number(child.size) > ONEDRIVE_MAX_FILE_SIZE_BYTES) {
        continue;
      }

      documents.push(child);
    }
  }

  return documents;
}

async function parseDocxBuffer(buffer) {
  const tempFilePath = path.join(os.tmpdir(), `libar-onedrive-${randomUUID()}.docx`);

  try {
    await fs.writeFile(tempFilePath, buffer);
    const { stdout } = await execFileAsync("/usr/bin/textutil", [
      "-convert",
      "txt",
      "-stdout",
      tempFilePath
    ]);

    return stdout.trim();
  } finally {
    await fs.unlink(tempFilePath).catch(() => {});
  }
}

async function parseDocumentContent(item, buffer) {
  const extension = getFileExtension(item.name);
  const rawText = buffer.toString("utf8");

  if (extension === ".docx") {
    try {
      return await parseDocxBuffer(buffer);
    } catch (error) {
      console.warn("Failed to parse OneDrive DOCX document:", {
        fileName: item.name,
        fileId: item.id,
        message: error.message
      });
      return "";
    }
  }

  if (extension === ".html" || extension === ".htm") {
    return stripHtml(rawText);
  }

  return rawText.trim();
}

async function downloadDocument(accessToken, item) {
  const downloadUrl = item["@microsoft.graph.downloadUrl"];

  if (!downloadUrl) {
    return null;
  }

  const response = await axios.get(downloadUrl, {
    responseType: "arraybuffer",
    timeout: 20000
  });

  const body = await parseDocumentContent(item, Buffer.from(response.data));

  if (!body) {
    return null;
  }

  return {
    id: item.id,
    title: item.name,
    body: truncateText(body, 4000),
    path: item.parentReference?.path || "",
    url: item.webUrl || null,
    lastModifiedAt: item.lastModifiedDateTime || null,
    source: "onedrive"
  };
}

async function fetchFolderDocuments() {
  if (!isConfigured()) {
    return [];
  }

  const now = Date.now();

  if (oneDriveCache.documents && oneDriveCache.expiresAt > now) {
    return oneDriveCache.documents;
  }

  const accessToken = await getAccessToken();
  const target = await resolveTarget(accessToken);
  const items = await collectDocuments(accessToken, target.driveId, target.folderId);
  const documents = [];

  for (const item of items) {
    const parsedDocument = await downloadDocument(accessToken, item);

    if (parsedDocument) {
      documents.push(parsedDocument);
    }
  }

  oneDriveCache.documents = documents;
  oneDriveCache.expiresAt = now + ONEDRIVE_CACHE_TTL_MS;

  return documents;
}

async function searchOneDriveDetailed(query) {
  if (!isConfigured()) {
    return null;
  }

  try {
    const documents = await fetchFolderDocuments();

    if (documents.length === 0) {
      return null;
    }

    const rankedDocuments = documents
      .map((document) => ({
        document,
        score: scoreDocument(document, query)
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, ONEDRIVE_CONTEXT_DOCUMENTS);

    if (rankedDocuments.length === 0) {
      return null;
    }

    const context = rankedDocuments
      .map(({ document, score }, index) => [
        `Dokument ${index + 1}:`,
        `Izvor: OneDrive`,
        `Naslov: ${document.title}`,
        `Relevantnost: ${score}`,
        `Sadržaj: ${truncateText(document.body, 1800)}`
      ].join("\n"))
      .join("\n\n");

    return {
      context,
      articles: rankedDocuments.map(({ document, score }) => ({
        id: document.id,
        title: document.title,
        score,
        body: truncateText(document.body, 1800),
        source: "onedrive",
        url: document.url || null
      })),
      topScore: rankedDocuments[0]?.score || 0,
      totalMatches: rankedDocuments.length
    };
  } catch (error) {
    console.error("OneDrive retrieval failed:", {
      message: error.message,
      status: error.response?.status,
      responseData: error.response?.data
    });

    return null;
  }
}

async function searchOneDrive(query) {
  const result = await searchOneDriveDetailed(query);
  return result?.context || null;
}

module.exports = {
  fetchFolderDocuments,
  getOneDriveConfigSummary,
  isConfigured,
  searchOneDrive,
  searchOneDriveDetailed
};
