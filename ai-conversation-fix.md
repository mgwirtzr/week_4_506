@Codebase
I have observed a race condition between POST /draft and POST /publish using my instrumentation.

The Evidence:
In my trace.txt, I see that POST /publish enters and exits while POST /draft is still processing its SAVE_COMMIT_DELAY_MS. As a result, the "stale" version of the draft is published.

The Task:
Please fix the race condition in app/server.js.

Ensure that POST /publish always waits for any pending POST /draft requests to complete before reading the state.

Alternatively, implement a queue or a "last-intended-version" check so that the publish action is guaranteed to use the most recent draft the user sent, even if the network request for the save is slow.

Keep the hi-res instrumentation logs in place so I can verify the fix.

Ensure that the provided regression tests (npm test) now pass.

AI response:
Awaiting draftCommitGate in /reset before clearing state so we don't replace the gate while commits are in-flight. Making /reset async and adding error handling for async routes on Express 4.

Tests passed. Updating the file header comment now that the race is fixed.

Here’s what changed.

Fix: serialized draft commit gate
draftCommitGate — Starts as Promise.resolve(). Every successful POST /draft chains a promise that resolves in a finally block after the delayed commit (SAVE_COMMIT_DELAY_MS) updates currentDraft and responds.

POST /publish — Logs ENTRY with currentDraftBeforeAwaitingCommits (often still the older draft while B is in flight), await draftCommitGate, then reads currentDraft and logs EXIT with committedDraftAtRead / publishedDraft. So publish never observes stale committed content while an earlier save is still committing.

POST /reset — await draftCommitGate before clearing state and resetting the gate, so reset doesn’t drop an in-flight save from the barrier.

Instrumentation is unchanged in spirit (same isoTimestampHiRes, logHandlerEvent, reqId, ENTRY/EXIT on /draft); /publish ENTRY now includes currentDraftBeforeAwaitingCommits, and notes describe awaiting the gate.

What you’ll see in traces
Example ordering after the fix: POST /publish ENTRY can still show currentDraftBeforeAwaitingCommits: "draft A" while POST /draft for B is deferred; POST /draft EXIT for B commits draft B; POST /publish EXIT then shows committedDraftAtRead / publishedDraft: "draft B".

Verification
npm test — both regression tests pass.
npm run harness:race — stalePublish: "NO", publish returns draft B.
Core gate wiring:


server.js
Lines 47-52
// Serialized completion barrier for deferred draft commits. Each successful POST /draft
// extends this chain until its SAVE_COMMIT_DELAY_MS commit finishes. POST /publish
// awaits it so publish never reads currentDraft while an earlier save is still committing.
let draftCommitGate = Promise.resolve();

server.js
Lines 89-114
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