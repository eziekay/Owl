import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { root } from './lib.mjs';
import { exportSite } from './export-site.mjs';

const execute = promisify(execFile);
const safeRoot = root.replace(/\\/gu, '/').replace(/\/$/u, '');
const git = args => execute('git', ['-c', `safe.directory=${safeRoot}`, ...args], {
  cwd: root, windowsHide: true, maxBuffer: 1024 * 1024
});

export async function syncSite() {
  const branch = (await git(['branch', '--show-current'])).stdout.trim();
  if (branch !== 'main') throw new Error(`GitHub Pages publishing requires the main branch; current branch is ${branch || 'detached'}.`);

  const current = await exportSite();
  await git(['add', '-A', '--', 'site']);
  let changed = true;
  try { await git(['diff', '--cached', '--quiet', '--', 'site']); changed = false; }
  catch (error) { if (error.code !== 1) throw error; }

  if (changed) {
    const saved = JSON.parse(await readFile(resolve(root, 'data/latest.json'), 'utf8'));
    const timestamp = saved.generatedAt?.replace(/\.\d{3}Z$/u, 'Z') ?? new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
    await git(['commit', '--only', '-m', `Publish Owl ${saved.date ?? current.date} · ${timestamp}`, '--', 'site']);
  }

  await git(['push', 'origin', 'HEAD:main']);
  console.log(changed ? 'Committed the site snapshot and pushed it to GitHub Pages.' : 'The site snapshot was unchanged; confirmed main is pushed to GitHub.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await syncSite();
