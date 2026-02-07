#!/usr/bin/env node

import fs from "fs";
import path from "path";

export function ensureJobPipeline(state) {
  if (!state.job_pipeline) state.job_pipeline = {};
  if (!Array.isArray(state.job_pipeline.pending_materials)) state.job_pipeline.pending_materials = [];
  if (!Array.isArray(state.job_pipeline.materials_ready)) state.job_pipeline.materials_ready = [];
  if (!Array.isArray(state.job_pipeline.submitted_applications)) state.job_pipeline.submitted_applications = [];
  if (!state.job_pipeline.review || typeof state.job_pipeline.review !== "object") {
    state.job_pipeline.review = {};
  }
  if (!Array.isArray(state.job_pipeline.review.skippedQueueIds)) {
    state.job_pipeline.review.skippedQueueIds = [];
  }
  if (typeof state.job_pipeline.review.currentQueueId !== "string") {
    state.job_pipeline.review.currentQueueId = null;
  }
}

function normalizeToken(value, fallback = "unknown") {
  const token = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return token || fallback;
}

function hashText(value) {
  let hash = 0;
  for (const ch of String(value || "")) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16);
}

export function queueIdForEntry(entry) {
  if (entry?.queueId) return String(entry.queueId);
  if (entry?.jobId) return `q_job_${normalizeToken(entry.jobId)}`;
  if (entry?.folderName) return `q_folder_${normalizeToken(entry.folderName)}`;
  const signature = `${entry?.company || "unknown"}|${entry?.title || "unknown"}`;
  return `q_sig_${hashText(signature)}`;
}

export function withQueueId(entry) {
  if (!entry) return entry;
  return {
    ...entry,
    queueId: queueIdForEntry(entry),
  };
}

export function samePipelineEntry(a, b) {
  if (!a || !b) return false;
  const qA = a.queueId || queueIdForEntry(a);
  const qB = b.queueId || queueIdForEntry(b);
  if (qA && qB && qA === qB) return true;
  if (a.jobId && b.jobId && String(a.jobId) === String(b.jobId)) return true;
  if (a.folderName && b.folderName && a.folderName === b.folderName) return true;
  return false;
}

export function dedupePipelineEntries(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries || []) {
    const normalized = withQueueId(entry);
    const key = normalized.queueId || JSON.stringify(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function normalizePipelineEntriesInState(state) {
  ensureJobPipeline(state);
  state.job_pipeline.pending_materials = dedupePipelineEntries(state.job_pipeline.pending_materials);
  state.job_pipeline.materials_ready = dedupePipelineEntries(state.job_pipeline.materials_ready);
  state.job_pipeline.submitted_applications = dedupePipelineEntries(state.job_pipeline.submitted_applications);
}

export function sortReviewItems(a, b) {
  const scoreA = Number(a.score ?? 0);
  const scoreB = Number(b.score ?? 0);
  if (scoreB !== scoreA) return scoreB - scoreA;

  const timeA = Date.parse(
    a.materialsReadyAt || a.materialsReadyDate || a.createdAt || a.preppedAt || 0
  ) || 0;
  const timeB = Date.parse(
    b.materialsReadyAt || b.materialsReadyDate || b.createdAt || b.preppedAt || 0
  ) || 0;
  return timeB - timeA;
}

function resolveListing(cacheListings, entry) {
  const listings = cacheListings || {};
  if (entry.jobId && listings[String(entry.jobId)]) {
    return { jobId: String(entry.jobId), listing: listings[String(entry.jobId)] };
  }
  if (entry.folderName) {
    const byFolder = Object.keys(listings).find(
      (id) => listings[id]?.applicationFolder === entry.folderName
    );
    if (byFolder) return { jobId: byFolder, listing: listings[byFolder] };
  }
  return { jobId: entry.jobId || null, listing: null };
}

function fileSignals(applicationsDir, folderName) {
  if (!folderName) return { exists: false, folderPath: null, coverLetter: false, resume: false };
  const folderPath = path.join(applicationsDir, folderName);
  if (!fs.existsSync(folderPath)) return { exists: false, folderPath, coverLetter: false, resume: false };
  const files = fs.readdirSync(folderPath);
  return {
    exists: true,
    folderPath,
    coverLetter: files.some((f) => /^Cover_Letter_.*\.md$/i.test(f)),
    resume: files.some((f) => /^Resume_.*\.md$/i.test(f)),
  };
}

export function buildReviewQueue({ state, cacheListings, applicationsDir }) {
  ensureJobPipeline(state);
  normalizePipelineEntriesInState(state);

  const makeRecord = (entry, sourceBucket) => {
    const normalized = withQueueId(entry);
    const { jobId, listing } = resolveListing(cacheListings, normalized);
    const files = fileSignals(applicationsDir, normalized.folderName || listing?.applicationFolder || null);
    return {
      ...normalized,
      sourceBucket,
      jobId: jobId || null,
      folderName: normalized.folderName || listing?.applicationFolder || null,
      company: normalized.company || listing?.company || null,
      title: normalized.title || listing?.title || null,
      score: normalized.score ?? listing?.score ?? null,
      listingStatus: listing?.status || null,
      files,
      waitingHumanReview: Boolean(files.coverLetter && files.resume),
    };
  };

  const ready = (state.job_pipeline.materials_ready || []).map((entry) =>
    makeRecord(entry, "materials_ready")
  );

  const pendingWithDrafts = (state.job_pipeline.pending_materials || [])
    .map((entry) => makeRecord(entry, "pending_materials"))
    .filter((entry) => entry.waitingHumanReview);

  const merged = dedupePipelineEntries([...ready, ...pendingWithDrafts]).map((entry) =>
    makeRecord(entry, entry.sourceBucket || "materials_ready")
  );

  merged.sort(sortReviewItems);
  return merged;
}

export function pickCurrentReviewItem(state, reviewQueue, preferredQueueId = null) {
  ensureJobPipeline(state);
  const reviewState = state.job_pipeline.review;
  const skipped = new Set((reviewState.skippedQueueIds || []).map(String));

  const resolveById = (queueId) =>
    queueId ? reviewQueue.find((item) => String(item.queueId) === String(queueId)) || null : null;

  const preferred = resolveById(preferredQueueId);
  if (preferred) return preferred;

  const cursorItem = resolveById(reviewState.currentQueueId);
  if (cursorItem && !skipped.has(String(cursorItem.queueId))) return cursorItem;

  const next = reviewQueue.find((item) => !skipped.has(String(item.queueId))) || null;
  if (next) return next;

  if (skipped.size > 0) {
    reviewState.skippedQueueIds = [];
    return reviewQueue[0] || null;
  }

  return reviewQueue[0] || null;
}

export function setCurrentQueueId(state, queueId) {
  ensureJobPipeline(state);
  state.job_pipeline.review.currentQueueId = queueId || null;
  state.job_pipeline.review.lastViewedAt = new Date().toISOString();
}

export function markQueueSkipped(state, queueId) {
  ensureJobPipeline(state);
  if (!queueId) return;
  const current = new Set((state.job_pipeline.review.skippedQueueIds || []).map(String));
  current.add(String(queueId));
  state.job_pipeline.review.skippedQueueIds = Array.from(current);
}

export function clearQueueSkipped(state, queueId) {
  ensureJobPipeline(state);
  if (!queueId) return;
  state.job_pipeline.review.skippedQueueIds = (state.job_pipeline.review.skippedQueueIds || [])
    .filter((id) => String(id) !== String(queueId));
}

