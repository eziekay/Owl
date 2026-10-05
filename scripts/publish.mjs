import { config, readJson, atomicJson, validateIssue, toPublicIssue, publicNearMisses, issueSources } from './lib.mjs';
import { loadHistory, pruneHistory, validateContinuity } from './history.mjs';

const input = process.argv[2] ?? 'data/draft.json';
const archiveName = issue => issue.generatedAt.replace(/[:.]/gu, '-');
try {
  const draft = await readJson(input);
  const collection = await readJson('data/collection.json');
  const collectedAt = Date.parse(collection.collectedAt);
  if (!Number.isFinite(collectedAt)) throw new Error('Collection start time is missing.');
  if (draft.window && (collection.window?.start !== draft.window.start || collection.window?.end !== draft.window.end)) throw new Error('Draft does not match the current collection window.');
  draft.version = 4;
  draft.date = collection.date;
  draft.window = collection.window;
  draft.generatedAt = new Date().toISOString();
  draft.note ??= '';
  draft.research ??= {
    status: draft.stories?.length || draft.nearMisses?.length ? 'limited' : 'unavailable',
    note: draft.stories?.length || draft.nearMisses?.length
      ? 'A bounded sample of accessible public sources was reviewed.'
      : 'No usable observations were available in this pass.'
  };
  draft.updateDurationSeconds = Math.max(0, Math.round((Date.now() - collectedAt) / 1000));
  const issue = validateIssue(draft);
  validateContinuity(issue, await loadHistory(new Date(issue.window.end)));
  let previous;
  try { previous = await readJson('data/latest.json'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && previous.window.end > issue.window.end) throw new Error('An older edition cannot replace the current edition.');
  const sourceCount = issue.sources.length;
  const storyCount = issue.stories.length;
  await atomicJson('data/last-attempt.json', {
    date: issue.date, checkedAt: issue.generatedAt, sourceCount, storyCount, updateDurationSeconds: issue.updateDurationSeconds,
    research: issue.research, nearMisses: publicNearMisses(issue.nearMisses, issue.sources)
  });
  if (!storyCount && previous && issueSources(previous).length) {
    await atomicJson(`data/access-reports/${archiveName(issue)}.json`, issue);
    const removed = await pruneHistory();
    console.log(`No main-edition stories were selected. Kept the previous edition and saved this research pass${issue.nearMisses.length ? ` with ${issue.nearMisses.length} rejected candidate${issue.nearMisses.length === 1 ? '' : 's'}` : ''} in the retained history.`);
    if (removed) console.log(`Removed ${removed} expired history records older than ${config.historyHours} hours.`);
    process.exit(0);
  }
  // Retain the previous good edition in the local archive before replacing it.
  if (previous) await atomicJson(`data/archive/${archiveName(previous)}.json`, previous);
  await atomicJson(`data/archive/${archiveName(issue)}.json`, issue);
  await atomicJson('data/latest.json', issue);
  const removed = await pruneHistory();
  const safe = toPublicIssue(await readJson('data/latest.json'));
  console.log(`Published ${safe.date}: ${safe.stories.length} stories supported by ${safe.sourceCount} sources.`);
  console.log('The local website will read the edition automatically.');
  if (removed) console.log(`Removed ${removed} expired history records older than ${config.historyHours} hours.`);
} catch (error) {
  console.error(`Edition not published: ${error.message}`);
  process.exitCode = 1;
}
