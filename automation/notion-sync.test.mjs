import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildBufferInput,
  buildJobs,
  buildOperations,
  configuredChannels,
  countHashtags,
  decideAction,
  deriveEntryStatus,
  isEligibleSyncPage,
  isManageableBufferStatus,
  operationFingerprint,
  parseNotionPage,
  requiresMediaCheck,
  shouldRefreshScheduledPost,
  shouldDeferCreation,
} from "./notion-sync.mjs";

function richText(content) {
  return { type: "rich_text", rich_text: content ? [{ plain_text: content }] : [] };
}

function pageFixture(overrides = {}) {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    url: "https://notion.so/test",
    properties: {
      Contenuto: { type: "title", title: [{ plain_text: "Contenuto test" }] },
      Brand: { type: "select", select: { name: "Soluzioni Dirette" } },
      "Stato pubblicazione": { type: "select", select: { name: "Da programmare" } },
      "Pronto per pubblicazione": { type: "checkbox", checkbox: true },
      "Grafica pronta": { type: "checkbox", checkbox: true },
      "Caption pronta": { type: "checkbox", checkbox: true },
      Formato: { type: "multi_select", multi_select: [{ name: "Carosello" }] },
      Caption: richText("Caption"),
      Data: { type: "date", date: { start: "2026-09-10T11:00:00+02:00" } },
      "Chiave automazione": richText("test-key"),
      "Buffer IDs": richText(""),
      "URL media pubblici": richText("https://example.com/01.png\nhttps://example.com/02.png"),
      Media: { type: "files", files: [] },
      Canali: { type: "multi_select", multi_select: [{ name: "Instagram" }, { name: "Facebook" }] },
      ...overrides,
    },
  };
}

test("parsa la riga Notion e preserva l'ordine degli URL", () => {
  const page = parseNotionPage(pageFixture());
  assert.equal(page.title, "Contenuto test");
  assert.equal(page.key, "test-key");
  assert.deepEqual(page.publicUrls, ["https://example.com/01.png", "https://example.com/02.png"]);
});

test("un ID Buffer esistente forza la sola riconciliazione", () => {
  const parsed = parseNotionPage(pageFixture({ "Buffer IDs": richText("existing-buffer-id") }));
  assert.equal(decideAction(parsed), "reconcile");
});

test("una riga in errore senza ID viene ritentata", () => {
  const parsed = parseNotionPage(pageFixture({
    "Stato pubblicazione": { type: "select", select: { name: "Errore" } },
  }));
  assert.equal(decideAction(parsed), "create");
});

test("un carosello produce una sola operazione con asset ordinati", () => {
  const jobs = buildJobs(parseNotionPage(pageFixture()));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, "post");
  assert.deepEqual(jobs[0].urls, ["https://example.com/01.png", "https://example.com/02.png"]);
});

test("un carosello genera una operazione distinta per Instagram e Facebook", () => {
  const operations = buildOperations(parseNotionPage(pageFixture()), [
    { platform: "instagram", channelId: "ig-id" },
    { platform: "facebook", channelId: "fb-id" },
  ]);
  assert.equal(operations.length, 2);
  assert.deepEqual(operations.map((item) => item.operationKey), ["instagram:1", "facebook:1"]);
  assert.equal(buildBufferInput(operations[0], operations[0].channelId).metadata.instagram.type, "post");
  assert.equal(buildBufferInput(operations[1], operations[1].channelId).metadata.facebook.type, "post");
  assert.equal(buildBufferInput(operations[1], operations[1].channelId).source, "soluzioni-dirette-notion-sync");
});

test("senza canali espliciti la pubblicazione fallisce in sicurezza", () => {
  const parsed = parseNotionPage(pageFixture({ Canali: { type: "multi_select", multi_select: [] } }));
  assert.throws(() => buildOperations(parsed, [
    { platform: "instagram", channelId: "ig-id" },
    { platform: "facebook", channelId: "fb-id" },
  ]), /selezionare almeno un canale/);
});

test("gli ID dei canali Instagram e Facebook devono essere distinti", () => {
  const previousInstagram = process.env.BUFFER_INSTAGRAM_CHANNEL_ID;
  const previousFacebook = process.env.BUFFER_FACEBOOK_CHANNEL_ID;
  process.env.BUFFER_INSTAGRAM_CHANNEL_ID = "same-id";
  process.env.BUFFER_FACEBOOK_CHANNEL_ID = "same-id";
  try {
    assert.throws(() => configuredChannels(), /devono avere ID distinti/);
  } finally {
    if (previousInstagram === undefined) delete process.env.BUFFER_INSTAGRAM_CHANNEL_ID;
    else process.env.BUFFER_INSTAGRAM_CHANNEL_ID = previousInstagram;
    if (previousFacebook === undefined) delete process.env.BUFFER_FACEBOOK_CHANNEL_ID;
    else process.env.BUFFER_FACEBOOK_CHANNEL_ID = previousFacebook;
  }
});

