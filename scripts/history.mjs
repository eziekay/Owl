import { readdir, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config, root, editorialDayStart, issueStories, issueNearMisses, toPublicIssue } from './lib.mjs';

const recordDirectories = ['data/archive', 'data/access-reports'];
const isEdition = issue => [1, 2, 3, 4].includes(issue?.version)
  && /^\d{4}-\d{2}-\d{2}$/u.test(issue.date ?? '')
  && (issue.version >= 4 ? Array.isArray(issue.stories) && Array.isArray(issue.sources) : Array.isArray(issue.sections))
  && Number.isFinite(Date.parse(issue.generatedAt));

export function recentEditions(editions, now = new Date()) {
  const end = new Date(now).getTime();
  const cutoff = end - config.historyHours * 3600000;
  const seen = new Map();
  for (const edition of editions) {
    const time = Date.parse(edition?.generatedAt);
    if (!isEdition(edition) || time < cutoff || time > end) continue;
    const existing = seen.get(edition.generatedAt);
    if (!existing || edition.version > existing.version) seen.set(edition.generatedAt, edition);
  }
  return [...seen.values()].sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
}

// The reader reuses published stories; no research or rescoring is needed.
export function closeByStories(current, history, now = new Date()) {
  if (!current?.generatedAt) return [];
  const dayStart = Date.parse(editorialDayStart(now));
  const currentTime = Date.parse(current.generatedAt);
  const currentKeys = new Set(issueStories(current).map(story => story.topicKey ?? story.title));
  const nearby = new Map();
  for (const edition of [...history].sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))) {
    const time = Date.parse(edition.generatedAt);
    if (time < dayStart || time >= currentTime) continue;
    const publicStories = toPublicIssue(edition).stories;
    issueStories(edition).forEach((story, index) => {
      const key = story.topicKey ?? story.title;
      if (currentKeys.has(key)) return;
      const earlier = nearby.get(key);
      if (earlier) earlier.firstCoveredAt = edition.generatedAt;
      else nearby.set(key, { ...publicStories[index], firstCoveredAt: edition.generatedAt });
    });
  }
  return [...nearby.values()];
}

export function validateContinuity(issue, history) {
  for (const story of [...issueStories(issue), ...issueNearMisses(issue)]) {
    if (!['update', 'ongoing'].includes(story.continuity)) continue;
    const previous = history.find(edition => edition.generatedAt === story.previousEditionAt);
    const topics = previous ? issueStories(previous) : [];
    const match = topics.some(saved => saved.topicKey === story.topicKey
      || (!saved.topicKey && saved.title === (story.previousTopicTitle ?? story.title)));
    if (!match) throw new Error(`Continuing topic ${story.topicKey} does not match a saved topic in the referenced edition.`);
  }
}

async function archiveRecords(base) {
  const groups = await Promise.all(recordDirectories.map(async relative => {
    const directory = resolve(base, relative);
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(async entry => {
      const file = resolve(directory, entry.name);
      try {
        const issue = JSON.parse(await readFile(file, 'utf8'));
        return isEdition(issue) ? { file, issue } : null;
      } catch (error) {
        if (error instanceof SyntaxError || error.code === 'ENOENT') return null;
        throw error;
      }
    }));
  }));
  return groups.flat().filter(Boolean);
}

export async function loadHistory(now = new Date(), base = root) {
  const records = await archiveRecords(base);
  let latest = [];
  try { latest = [JSON.parse(await readFile(resolve(base, 'data/latest.json'), 'utf8'))]; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return recentEditions([...latest, ...records.map(record => record.issue)], now);
}

export async function pruneHistory(now = new Date(), base = root) {
  const cutoff = new Date(now).getTime() - config.historyHours * 3600000;
  const expired = (await archiveRecords(base)).filter(record => Date.parse(record.issue.generatedAt) < cutoff);
  // Only recognized edition files returned from the two explicit record
  // directories are removed. Malformed and unrelated files are left alone.
  for (const record of expired) {
    try { await unlink(record.file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return expired.length;
}
