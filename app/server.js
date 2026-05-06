// Save-and-Publish Draft Editor
//
// This app has a known race condition between /draft and /publish.
// See README.md for the bug description and what you're being asked to do.

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
        ? 'Draft commit is deferred; /publish can observe stale committedDraftBefore until EXIT fires.'
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

  // Simulate write latency so /publish can interleave before commit completes.
  setTimeout(() => {
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
  }, SAVE_COMMIT_DELAY_MS);
});

// POST /publish — mark the most recent saved draft as live.
//
// THE BUG: this reads currentDraft *immediately*. If a /draft request is
// in flight (its timeout hasn't fired), publishedDraft will be set to the
// older saved value, not the in-flight one.
app.post('/publish', (req, res) => {
  const reqId = randomUUID();
  const committedDraftAtRead = currentDraft;
  logHandlerEvent({
    phase: 'ENTRY',
    reqId,
    requestType: 'POST /publish',
    committedDraftAtRead,
    note:
      'Reads currentDraft immediately. If a /draft EXIT has not run yet, this value may lag behind draftContentSaving from an overlapping save.',
  });

  publishedDraft = committedDraftAtRead;

  logHandlerEvent({
    phase: 'EXIT',
    reqId,
    requestType: 'POST /publish',
    publishedDraft,
    committedDraftAtRead,
    note:
      'If POST /draft EXIT for newer content appears after this ENTRY, publish still used committedDraftAtRead — stale publish.',
  });

  res.json({ ok: true, published: publishedDraft, reqId });
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
app.post('/reset', (req, res) => {
  currentDraft = '';
  publishedDraft = '';
  res.json({ ok: true });
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
