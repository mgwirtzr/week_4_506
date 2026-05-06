#!/usr/bin/env node
/**
 * Client harness: overlaps POST /draft and POST /publish so server logs show
 * whether publish read stale committed draft (race). Starts the app on a free
 * PORT unless BASE_URL is set (then expects server already running).
 */

const { spawn } = require('child_process');
const path = require('path');
const { performance } = require('node:perf_hooks');
const axios = require('axios');

function isoTimestampHiRes() {
  const t = performance.timeOrigin + performance.now();
  const sec = Math.floor(t / 1000);
  const fracSec = (t - sec * 1000) / 1000;
  const fracDigits = fracSec.toFixed(6).slice(2);
  return `${new Date(sec * 1000).toISOString().slice(0, -5)}.${fracDigits}Z`;
}

function clientLog(payload) {
  console.log(JSON.stringify({ ts: isoTimestampHiRes(), side: 'CLIENT', ...payload }));
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(http, attempts = 40, gapMs = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      await http.get('/current');
      return;
    } catch {
      await sleep(gapMs);
    }
  }
  throw new Error('Server did not become ready in time');
}

async function main() {
  const repoRoot = path.join(__dirname, '..');
  const baseURL = process.env.BASE_URL;
  let child = null;

  const http = axios.create({
    baseURL: baseURL || `http://127.0.0.1:${process.env.PORT || '3459'}`,
    validateStatus: () => true,
    transitional: { clarifyTimeoutError: true },
  });

  if (!baseURL) {
    const port = process.env.PORT || '3459';
    clientLog({
      phase: 'SETUP',
      msg: 'Spawning server',
      SAVE_COMMIT_DELAY_MS: process.env.SAVE_COMMIT_DELAY_MS || '250',
      PORT: port,
    });
    child = spawn(process.execPath, ['app/server.js'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: port,
        SAVE_COMMIT_DELAY_MS: process.env.SAVE_COMMIT_DELAY_MS || '250',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (buf) => process.stderr.write(`[server stdout] ${buf}`));
    child.stderr.on('data', (buf) => process.stderr.write(`[server stderr] ${buf}`));
    await waitForServer(http);
  }

  try {
    await http.post('/reset');
    clientLog({ phase: 'SETUP', msg: 'State reset' });

    // Establish committed baseline so stale publish is visible if publish wins race.
    await http.post('/draft', { content: 'draft A' });
    clientLog({
      phase: 'SETUP',
      msg: 'Committed draft A',
      currentResponse: (await http.get('/current')).data,
    });

    clientLog({
      phase: 'RACE_START',
      msg: 'Firing POST /draft (draft B) without awaiting; then POST /publish immediately',
      draftB: 'draft B',
      expectedIfStale: 'draft A',
      expectedIfFixed: 'draft B',
    });

    const draftBPromise = (async () => {
      const tag = 'POST /draft content=draft B';
      clientLog({ phase: 'ENTRY', requestTag: tag });
      try {
        const res = await http.post('/draft', { content: 'draft B' });
        clientLog({
          phase: 'EXIT',
          requestTag: tag,
          httpStatus: res.status,
          body: res.data,
        });
        return res;
      } catch (err) {
        clientLog({ phase: 'EXIT', requestTag: tag, error: String(err) });
        throw err;
      }
    })();

    const publishPromise = (async () => {
      const tag = 'POST /publish';
      clientLog({ phase: 'ENTRY', requestTag: tag });
      try {
        const res = await http.post('/publish');
        clientLog({
          phase: 'EXIT',
          requestTag: tag,
          httpStatus: res.status,
          body: res.data,
          stalePublish:
            res.status === 200 && res.data?.published === 'draft A'
              ? 'YES — publish committed draft A while draft B save was still in flight'
              : 'NO',
        });
        return res;
      } catch (err) {
        clientLog({ phase: 'EXIT', requestTag: tag, error: String(err) });
        throw err;
      }
    })();

    const [draftRes, publishRes] = await Promise.all([draftBPromise, publishPromise]);

    clientLog({
      phase: 'RACE_SUMMARY',
      msg: 'Both requests finished',
      draftBResponseSaved: draftRes.data?.saved,
      publishReturned: publishRes.data?.published,
      interpretation:
        publishRes.data?.published === 'draft B'
          ? 'Publish saw draft B (no stale read for this run).'
          : publishRes.data?.published === 'draft A'
            ? 'Publish saw draft A — stale vs in-flight draft B (compare CLIENT ENTRY/EXIT order with server logs).'
            : `Unexpected published value: ${publishRes.data?.published}`,
    });

    const cur = await http.get('/current');
    const pub = await http.get('/published');
    clientLog({
      phase: 'POST_RACE_STATE',
      GET_current: cur.data,
      GET_published: pub.data,
    });
  } finally {
    if (child) {
      child.kill('SIGTERM');
      await sleep(50);
      if (!child.killed) child.kill('SIGKILL');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
