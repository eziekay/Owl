import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, mkdir, rename, writeFile, unlink, readdir, access } from 'node:fs/promises';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { config, root } from './lib.mjs';

const running = state => state?.status === 'running';
const defaultEstimate = (config.researchBudget.maxResearchMinutes + 4) * 60;
const phaseTasks = {
  starting: 'Preparing recent-story context',
  research: 'Searching for and checking current stories',
  writing: 'Writing summaries, scores, and citations',
  publishing: 'Validating and publishing the edition',
  checking: 'Verifying the saved edition'
};
const workerPath = fileURLToPath(import.meta.url);
const read = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + '\n');
  await rename(temporary, path);
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
export function publicUpdate(state, now = Date.now()) {
  if (!state) return { status: 'idle' };
  const elapsed = Math.max(0, (now - Date.parse(state.startedAt)) / 1000);
  const ratio = elapsed / state.estimateSeconds;
  const floor = { starting: 1, research: 8, writing: 65, publishing: 90, checking: 97 }[state.phase] ?? 1;
  const ceiling = { starting: 7, research: 64, writing: 89, publishing: 96, checking: 99 }[state.phase] ?? 7;
  return {
    id: state.id, status: state.status, phase: state.phase,
    currentTask: state.currentTask ?? phaseTasks[state.phase] ?? phaseTasks.starting,
    startedAt: state.startedAt, finishedAt: state.finishedAt,
    progress: state.status === 'complete' ? 100 : Math.min(ceiling, Math.max(floor, Math.floor(ratio * 90))),
    estimatedRemainingSeconds: running(state) && ratio < 1 ? Math.ceil(state.estimateSeconds - elapsed) : null,
    error: state.error, editionAt: state.editionAt, retainedPrevious: state.retainedPrevious
  };
}

// A separate worker keeps updating even if the reader tab or web server closes.
export function createUpdater({ base = root, worker = workerPath } = {}) {
  const statePath = join(base, 'data/update-state.json');
  const lockPath = join(base, 'data/update.lock');
  let launching = null;
  async function getState() {
    let state = await read(statePath);
    let lock;
    try { lock = await read(lockPath); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (lock && !alive(lock.pid)) {
      if (running(state)) {
        state = { ...state, status: 'failed', finishedAt: new Date().toISOString(), error: 'The update was interrupted. Your saved editions are still available. Please try again.' };
        await save(statePath, state);
      }
      await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    } else if (!lock && running(state) && Date.now() - Date.parse(state.startedAt) > 15000) {
      state = { ...state, status: 'failed', finishedAt: new Date().toISOString(), error: 'The updater could not start. Please try again.' };
      await save(statePath, state);
    }
    return state;
  }
  return {
    async status() { return publicUpdate(await getState()); },
    start() {
      if (launching) return launching;
      launching = (async () => {
      const previous = await getState();
      await mkdir(join(base, 'data'), { recursive: true });
      let lock;
      try { lock = await open(lockPath, 'wx'); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Another server instance may still be saving its initial job record.
        for (let attempt = 0; attempt < 40; attempt++) {
          const activeLock = await read(lockPath).catch(() => null);
          const activeState = await read(statePath);
          if (activeLock?.id === activeState?.id && activeState?.id) return publicUpdate(activeState);
          await pause(25);
        }
        return publicUpdate(await read(statePath));
      }
      const id = randomUUID();
      const estimateSeconds = previous?.status === 'complete'
        ? Math.min(1800, Math.max(120, Math.round((Date.parse(previous.finishedAt) - Date.parse(previous.startedAt)) / 1000)))
        : defaultEstimate;
      const state = { id, status: 'running', phase: 'starting', startedAt: new Date().toISOString(), estimateSeconds };
      try {
        await lock.writeFile(JSON.stringify({ id, pid: process.pid }));
        await save(statePath, state);
        const child = spawn(process.execPath, [worker, '--worker', id], {
          cwd: base, detached: true, windowsHide: true, stdio: 'ignore'
        });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        await lock.truncate(0);
        await lock.write(JSON.stringify({ id, pid: child.pid }), 0, 'utf8');
        child.unref();
      } catch {
        state.status = 'failed'; state.finishedAt = new Date().toISOString();
        state.error = 'The background updater could not start. Open Owl again and retry.';
        await save(statePath, state);
        await unlink(lockPath).catch(() => {});
      } finally { await lock.close(); }
      return publicUpdate(state);
      })().finally(() => { launching = null; });
      return launching;
    }
  };
}

async function findCodex() {
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    const candidate = join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    try { await access(candidate); return candidate; } catch {}
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const bin = join(process.env.LOCALAPPDATA, 'OpenAI/Codex/bin');
    const entries = await readdir(bin, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter(entry => entry.isDirectory()).reverse()) {
      const candidate = join(bin, entry.name, 'codex.exe');
      try { await access(candidate); return candidate; } catch {}
    }
  }
  throw new Error('Codex could not be found. Open the ChatGPT desktop app to restore its local runner, then try again.');
}

