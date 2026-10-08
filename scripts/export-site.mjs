import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankIssue, config, publicNearMisses, root, toPublicIssue } from './lib.mjs';
import { closeByStories, loadHistory } from './history.mjs';

export async function exportSite() {
  const site = join(root, 'site');
  const api = join(site, 'api');
  await mkdir(api, { recursive: true });

  let issue;
  try { issue = JSON.parse(await readFile(join(root, 'data/latest.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; issue = blankIssue(); }

  const history = await loadHistory();
  const current = toPublicIssue(issue);
  current.closeBy = closeByStories(issue, history);
  try {
    const attempt = JSON.parse(await readFile(join(root, 'data/last-attempt.json'), 'utf8'));
    current.lastAttempt = {
      date: attempt.date, checkedAt: attempt.checkedAt,
      sourceCount: attempt.sourceCount ?? attempt.postCount,
      storyCount: attempt.storyCount,
      nearMisses: publicNearMisses(attempt.nearMisses)
    };
    if (Array.isArray(attempt.nearMisses)) current.nearMisses = publicNearMisses(attempt.nearMisses);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const html = (await readFile(join(root, 'public/index.html'), 'utf8'))
    .replace('<html lang="en">', '<html lang="en" data-mode="static">')
    .replace('updated when you ask.', 'published from the local Owl app.');
  await writeFile(join(site, 'index.html'), html);
  await Promise.all(['app.js', 'style.css'].map(file => copyFile(join(root, 'public', file), join(site, file))));
  await writeFile(join(site, '.nojekyll'), '');
  await writeFile(join(api, 'issue.json'), JSON.stringify(current));
  await writeFile(join(api, 'history.json'), JSON.stringify({ hours: config.historyHours, editions: history.map(toPublicIssue) }));
  console.log(`Exported ${current.stories.length} stories and ${history.length} recent editions to site/.`);
  return current;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await exportSite();
