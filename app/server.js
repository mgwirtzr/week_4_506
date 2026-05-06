// Save-and-Publish Draft Editor
//
// POST /publish awaits draftCommitGate so deferred POST /draft commits finish
// before currentDraft is read (see README.md).

const express = require('express');
const path = require('path');
const { randomUUID } = require('crypto');
const { performance } = require('node:perf_hooks');

const app = express();

/** Wall-clock ISO timestamp with microsecond fractional seconds (via performance.timeOrigin). */
function isoTimestampHiRes() {
  const t = performance.timeOrigin + performance.now();
  const sec = Math.floor(t / 1000);
  const fracSec = (t - sec * 1000) / 1000;
  const fracDigits = fracSec.toFixed(6).slice(2);
  return `${new Date(sec * 1000).toISOString().slice(0, -5)}.${fracDigits}Z`;
}

function logHandlerEvent(payload) {
  console.log(JSON.stringify({ ts: isoTimestampHiRes(), ...payload }));
}
app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

// ---------------------------------------------------------------------------
// In-memory storage
// ---------------------------------------------------------------------------
// `currentDraft` is the most recent saved draft.
// `publishedDraft` is what /publish has marked as live.
//
// In a real app these would live in a database. For this assignment, in-memory
// is fine — the bug is in the timing, not the storage.
let currentDraft = '';
let publishedDraft = '';

// SAVE_COMMIT_DELAY_MS controls how long a /draft request takes to commit.
// In production this would represent database write latency, network latency,
// or any other delay between "request received" and "value updated."
//
// Set to 200ms by default to make the race condition reliably reproducible.
// Tests may override this via environment variable.
const SAVE_COMMIT_DELAY_MS = parseInt(process.env.SAVE_COMMIT_DELAY_MS || '200', 10);

// Serialized completion barrier for deferred draft commits. Each successful POST /draft
// extends this chain until its SAVE_COMMIT_DELAY_MS commit finishes. POST /publish
// awaits it so publish never reads currentDraft while an earlier save is still committing.
let draftCommitGate = Promise.resolve();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// POST /draft — save the current draft text.
//
// Note the artificial delay: the draft is not committed to currentDraft
// until SAVE_COMMIT_DELAY_MS milliseconds after the request arrives.
app.post('/draft', (req, res) => {
  const reqId = randomUUID();
  const { content } = req.body;

  logHandlerEvent({
    phase: 'ENTRY',
    reqId,
    requestType: 'POST /draft',
    draftContentSaving: typeof content === 'string' ? content : null,
    committedDraftBefore: currentDraft,
    commitDelayMs: SAVE_COMMIT_DELAY_MS,
    validationOk: typeof content === 'string',
    note:
      typeof content === 'string'
        ? 'Draft commit is deferred; POST /publish awaits draftCommitGate before reading so commits are not skipped.'
        : undefined,
  });

  if (typeof content !== 'string') {
    logHandlerEvent({
      phase: 'EXIT',
      reqId,
      requestType: 'POST /draft',
      error: 'validation_failed',
      detail: 'content must be a string',
    });
    return res.status(400).json({ error: 'content must be a string' });
  }

  let resolveCommit;
  const commitFinished = new Promise((resolve) => {
    resolveCommit = resolve;
  });

  const prevGate = draftCommitGate;
  draftCommitGate = prevGate.then(() => commitFinished);

  // Simulate write latency (DB/network). Gate stays pending until this fires.
  setTimeout(() => {
    try {
      currentDraft = content;
      logHandlerEvent({
        phase: 'EXIT',
        reqId,
        requestType: 'POST /draft',
        draftContentSaved: content,
        committedDraftAfter: currentDraft,
        note: 'Commit finished; currentDraft now matches draftContentSaved.',
      });
      res.json({ ok: true, saved: content, reqId });
    } finally {
      resolveCommit();
    }
  }, SAVE_COMMIT_DELAY_MS);
});

// POST /publish — mark the most recent saved draft as live.
//
// Waits for draftCommitGate so any in-flight POST /draft commits finish before
// reading currentDraft (eliminates save/publish races).
app.post('/publish', async (req, res, next) => {
  const reqId = randomUUID();
  try {
    const currentDraftBeforeAwaitingCommits = currentDraft;
    logHandlerEvent({
      phase: 'ENTRY',
      reqId,
      requestType: 'POST /publish',
      currentDraftBeforeAwaitingCommits,
      note:
        'Will await draftCommitGate so pending deferred commits complete before reading currentDraft.',
    });

    await draftCommitGate;

    const committedDraftAtRead = currentDraft;
    publishedDraft = committedDraftAtRead;

    logHandlerEvent({
      phase: 'EXIT',
      reqId,
      requestType: 'POST /publish',
      publishedDraft,
      committedDraftAtRead,
      currentDraftBeforeAwaitingCommits,
      note:
        'Published committedDraftAtRead after all pending draft commits at publish time had finished.',
    });

    res.json({ ok: true, published: publishedDraft, reqId });
  } catch (err) {
    next(err);
  }
});

// GET /published — return the currently published draft.
app.get('/published', (req, res) => {
  res.json({ published: publishedDraft });
});

// GET /current — return the currently saved (committed) draft.
app.get('/current', (req, res) => {
  res.json({ current: currentDraft });
});

// Reset endpoint for tests.
app.post('/reset', async (req, res, next) => {
  try {
    await draftCommitGate;
    currentDraft = '';
    publishedDraft = '';
    draftCommitGate = Promise.resolve();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Draft editor running on http://localhost:${PORT}`);
    console.log(`SAVE_COMMIT_DELAY_MS = ${SAVE_COMMIT_DELAY_MS}`);
  });
}

module.exports = app;
