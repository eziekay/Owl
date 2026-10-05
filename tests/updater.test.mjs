import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, mkdir, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUpdater, publicUpdate } from '../scripts/updater.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('concurrent requests share a durable worker and a recreated server reconnects', async () => {
  const base = await mkdtemp(join(tmpdir(), 'owl-updater-'));
  const worker = join(base, 'worker.mjs');
  await writeFile(worker, `import { readFile, writeFile, unlink } from 'node:fs/promises';
    await new Promise(resolve => setTimeout(resolve, 300));
    const path = 'data/update-state.json';
    const state = JSON.parse(await readFile(path));
    await writeFile(path, JSON.stringify({ ...state, status: 'complete', finishedAt: new Date().toISOString(), editionAt: 'saved-edition' }));
    await unlink('data/update.lock');`);
  const updater = createUpdater({ base, worker });
  try {
    const [first, second, third] = await Promise.all([updater.start(), updater.start(), createUpdater({ base, worker }).start()]);
    assert.equal(first.status, 'running');
    assert.equal(first.id, second.id);
    assert.equal(first.id, third.id);
    const reconnected = createUpdater({ base, worker });
    assert.equal((await reconnected.start()).id, first.id);
    for (let i = 0; i < 50 && (await reconnected.status()).status === 'running'; i++) await delay(50);
    const complete = await reconnected.status();
    assert.equal(complete.status, 'complete');
    assert.equal(complete.progress, 100);
    assert.equal(complete.editionAt, 'saved-edition');
  } finally {
    for (const path of ['data/update.lock', 'data/update-state.json', 'worker.mjs']) await unlink(join(base, path)).catch(() => {});
    await rmdir(join(base, 'data')); await rmdir(base);
  }
});

test('a dead worker is reported as interrupted and releases its lock', async () => {
  const base = await mkdtemp(join(tmpdir(), 'owl-updater-'));
  await mkdir(join(base, 'data'));
  await writeFile(join(base, 'data/update-state.json'), JSON.stringify({ id: 'dead', status: 'running', startedAt: new Date().toISOString(), estimateSeconds: 720 }));
  await writeFile(join(base, 'data/update.lock'), JSON.stringify({ id: 'dead', pid: 2147483647 }));
  try {
    const state = await createUpdater({ base }).status();
    assert.equal(state.status, 'failed');
    assert.match(state.error, /interrupted/u);
    await assert.rejects(readFile(join(base, 'data/update.lock')), { code: 'ENOENT' });
  } finally {
    await unlink(join(base, 'data/update-state.json')); await rmdir(join(base, 'data')); await rmdir(base);
  }
});

test('estimated progress never claims completion while a job is running', () => {
  const state = { id: 'test', status: 'running', phase: 'research', startedAt: new Date(0).toISOString(), estimateSeconds: 720 };
  assert.equal(publicUpdate(state, 1500000).progress, 64);
  assert.equal(publicUpdate(state, 1500000).estimatedRemainingSeconds, null);
  state.phase = 'checking';
  assert.equal(publicUpdate(state, 1500000).progress, 99);
  assert.equal(publicUpdate({ ...state, status: 'complete' }, 1500000).progress, 100);
});

// Exercise the actual reader script with controllable job responses and clock.
// This checks async transitions without starting a paid research update.
async function reader() {
  class Node {
    hidden = false; children = []; textContent = ''; handlers = {}; attributes = {};
    classList = { toggle() {}, add() {} };
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    querySelector(key) {
      this.queries ??= new Map();
      if (!this.queries.has(key)) this.queries.set(key, new Node());
      return this.queries.get(key);
    }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(name, callback) { this.handlers[name] = callback; }
    focus() {}
    async click() { await this.handlers.click?.(); }
  }
  const nodes = new Map();
  const node = key => { if (!nodes.has(key)) nodes.set(key, new Node()); return nodes.get(key); };
  const issue = timestamp => ({ generatedAt: timestamp, readingMinutes: 1, window: { start: timestamp, end: timestamp }, stories: [] });
  let latest = issue('2026-09-29T04:00:00Z');
  let job = { status: 'idle' }, ticks = [], postCount = 0;
  const document = { querySelector: node, createElement: () => new Node(), createTextNode: text => ({ textContent: text }), addEventListener() {} };
  const context = vm.createContext({ document, Intl, Date, console, window: { scrollTo() {} }, sessionStorage: { getItem() {}, setItem() {}, removeItem() {} },
    setInterval(callback, ms) { ticks.push({ callback, ms }); },
    async fetch(url, options) {
      if (url === '/api/update' && options?.method === 'POST') { postCount++; job = { id: 'job', status: 'running', progress: 8, estimatedRemainingSeconds: 700 }; }
      const body = url === '/api/issue' ? latest : url === '/api/history' ? { editions: [latest] } : job;
      return { ok: true, async json() { return body; } };
    }
  });
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  await delay(0);
  return { node, ticks, posts: () => postCount, job(value) { job = value; }, latest(value) { latest = issue(value); } };
}

test('Other editions → Update removes the menu; 2.5-second completion polling opens the newest edition', async () => {
  const ui = await reader();
  assert.equal(ui.node('#newsletter').hidden, true);
  await ui.node('#other-editions-button').click();
  assert.equal(ui.node('#edition-menu').hidden, false);
  const editionButtons = [...ui.node('#edition-list-24h').children, ...ui.node('#edition-list-7d').children]
    .filter(child => child.className === 'history-button');
  assert.equal(editionButtons.length, 1);
  await ui.node('#update-button').click();
  assert.equal(ui.node('#edition-menu').hidden, true);
  assert.equal(ui.node('#dateline').hidden, true);
  assert.equal(ui.node('#title-actions').hidden, true);
  assert.equal(ui.node('#update-progress').hidden, false);
  assert.equal(ui.posts(), 1);
  await ui.node('#update-button').click();
  assert.equal(ui.posts(), 1);
  const tick = ui.ticks[0]; assert.equal(tick.ms, 2500);
  const newest = '2026-09-29T05:00:00Z'; ui.latest(newest);
  ui.job({ id: 'job', status: 'complete', editionAt: newest });
  await tick.callback();
  assert.equal(ui.node('#newsletter').hidden, false);
  assert.equal(ui.node('#update-progress').hidden, true);
  assert.equal(ui.node('#last-updated').dateTime, newest);
  await ui.node('#home-button').click();
  assert.equal(ui.node('#title-actions').hidden, false);
});

test('failed updates restore the title controls with an explanation', async () => {
  const ui = await reader();
  await ui.node('#update-button').click();
  ui.job({ id: 'job', status: 'failed', error: 'Sign in again.' });
  await ui.ticks[0].callback();
  assert.equal(ui.node('#title-actions').hidden, false);
  assert.equal(ui.node('#update-progress').hidden, true);
  assert.equal(ui.node('#title-notice').textContent, 'Sign in again.');
});