async function runWorker(id) {
  const base = process.cwd();
  const statePath = join(base, 'data/update-state.json');
  const lockPath = join(base, 'data/update.lock');
  let state = await read(statePath);
  if (state?.id !== id || !running(state)) return;
  let pending = Promise.resolve();
  const persist = () => {
    const snapshot = { ...state };
    pending = pending.then(() => save(statePath, snapshot));
    return pending;
  };
  const phaseRank = ['starting', 'research', 'writing', 'publishing', 'checking'];
  const phase = value => {
    if (phaseRank.indexOf(value) > phaseRank.indexOf(state.phase)) { state.phase = value; persist().catch(() => {}); }
  };
  const task = value => {
    if (state.currentTask !== value) { state.currentTask = value; persist().catch(() => {}); }
  };
  let log;
  try {
    log = await open(join(base, 'data/update.log'), 'w');
    const codex = await findCodex();
    const before = await read(join(base, 'data/last-attempt.json'));
    const prompt = `Update Owl in ${base}. Read UPDATE_NEWSLETTER.md and newsletter.config.json once. Run the collector, use built-in live web search with batched topic discovery and follow-ups only on the strongest leads, write data/draft.json once, publish once, and briefly read back the result. This is an unattended reader-requested update: do not ask questions. Only write edition and research files under data/; do not change code, design, configuration, or instructions. The web server is running and the reader handles navigation: do not launch applications, open or reload browsers, or start/stop the server. If authentication, permissions, or another failure prevents completion, report it and stop. Never claim publication without running the publisher.`;
    const args = ['exec', '--ignore-user-config', '--skip-git-repo-check', '--sandbox', 'workspace-write',
      '-c', 'approval_policy="never"', '-c', 'web_search="live"',
      '-m', config.model, '-c', `model_reasoning_effort="${config.reasoningEffort}"`,
      '--ephemeral', '--json'];
    if (process.platform === 'win32') args.push('-c', 'windows.sandbox="elevated"');
    args.push('-');
    const env = { ...process.env };
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`;
    const child = spawn(codex, args, { cwd: base, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffered = '', diagnostics = '', timer, timedOut = false, turnFailed = false;
    function remember(text) { diagnostics = (diagnostics + text).slice(-32000); }
    const writeLog = text => { log.write(text).catch(() => {}); remember(text); };
    child.stderr.on('data', chunk => writeLog(chunk.toString()));
    child.stdout.on('data', chunk => {
      const text = chunk.toString(); writeLog(text); buffered += text;
      const lines = buffered.split('\n'); buffered = lines.pop();
      for (const line of lines) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'turn.failed') turnFailed = true;
        const item = event.item;
        if (item?.type === 'web_search') {
          phase('research');
          task(event.type === 'item.started' ? 'Searching public sources for current stories' : 'Assessing results and selecting promising leads');
        }
        const command = item?.command ?? '';
        if (/collect\.mjs/u.test(command)) { phase('research'); task('Preparing recent-story context'); }
        if (item?.type === 'file_change' && item.changes?.some(change => /draft\.json$/u.test(change.path))) {
          phase('writing'); task('Writing summaries, Owl scores, and citations');
        }
        if (/publish\.mjs/u.test(command)) { phase('publishing'); task('Validating and publishing the edition'); }
      }
    });
    child.stdin.on('error', () => {});
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
      timer = setTimeout(() => {
        timedOut = true;
        if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
        else child.kill('SIGTERM');
      }, 30 * 60000);
    });
    child.stdin.end(prompt);
    let code;
    try { code = await exit; } finally { clearTimeout(timer); }
    if (timedOut) throw new Error('The update exceeded its time limit. Your saved editions are still available. Please try again.');
    if (code !== 0 || turnFailed) {
      if (/usage limit|rate limit|quota|credits/iu.test(diagnostics)) throw new Error('Codex reached an account usage limit. Please try again after your limit resets.');
      if (/unauthorized|sign in|log in|not logged|authentication|token.*expired/iu.test(diagnostics)) throw new Error('Codex needs you to sign in again. Open ChatGPT, sign in, and then retry Update.');
      throw new Error('Codex could not finish this update. Your saved editions are still available. Please try again.');
    }
    phase('checking'); task('Verifying the saved edition');
    const attempt = await read(join(base, 'data/last-attempt.json'));
    if (!attempt?.checkedAt || attempt.checkedAt === before?.checkedAt || Date.parse(attempt.checkedAt) < Date.parse(state.startedAt)) {
      throw new Error('The update finished without publishing an edition. Your saved editions are still available. Please try again.');
    }
    const latest = await read(join(base, 'data/latest.json'));
    const hasEdition = (attempt.storyCount ?? (attempt.sourceCount > 0 ? 1 : 0)) > 0;
    if (!latest?.generatedAt || (hasEdition && latest.generatedAt !== attempt.checkedAt)) {
      throw new Error('The new edition could not be saved completely. Your last saved edition is still available. Please try again.');
    }
    const finishedAt = new Date().toISOString();
    const updateDurationSeconds = Math.max(0, Math.round((Date.parse(finishedAt) - Date.parse(state.startedAt)) / 1000));
    const timedAttempt = { ...attempt, updateDurationSeconds };
    await save(join(base, 'data/last-attempt.json'), timedAttempt);
    const recordName = attempt.checkedAt.replace(/[:.]/gu, '-');
    if (hasEdition && latest.generatedAt === attempt.checkedAt) {
      const timedEdition = { ...latest, updateDurationSeconds };
      await save(join(base, 'data/latest.json'), timedEdition);
      await save(join(base, `data/archive/${recordName}.json`), timedEdition);
    } else if (!hasEdition) {
      const reportPath = join(base, `data/access-reports/${recordName}.json`);
      const report = await read(reportPath);
      if (report?.generatedAt === attempt.checkedAt) await save(reportPath, { ...report, updateDurationSeconds });
    }
    state.status = 'complete'; state.finishedAt = finishedAt;
    state.editionAt = latest?.generatedAt;
    state.retainedPrevious = latest?.generatedAt !== attempt.checkedAt;
    await persist();
  } catch (error) {
    state.status = 'failed'; state.finishedAt = new Date().toISOString();
    state.error = error.code || error instanceof SyntaxError
      ? 'The update could not finish. Your saved editions are still available. Please try again.'
      : error.message;
    await pending.catch(() => {});
    await save(statePath, state);
  } finally {
    await pending.catch(() => {});
    await log?.close().catch(() => {});
    const lock = await read(lockPath).catch(() => null);
    if (lock?.id === id) await unlink(lockPath).catch(() => {});
  }
}

if (process.argv[2] === '--worker') await runWorker(process.argv[3]);