test("le Stories diventano operazioni separate a un minuto di distanza", () => {
  const parsed = parseNotionPage(pageFixture({
    Formato: { type: "multi_select", multi_select: [{ name: "Story" }] },
    Caption: richText("Testo che non deve essere inviato #uno #due #tre #quattro #cinque #sei"),
  }));
  const jobs = buildJobs(parsed);
  assert.equal(jobs.length, 2);
  assert.equal(Date.parse(jobs[1].dueAt) - Date.parse(jobs[0].dueAt), 60_000);
  assert.equal(jobs[0].caption, "");
});

test("post, caroselli e Reel richiedono una caption", () => {
  const parsed = parseNotionPage(pageFixture({ Caption: richText("") }));
  assert.throws(() => buildJobs(parsed), /caption obbligatoria/);
});

test("le caption accettano al massimo cinque hashtag", () => {
  assert.equal(countHashtags("Testo #uno #due #tre #quattro #cinque"), 5);
  const parsed = parseNotionPage(pageFixture({
    Caption: richText("Testo #uno #due #tre #quattro #cinque #sei"),
  }));
  assert.throws(() => buildJobs(parsed), /massimo 5 hashtag, trovati 6/);
});

test("un Reel richiede un MP4 e genera un video Buffer", () => {
  const parsed = parseNotionPage(pageFixture({
    Formato: { type: "multi_select", multi_select: [{ name: "Reel" }] },
    "URL media pubblici": richText("https://example.com/reel.mp4"),
  }));
  const [job] = buildJobs(parsed);
  const input = buildBufferInput(job, "channel-id");
  assert.equal(input.metadata.instagram.type, "reel");
  assert.equal(input.assets[0].video.url, "https://example.com/reel.mp4");
});

test("una riga approvata senza ID viene creata una sola volta", () => {
  const parsed = parseNotionPage(pageFixture());
  assert.equal(decideAction(parsed), "create");
  assert.equal(decideAction(parsed, { bufferRefs: ["instagram:1:state-id"] }), "reconcile");
});

test("gli URL pubblici mancanti preparano i file senza chiamare Buffer", () => {
  const parsed = parseNotionPage(pageFixture({
    "URL media pubblici": richText(""),
    Media: {
      type: "files",
      files: [{ name: "slide.png", type: "external", external: { url: "https://example.com/slide.png" } }],
    },
  }));
  assert.equal(decideAction(parsed), "prepare-media");
});

test("lo stato transitorio sending resta gestibile senza falso errore", () => {
  assert.equal(isManageableBufferStatus("sending"), true);
  assert.equal(deriveEntryStatus(["sending"]), "scheduled");
  assert.equal(deriveEntryStatus(["sent"]), "published");
});

test("la riconciliazione non dipende dalla disponibilita temporanea dei media", () => {
  assert.equal(requiresMediaCheck("create"), true);
  assert.equal(requiresMediaCheck("reconcile"), false);
});

test("un post programmato viene aggiornato solo se copy, media o orario cambiano", () => {
  const [operation] = buildOperations(parseNotionPage(pageFixture()), [
    { platform: "instagram", channelId: "ig-id" },
  ]);
  const fingerprint = operationFingerprint(operation);
  assert.equal(shouldRefreshScheduledPost("scheduled", undefined, fingerprint), true);
  assert.equal(shouldRefreshScheduledPost("scheduled", fingerprint, fingerprint), false);
  assert.equal(shouldRefreshScheduledPost("published", undefined, fingerprint), false);
  assert.equal(shouldRefreshScheduledPost("sent", undefined, fingerprint), false);
  assert.equal(shouldRefreshScheduledPost("sending", undefined, fingerprint), false);
});

test("una nuova pubblicazione resta differita oltre l'orizzonte Buffer", () => {
  const now = new Date("2026-08-21T12:00:00.000Z");
  assert.equal(shouldDeferCreation("2026-09-09T16:30:00.000Z", now, 10), true);
  assert.equal(shouldDeferCreation("2026-08-30T16:30:00.000Z", now, 10), false);
  assert.equal(shouldDeferCreation("data-non-valida", now, 10), false);
});

test("una riga già pubblicata non consuma più richieste Buffer", () => {
  const published = parseNotionPage(pageFixture({ "Stato pubblicazione": { type: "select", select: { name: "Pubblicato" } } }));
  const scheduled = parseNotionPage(pageFixture({ "Stato pubblicazione": { type: "select", select: { name: "Programmato" } } }));
  assert.equal(isEligibleSyncPage(published), false);
  assert.equal(isEligibleSyncPage(scheduled), true);
});

test("una riga programmata resta riconciliabile anche se l'approvazione viene tolta", () => {
  const scheduled = parseNotionPage(pageFixture({
    "Stato pubblicazione": { type: "select", select: { name: "Programmato" } },
    "Pronto per pubblicazione": { type: "checkbox", checkbox: false },
  }));
  assert.equal(isEligibleSyncPage(scheduled), true);
});

test("una riga di un brand diverso viene sempre ignorata", () => {
  const codesyn = parseNotionPage(pageFixture({ Brand: { type: "select", select: { name: "Codesyn" } } }));
  assert.equal(isEligibleSyncPage(codesyn), false);
});
