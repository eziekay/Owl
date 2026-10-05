import { config, editionWindow, editionDate, editorialDayStart, atomicJson, issueStories, issueNearMisses, issueSources } from './lib.mjs';
import { loadHistory } from './history.mjs';

// The collector prepares compact context. Research and the finished draft are
// handled in one agent pass; this script does not contact the web.
const window = editionWindow();
const collectedAt = new Date().toISOString();
const seen = new Set();
const editions = await loadHistory(new Date(collectedAt));
const history = [];
for (const edition of editions) {
  for (const story of issueStories(edition)) {
    const key = story.topicKey ?? story.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    history.push({
      topicKey: story.topicKey ?? null, title: story.title, previousEditionAt: edition.generatedAt,
      summary: (story.paragraphs ?? []).join(' ').slice(0, 500)
    });
  }
}
const crumbSeen = new Set();
const crumbs = [];
for (const edition of editions) {
  for (const crumb of issueNearMisses(edition)) {
    const key = crumb.topicKey ?? crumb.title.toLowerCase();
    if (seen.has(key) || crumbSeen.has(key) || !crumb.paragraphs?.length || !crumb.sourceIds?.length) continue;
    crumbSeen.add(key);
    crumbs.push({
      title: crumb.title,
      topicKey: crumb.topicKey ?? null,
      savedAt: edition.generatedAt,
      reason: crumb.reason,
      scores: crumb.scores,
      scoreNotes: crumb.scoreNotes,
      paragraphs: crumb.paragraphs,
      sources: issueSources(edition).filter(source => crumb.sourceIds.includes(source.id))
    });
  }
}

await atomicJson('data/collection.json', {
  version: 4,
  date: editionDate(window),
  window,
  collectedAt,
  editorialDay: { startsAt: editorialDayStart(new Date(collectedAt)), timezone: 'fixed UTC-08:00' },
  researchBudget: config.researchBudget,
  storySelection: config.storySelection,
  goals: config.goals,
  sourceWatchlist: config.sourceWatchlist,
  topics: config.topics,
  historyHours: config.historyHours,
  history,
  crumbs
});
console.log(`Prepared a ${config.windowHours}-hour window with ${history.length} distinct recent stories and ${crumbs.length} reusable Crumbs for context.`);
console.log(`Write data/draft.json once, then run node scripts/publish.mjs. No websites were contacted.`);
