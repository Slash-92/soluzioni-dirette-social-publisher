import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const BUFFER_API = "https://api.buffer.com";
const DEFAULT_DATA_SOURCE_ID = "";
const DEFAULT_MEDIA_BASE = "";
const DEFAULT_SCHEDULE_HORIZON_DAYS = 10;
const DEFAULT_QUEUE_TARGET_PER_CHANNEL = 9;
const MANAGEABLE_BUFFER_STATUSES = new Set(["sent", "published", "scheduled", "buffer", "sending"]);
const scriptDir = import.meta.dirname;
const repoRoot = path.resolve(scriptDir, "..");
const statePath = process.env.NOTION_SYNC_STATE_PATH
  ? path.resolve(process.env.NOTION_SYNC_STATE_PATH)
  : process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, "notion-sync-state.json")
    : path.join(scriptDir, "notion-sync-state.json");

export function isManageableBufferStatus(status) {
  return MANAGEABLE_BUFFER_STATUSES.has(status);
}

export function deriveEntryStatus(statuses) {
  return statuses.every((status) => ["sent", "published"].includes(status)) ? "published" : "scheduled";
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function richTextValue(property) {
  return (property?.rich_text ?? []).map((item) => item.plain_text ?? "").join("");
}

function titleValue(property) {
  return (property?.title ?? []).map((item) => item.plain_text ?? "").join("");
}

function splitLines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function sanitizeSegment(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function propertyFile(file, index) {
  const url = file.type === "external" ? file.external?.url : file.file?.url;
  if (!url) return null;
  const rawName = file.name || `asset-${index + 1}`;
  const extension = path.extname(new URL(url).pathname) || path.extname(rawName);
  const stem = path.basename(rawName, path.extname(rawName));
  const safeStem = sanitizeSegment(stem) || `asset-${index + 1}`;
  return { name: `${String(index + 1).padStart(2, "0")}-${safeStem}${extension.toLowerCase()}`, url };
}

export function parseNotionPage(page) {
  const properties = page.properties ?? {};
  const format = properties.Formato?.multi_select?.[0]?.name ?? properties.Formato?.select?.name ?? "";
  return {
    id: page.id,
    url: page.url,
    title: titleValue(properties.Contenuto),
    brand: properties.Brand?.select?.name ?? "",
    status: properties["Stato pubblicazione"]?.select?.name ?? "",
    ready: properties["Pronto per pubblicazione"]?.checkbox === true
      && properties["Grafica pronta"]?.checkbox === true
      && properties["Caption pronta"]?.checkbox === true,
    format,
    caption: richTextValue(properties.Caption),
    dueAt: properties.Data?.date?.start ?? "",
    key: richTextValue(properties["Chiave automazione"]) || page.id.replaceAll("-", ""),
    bufferRefs: splitLines(richTextValue(properties["Buffer IDs"])),
    publicUrls: splitLines(richTextValue(properties["URL media pubblici"])),
    mediaFiles: (properties.Media?.files ?? []).map(propertyFile).filter(Boolean),
    channels: (properties.Canali?.multi_select ?? []).map((item) => item.name.toLowerCase()),
  };
}

function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function isVideo(url) {
  return /\.(mp4|mov|m4v)(?:$|\?)/i.test(url);
}

export function isPublishableMediaFile(name) {
  return /\.(png|jpe?g|mp4|mov|m4v)$/i.test(name);
}

export function countHashtags(value) {
  return value.match(/(^|[^\p{L}\p{N}_])#[\p{L}\p{N}_]+/gu)?.length ?? 0;
}

function validateCaption(page) {
  if (!page.caption.trim()) throw new Error(`${page.title}: caption obbligatoria per ${page.format}`);
  const hashtagCount = countHashtags(page.caption);
  if (hashtagCount > 5) throw new Error(`${page.title}: massimo 5 hashtag, trovati ${hashtagCount}`);
}

export function buildJobs(page) {
  if (!page.dueAt || Number.isNaN(Date.parse(page.dueAt))) throw new Error(`${page.title}: Data mancante o non valida`);
  if (!page.publicUrls.length) throw new Error(`${page.title}: nessun URL media pubblico`);
  if (["Story", "Stories"].includes(page.format)) {
    return page.publicUrls.map((url, index) => ({ type: "story", dueAt: addMinutes(page.dueAt, index), caption: "", urls: [url] }));
  }
  validateCaption(page);
  if (["Feed singolo", "Post singolo"].includes(page.format)) {
    if (page.publicUrls.length !== 1) throw new Error(`${page.title}: il feed singolo richiede un asset`);
    return [{ type: "post", dueAt: new Date(page.dueAt).toISOString(), caption: page.caption, urls: page.publicUrls }];
  }
  if (page.format === "Carosello") {
    if (page.publicUrls.length < 2 || page.publicUrls.length > 10) throw new Error(`${page.title}: il carosello richiede da 2 a 10 asset`);
    return [{ type: "post", dueAt: new Date(page.dueAt).toISOString(), caption: page.caption, urls: page.publicUrls }];
  }
  if (page.format === "Reel") {
    if (page.publicUrls.length !== 1 || !isVideo(page.publicUrls[0])) throw new Error(`${page.title}: il Reel richiede un solo file video`);
    return [{ type: "reel", dueAt: new Date(page.dueAt).toISOString(), caption: page.caption, urls: page.publicUrls }];
  }
  throw new Error(`${page.title}: formato non supportato (${page.format || "vuoto"})`);
}

export function configuredChannels() {
  const channels = [];
  if (process.env.BUFFER_INSTAGRAM_CHANNEL_ID) channels.push({ platform: "instagram", channelId: process.env.BUFFER_INSTAGRAM_CHANNEL_ID });
  if (process.env.BUFFER_FACEBOOK_CHANNEL_ID) channels.push({ platform: "facebook", channelId: process.env.BUFFER_FACEBOOK_CHANNEL_ID });
  if (!channels.length) throw new Error("Nessun canale Buffer configurato");
  if (new Set(channels.map(({ channelId }) => channelId)).size !== channels.length) {
    throw new Error("I canali Buffer Instagram e Facebook devono avere ID distinti");
  }
  return channels;
}

export function buildOperations(page, channels = configuredChannels()) {
  if (!page.channels.length) throw new Error(`${page.title}: selezionare almeno un canale in Notion`);
  const selected = new Set(page.channels);
  const jobs = buildJobs(page);
  const operations = channels
    .filter(({ platform }) => selected.has(platform))
    .flatMap(({ platform, channelId }) => jobs.map((job, index) => ({
      ...job,
      platform,
      channelId,
      operationKey: `${platform}:${index + 1}`,
    })));
  if (!operations.length) throw new Error(`${page.title}: nessun canale Buffer valido selezionato`);
  return operations;
}

function parseBufferRefs(refs) {
  return new Map(refs.map((line) => {
    const separator = line.lastIndexOf(":");
    return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : ["legacy:1", line];
  }));
}

function serializeBufferRefs(refs) {
  return [...refs.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, id]) => `${key}:${id}`);
}

export function buildBufferInput(job, channelId, saveToDraft = true) {
  const platform = job.platform;
  const metadata = platform === "facebook"
    ? { facebook: { type: job.type === "post" ? "post" : job.type } }
    : { instagram: { type: job.type, shouldShareToFeed: job.type !== "story", isAiGenerated: false } };
  return {
    text: job.caption ?? "",
    channelId,
    schedulingType: "automatic",
    mode: "customScheduled",
    dueAt: job.dueAt,
    saveToDraft,
    needsApproval: false,
    aiAssisted: false,
    source: "soluzioni-dirette-notion-sync",
    assets: job.urls.map((url) => (isVideo(url) ? { video: { url } } : { image: { url } })),
    metadata,
  };
}

export function operationFingerprint(operation) {
  const input = buildBufferInput(operation, operation.channelId, false);
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function shouldRefreshScheduledPost(status, previousFingerprint, nextFingerprint) {
  return ["scheduled", "buffer"].includes(status) && previousFingerprint !== nextFingerprint;
}

export function decideAction(page, stateEntry = {}) {
  const refs = page.bufferRefs.length ? page.bufferRefs : stateEntry.bufferRefs ?? [];
  if (refs.length) return "reconcile";
  if (!page.publicUrls.length && page.mediaFiles.length) return "prepare-media";
  if (!page.publicUrls.length) return "missing-media";
  if (["Da programmare", "Errore"].includes(page.status) && page.ready) return "create";
  return "ignore";
}

export function requiresMediaCheck(action) {
  return action === "create";
}

export function isMediaPreparationCandidate(page) {
  return page.brand === "Soluzioni Dirette"
    && page.ready
    && !page.publicUrls.length
    && page.mediaFiles.length > 0;
}

export function isEligibleSyncPage(page) {
  return isMediaPreparationCandidate(page)
    || (page.brand === "Soluzioni Dirette"
      && (page.status === "Programmato" || (page.ready && ["Da programmare", "Errore"].includes(page.status))));
}

export function shouldDeferCreation(dueAt, now = new Date(), horizonDays = DEFAULT_SCHEDULE_HORIZON_DAYS) {
  const dueTime = Date.parse(dueAt);
  if (Number.isNaN(dueTime)) return false;
  return dueTime - now.getTime() > horizonDays * 86_400_000;
}

export function missingOperations(operations, knownRefs = new Map()) {
  return operations.filter((operation) => !knownRefs.has(operation.operationKey));
}

export function requiredQueueSlots(operations, knownRefs = new Map()) {
  const required = new Map();
  for (const operation of missingOperations(operations, knownRefs)) {
    required.set(operation.channelId, (required.get(operation.channelId) ?? 0) + 1);
  }
  return required;
}

export function hasQueueCapacity(queueCounts, operations, knownRefs = new Map(), target = DEFAULT_QUEUE_TARGET_PER_CHANNEL) {
  for (const [channelId, required] of requiredQueueSlots(operations, knownRefs)) {
    if ((queueCounts.get(channelId) ?? 0) + required > target) return false;
  }
  return true;
}

export function reserveQueueCapacity(queueCounts, operations, knownRefs = new Map()) {
  for (const [channelId, required] of requiredQueueSlots(operations, knownRefs)) {
    queueCounts.set(channelId, (queueCounts.get(channelId) ?? 0) + required);
  }
}

async function notionRequest(endpoint, { method = "GET", body } = {}) {
  const token = process.env.NOTION_API_TOKEN;
  if (!token) throw new Error("NOTION_API_TOKEN non configurato");
  const response = await fetch(`${NOTION_API}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(`Notion HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function queryNotionPages() {
  const dataSourceId = process.env.NOTION_DATA_SOURCE_ID || DEFAULT_DATA_SOURCE_ID;
  if (!dataSourceId) throw new Error("NOTION_DATA_SOURCE_ID non configurato");
  const pages = [];
  let cursor;
  do {
    const payload = await notionRequest(`/data_sources/${dataSourceId}/query`, {
      method: "POST",
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    pages.push(...payload.results);
    cursor = payload.has_more ? payload.next_cursor : null;
  } while (cursor);
  return pages.map(parseNotionPage);
}

function textProperty(value) {
  return { rich_text: value ? [{ type: "text", text: { content: value } }] : [] };
}

async function updateNotion(pageId, changes) {
  const properties = {};
  if ("bufferRefs" in changes) properties["Buffer IDs"] = textProperty(changes.bufferRefs.join("\n"));
  if ("publicUrls" in changes) properties["URL media pubblici"] = textProperty(changes.publicUrls.join("\n"));
  if ("status" in changes) properties["Stato pubblicazione"] = { select: { name: changes.status } };
  if ("publishedUrl" in changes) properties["Link pubblicato"] = { url: changes.publishedUrl || null };
  if ("error" in changes) properties["Errore automazione"] = textProperty(changes.error ?? "");
  if ("syncedAt" in changes) properties["Ultima sincronizzazione"] = { date: { start: changes.syncedAt } };
  await notionRequest(`/pages/${pageId}`, { method: "PATCH", body: { properties } });
}

async function bufferRequest(query, variables) {
  const apiKey = process.env.BUFFER_API_KEY;
  if (!apiKey) throw new Error("BUFFER_API_KEY non configurata");
  const response = await fetch(BUFFER_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    const message = `Buffer HTTP ${response.status}: ${await response.text()}`;
    const error = new Error(message);
    if (response.status === 429) error.code = "BUFFER_RATE_LIMIT";
    throw error;
  }
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(`Buffer GraphQL: ${payload.errors.map((error) => error.message).join("; ")}`);
  return payload.data;
}

const CREATE_POST = `mutation CreatePost($input: CreatePostInput!) { createPost(input: $input) { __typename ... on PostActionSuccess { post { id status dueAt } } ... on MutationError { message } } }`;
const EDIT_POST = `mutation EditPost($input: EditPostInput!) { editPost(input: $input) { __typename ... on PostActionSuccess { post { id status dueAt } } ... on MutationError { message } } }`;
const GET_POST = `query GetPost($input: PostInput!) { post(input: $input) { id status dueAt sentAt externalLink } }`;
const GET_POST_ORGANIZATION = `query PostOrganization($input: PostInput!) { post(input: $input) { channel { id organizationId } } }`;
const GET_SCHEDULED_POSTS = `query ScheduledPosts($organizationId: OrganizationId!) { posts(first: 100, input: { organizationId: $organizationId, filter: { status: [scheduled] } }) { edges { node { id channelId status } } } }`;

function seedPostIdsByPlatform(state, pages = []) {
  const seeds = new Map();
  for (const entry of Object.values(state.pages ?? {})) {
    for (const job of Object.values(entry.jobs ?? {})) {
      if (job.platform && job.postId && !seeds.has(job.platform)) seeds.set(job.platform, job.postId);
    }
  }
  for (const page of pages) {
    for (const [operationKey, postId] of parseBufferRefs(page.bufferRefs ?? [])) {
      const platform = operationKey.split(":", 1)[0];
      if (["instagram", "facebook"].includes(platform) && postId && !seeds.has(platform)) {
        seeds.set(platform, postId);
      }
    }
  }
  return seeds;
}

async function getQueueCounts(channels, state, pages = []) {
  const counts = new Map(channels.map(({ channelId }) => [channelId, 0]));
  const organizationIds = new Set(splitLines(process.env.BUFFER_ORGANIZATION_IDS || ""));
  if (!organizationIds.size) {
    const seeds = seedPostIdsByPlatform(state, pages);
    for (const { platform } of channels) {
      const postId = seeds.get(platform);
      if (!postId) throw new Error(`Impossibile determinare l'organizzazione Buffer per ${platform}: nessun post noto nello stato`);
      const data = await bufferRequest(GET_POST_ORGANIZATION, { input: { id: postId } });
      organizationIds.add(data.post.channel.organizationId);
    }
  }
  for (const organizationId of organizationIds) {
    const data = await bufferRequest(GET_SCHEDULED_POSTS, { organizationId });
    for (const { node } of data.posts.edges ?? []) {
      if (counts.has(node.channelId)) counts.set(node.channelId, counts.get(node.channelId) + 1);
    }
  }
  return counts;
}

function actionPost(payload, operation) {
  if (payload.__typename === "PostActionSuccess") return payload.post;
  throw new Error(`${operation}: ${payload.message ?? payload.__typename}`);
}

async function checkMedia(urls) {
  for (const url of urls) {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "facebookexternalhit/1.1 (+https://www.facebook.com/externalhit_uatext.php)",
        Range: "bytes=0-1023",
      },
    });
    if (!response.ok) throw new Error(`Media non raggiungibile (${response.status}): ${url}`);
    const contentType = response.headers.get("content-type") || "";
    if (!/^(image|video)\//i.test(contentType)) throw new Error(`MIME media non valido (${contentType || "assente"}): ${url}`);
    const body = new Uint8Array(await response.arrayBuffer());
    if (!body.byteLength) throw new Error(`Media vuoto: ${url}`);
  }
}

async function prepareMedia(page) {
  const baseUrl = (process.env.PUBLIC_MEDIA_BASE_URL || DEFAULT_MEDIA_BASE).replace(/\/$/, "");
  if (!baseUrl.startsWith("https://")) throw new Error("PUBLIC_MEDIA_BASE_URL HTTPS non configurato");
  const safeKey = sanitizeSegment(page.key) || page.id.replaceAll("-", "");
  const targetDir = path.join(repoRoot, "media", "notion", safeKey);
  await mkdir(targetDir, { recursive: true });
  const publicUrls = [];
  for (const file of page.mediaFiles) {
    if (!isPublishableMediaFile(file.name)) continue;
    const response = await fetch(file.url, { redirect: "follow" });
    if (!response.ok) throw new Error(`Download asset fallito (${response.status}): ${file.name}`);
    await writeFile(path.join(targetDir, file.name), new Uint8Array(await response.arrayBuffer()));
    publicUrls.push(`${baseUrl}/notion/${encodeURIComponent(safeKey)}/${encodeURIComponent(file.name)}`);
  }
  if (!publicUrls.length) throw new Error(`${page.title}: allegare almeno un PNG, JPG o video compatibile`);
  await updateNotion(page.id, { publicUrls, error: "", syncedAt: new Date().toISOString() });
}

async function createAndSchedule(page, operations, state) {
  const entry = state.pages[page.id] ?? { key: page.key, bufferRefs: [], jobs: {} };
  state.pages[page.id] = entry;
  const refs = parseBufferRefs(page.bufferRefs.length ? page.bufferRefs : entry.bufferRefs ?? []);
  for (const operation of operations) {
    if (refs.has(operation.operationKey)) continue;
    const data = await bufferRequest(CREATE_POST, { input: buildBufferInput(operation, operation.channelId, true) });
    const post = actionPost(data.createPost, `Creazione bozza ${page.key}/${operation.operationKey}`);
    refs.set(operation.operationKey, post.id);
    entry.bufferRefs = serializeBufferRefs(refs);
    entry.jobs[operation.operationKey] = {
      postId: post.id,
      platform: operation.platform,
      status: "draft",
      dueAt: operation.dueAt,
      fingerprint: operationFingerprint(operation),
    };
    await saveState(state);
    await updateNotion(page.id, { bufferRefs: entry.bufferRefs, syncedAt: new Date().toISOString() });
  }
  for (const operation of operations) {
    const postId = refs.get(operation.operationKey);
    const current = await bufferRequest(GET_POST, { input: { id: postId } });
    if (isManageableBufferStatus(current.post.status)) {
      entry.jobs[operation.operationKey] = {
        postId,
        platform: operation.platform,
        status: current.post.status,
        dueAt: current.post.dueAt ?? operation.dueAt,
        fingerprint: operationFingerprint(operation),
      };
      continue;
    }
    const draftInput = buildBufferInput(operation, operation.channelId, false);
    const { channelId: _channelId, needsApproval: _needsApproval, ...editable } = draftInput;
    const data = await bufferRequest(EDIT_POST, { input: { ...editable, id: postId } });
    const post = actionPost(data.editPost, `Programmazione ${page.key}/${operation.operationKey}`);
    entry.jobs[operation.operationKey] = {
      postId,
      platform: operation.platform,
      status: post.status,
      dueAt: post.dueAt,
      fingerprint: operationFingerprint(operation),
    };
    await saveState(state);
  }
  entry.bufferRefs = serializeBufferRefs(refs);
  entry.status = "scheduled";
  await saveState(state);
  await updateNotion(page.id, { bufferRefs: entry.bufferRefs, status: "Programmato", error: "", syncedAt: new Date().toISOString() });
}

async function reconcile(page, operations, state) {
  const entry = state.pages[page.id] ?? { key: page.key, bufferRefs: page.bufferRefs, jobs: {} };
  state.pages[page.id] = entry;
  const refs = parseBufferRefs(page.bufferRefs.length ? page.bufferRefs : entry.bufferRefs ?? []);
  const missing = operations.filter((operation) => !refs.has(operation.operationKey));
  if (missing.length) {
    await createAndSchedule(page, operations, state);
    return;
  }
  const statuses = [];
  const publishedUrls = [];
  for (const operation of operations) {
    const postId = refs.get(operation.operationKey);
    const data = await bufferRequest(GET_POST, { input: { id: postId } });
    let post = data.post;
    const fingerprint = operationFingerprint(operation);
    const previousFingerprint = entry.jobs?.[operation.operationKey]?.fingerprint;
    if (post.status === "draft" || shouldRefreshScheduledPost(post.status, previousFingerprint, fingerprint)) {
      const draftInput = buildBufferInput(operation, operation.channelId, false);
      const { channelId: _channelId, needsApproval: _needsApproval, ...editable } = draftInput;
      const scheduled = await bufferRequest(EDIT_POST, { input: { ...editable, id: postId } });
      const operationLabel = post.status === "draft" ? "Ripresa bozza" : "Aggiornamento programmato";
      post = actionPost(scheduled.editPost, `${operationLabel} ${page.key}/${operation.operationKey}`);
    }
    if (!isManageableBufferStatus(post.status)) {
      throw new Error(`${page.title}: stato Buffer non gestibile (${post.status}) per ${post.id}`);
    }
    statuses.push(post.status);
    if (post.externalLink) publishedUrls.push(post.externalLink);
    entry.jobs[operation.operationKey] = {
      postId: post.id,
      platform: operation.platform,
      status: post.status,
      dueAt: post.dueAt ?? operation.dueAt,
      fingerprint,
    };
  }
  entry.bufferRefs = serializeBufferRefs(refs);
  entry.status = deriveEntryStatus(statuses);
  await saveState(state);
  const status = entry.status === "published" ? "Pubblicato" : "Programmato";
  await updateNotion(page.id, {
    ...(page.status !== status ? { status } : {}),
    ...(entry.status === "published" && publishedUrls[0] ? { publishedUrl: publishedUrls[0] } : {}),
    error: "",
    syncedAt: new Date().toISOString(),
  });
}

async function main() {
  if (hasFlag("--validate-config")) {
    console.log(JSON.stringify({ notionDataSourceId: process.env.NOTION_DATA_SOURCE_ID || DEFAULT_DATA_SOURCE_ID, publicMediaBaseUrl: process.env.PUBLIC_MEDIA_BASE_URL || DEFAULT_MEDIA_BASE, channels: configuredChannels(), scheduleHorizonDays: Number.parseFloat(process.env.BUFFER_SCHEDULE_HORIZON_DAYS || String(DEFAULT_SCHEDULE_HORIZON_DAYS)) }, null, 2));
    return;
  }
  if (hasFlag("--report-queue")) {
    const channels = configuredChannels();
    const state = await readJson(statePath, { schemaVersion: 2, pages: {} });
    const pages = await queryNotionPages();
    const counts = await getQueueCounts(channels, state, pages);
    const target = Number.parseInt(process.env.BUFFER_QUEUE_TARGET_PER_CHANNEL || String(DEFAULT_QUEUE_TARGET_PER_CHANNEL), 10);
    console.log(JSON.stringify({
      targetPerChannel: target,
      channels: channels.map(({ platform, channelId }) => ({
        platform,
        channelId,
        scheduled: counts.get(channelId) ?? 0,
        availableWithinTarget: Math.max(0, target - (counts.get(channelId) ?? 0)),
      })),
    }, null, 2));
    return;
  }
  const dryRun = hasFlag("--dry-run");
  const mediaOnly = hasFlag("--media-only");
  const pages = (await queryNotionPages()).sort((left, right) => {
    const leftTime = Date.parse(left.dueAt);
    const rightTime = Date.parse(right.dueAt);
    if (Number.isNaN(leftTime)) return 1;
    if (Number.isNaN(rightTime)) return -1;
    return leftTime - rightTime;
  });
  const state = await readJson(statePath, { schemaVersion: 2, pages: {} });
  const horizonDays = Number.parseFloat(process.env.BUFFER_SCHEDULE_HORIZON_DAYS || String(DEFAULT_SCHEDULE_HORIZON_DAYS));
  const queueTarget = Number.parseInt(process.env.BUFFER_QUEUE_TARGET_PER_CHANNEL || String(DEFAULT_QUEUE_TARGET_PER_CHANNEL), 10);
  const channels = mediaOnly ? [] : configuredChannels();
  let queueCounts;
  const summary = { total: pages.length, ignored: 0, deferred: 0, capacityDeferred: 0, preparedMedia: 0, created: 0, reconciled: 0, errors: 0, rateLimited: false };
  for (const page of pages) {
    const eligible = mediaOnly ? isMediaPreparationCandidate(page) : isEligibleSyncPage(page);
    if (!eligible) {
      summary.ignored += 1;
      continue;
    }
    const action = decideAction(page, state.pages[page.id]);
    if (action === "create" && shouldDeferCreation(page.dueAt, new Date(), horizonDays)) {
      summary.deferred += 1;
      continue;
    }
    if (dryRun) {
      console.log(JSON.stringify({ page: page.title, key: page.key, action, bufferRefs: page.bufferRefs, channels: page.channels }, null, 2));
      continue;
    }
    try {
      if (action === "prepare-media") {
        await prepareMedia(page);
        summary.preparedMedia += 1;
        continue;
      }
      if (action === "missing-media") throw new Error(`${page.title}: allegare i file in Media o compilare URL media pubblici`);
      if (action === "ignore") {
        summary.ignored += 1;
        continue;
      }
      const operations = buildOperations(page, channels);
      const knownRefs = parseBufferRefs(page.bufferRefs.length ? page.bufferRefs : state.pages[page.id]?.bufferRefs ?? []);
      const effectiveAction = action === "reconcile" && operations.some((operation) => !knownRefs.has(operation.operationKey))
        ? "create"
        : action;
      if (requiresMediaCheck(effectiveAction)) await checkMedia(page.publicUrls);
      if (effectiveAction === "reconcile") {
        await reconcile(page, operations, state);
        summary.reconciled += 1;
      } else {
        queueCounts ??= await getQueueCounts(channels, state, pages);
        if (!hasQueueCapacity(queueCounts, operations, knownRefs, queueTarget)) {
          summary.capacityDeferred += 1;
          console.log(`${page.key}: coda Buffer piena rispetto alla soglia ${queueTarget}; contenuto lasciato in Notion per il prossimo passaggio.`);
          continue;
        }
        await createAndSchedule(page, operations, state);
        reserveQueueCapacity(queueCounts, operations, knownRefs);
        summary.created += 1;
      }
    } catch (error) {
      if (error.code === "BUFFER_RATE_LIMIT") {
        summary.rateLimited = true;
        console.warn(`${page.key}: limite Buffer raggiunto; sincronizzazione interrotta e rinviata al prossimo passaggio.`);
        break;
      }
      summary.errors += 1;
      console.error(`${page.key}: ${error.message}`);
      await updateNotion(page.id, { status: "Errore", error: error.message, syncedAt: new Date().toISOString() });
    }
  }
  if (!mediaOnly) await saveState(state);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
