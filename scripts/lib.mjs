import { readFileSync } from 'node:fs';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const config = JSON.parse(readFileSync(resolve(root, 'newsletter.config.json'), 'utf8'));
export const sourceClasses = ['primary', 'major-news', 'gaming-press', 'specialist', 'community', 'social', 'other'];
export const accessMethods = ['web-search', 'public-page', 'public-feed', 'public-api'];
const accessMethodAliases = new Map([
  ['search-result', 'web-search'], ['search result', 'web-search'], ['search_result', 'web-search']
]);
export function normalizeAccessMethod(value) {
  if (typeof value !== 'string') return value;
  const method = value.trim().toLowerCase();
  return accessMethodAliases.get(method) ?? method;
}
export const researchStatuses = ['complete', 'limited', 'unavailable'];
export const nearMissLimit = 5;
export const words = value => value.trim().split(/\s+/u).filter(Boolean).length;

export function editionWindow(now = new Date()) {
  const end = new Date(now);
  return { start: new Date(end.getTime() - config.windowHours * 3600000).toISOString(), end: end.toISOString() };
}
export function editionDate(window) {
  const date = new Date(window.end);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
// Fixed UTC−8 arithmetic keeps the editorial day independent of daylight
// saving time and avoids timezone database dependencies in the updater.
export function editorialDayStart(now = new Date()) {
  const localFixedTime = new Date(new Date(now).getTime() + config.editorialDay.utcOffsetMinutes * 60000);
  if (localFixedTime.getUTCHours() < config.editorialDay.startHour) localFixedTime.setUTCDate(localFixedTime.getUTCDate() - 1);
  const day = localFixedTime.toISOString().slice(0, 10);
  const hour = String(config.editorialDay.startHour).padStart(2, '0');
  return new Date(`${day}T${hour}:00:00-08:00`).toISOString();
}
export async function readJson(path) { return JSON.parse(await readFile(resolve(root, path), 'utf8')); }
export async function atomicJson(path, data) {
  const target = resolve(root, path);
  if (!target.startsWith(root)) throw new Error('Write must stay inside Owl.');
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await rename(temporary, target);
}
export function blankIssue(now = new Date()) {
  const window = editionWindow(now);
  return {
    version: 4, date: editionDate(window), generatedAt: null, window,
    sources: [], stories: [], note: 'No internet digest has been written yet.',
    research: { status: 'unavailable', note: 'No bounded web research has been published yet.' }
  };
}

// Older saved editions keep their original data and timestamps. These adapters
// let the reader and continuity checks use one story pool across all versions.
const issueGroups = issue => issue.version >= 4 ? [issue] : issue.sections ?? [];
export const issueStories = issue => issueGroups(issue).flatMap(group => group.stories ?? []);
export const issueNearMisses = issue => issue.version >= 4 && Array.isArray(issue.nearMisses) ? issue.nearMisses : [];
export function issueSources(issue) {
  const seen = new Set();
  return issueGroups(issue).flatMap(group => group.sources ?? []).filter(source => {
    const key = source.url ?? source.id ?? source;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

const classWeight = { primary: 5, 'major-news': 4, 'gaming-press': 3, specialist: 3, community: 2, social: 2, other: 1 };
const signalValue = value => Number.isFinite(value) ? Math.max(0, Math.min(5, value)) : 0;
export function sourceScore(source) {
  const signal = source.signal ?? {};
  return 4 * signalValue(signal.relevance)
    + 3 * signalValue(signal.activity)
    + 3 * signalValue(signal.corroboration)
    + 2 * signalValue(signal.credibility)
    + classWeight[source.sourceClass];
}
function publicHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.includes('.') && !/^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(url.hostname);
  } catch { return false; }
}
const validSourceDate = value => value == null || (Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() + 300000);
export function allowedSourceAccess(source) {
  try {
    const url = new URL(source.url);
    const matches = domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`);
    const path = decodeURIComponent(url.pathname);
    const noApi = config.sourceWatchlist.some(site => site.noApi && site.domains.some(matches))
      || ['youtube.googleapis.com', 'youtubei.googleapis.com'].some(matches)
      || (matches('googleapis.com') && /^\/youtube\//iu.test(path));
    return !noApi || (normalizeAccessMethod(source.accessMethod) !== 'public-api'
      && !/^(api|oauth)\./iu.test(url.hostname)
      && !/googleapis\.com$/iu.test(url.hostname)
      && !/\.json(?:\/|$)|\/(?:api|youtubei)(?:\/|$)/iu.test(path));
  } catch { return false; }
}
export function selectSources(candidates, limit) {
  const seenIds = new Set(), seenUrls = new Set();
  const eligible = candidates.filter(source => {
    if (!source.id || seenIds.has(source.id) || seenUrls.has(source.url) || !publicHttpsUrl(source.url)
      || !validSourceDate(source.publishedAt)
      || !sourceClasses.includes(source.sourceClass) || !accessMethods.includes(normalizeAccessMethod(source.accessMethod)) || !allowedSourceAccess(source)
      || !source.site || !source.title || !source.signal?.reason) return false;
    seenIds.add(source.id); seenUrls.add(source.url); return true;
  });
  return eligible.sort((a, b) => sourceScore(b) - sourceScore(a)
    || (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0)
    || a.id.localeCompare(b.id)).slice(0, limit);
}

const plain = (text, label, max = 5000) => {
  if (typeof text !== 'string' || /https?:\/\/|www\.|<[^>]+>|\]\s*\(/iu.test(text)) throw new Error(`${label} must be plain text without URLs, HTML, or Markdown links.`);
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters (${text.length}).`);
};
export function validateDiscovery(collection) {
  const checks = collection.topicChecks;
  if (!Array.isArray(checks) || checks.length !== config.topics.length
    || config.topics.some(topic => checks.filter(check => check.topic === topic).length !== 1)) {
    throw new Error('Record one discovery check for every configured topic.');
  }
  for (const check of checks) {
    if (!['searched', 'unavailable'].includes(check.status)
      || (check.status === 'searched' && (typeof check.query !== 'string' || !check.query.trim()))
      || typeof check.note !== 'string' || !check.note.trim()) {
      throw new Error('Each topic needs its actual focused query and outcome, or an honest unavailable reason.');
    }
  }
  if (checks.some(check => check.status === 'unavailable') && collection.research?.status === 'complete') {
    throw new Error('Incomplete topic discovery must be marked limited or unavailable.');
  }
}

// Presentation only: retain saved editions verbatim while splitting long prose
// at sentence boundaries. Never split decimals, or truncate a long sentence.
const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
export function summaryBullets(paragraphs) {
  return paragraphs.flatMap(paragraph => {
    const sentences = [...sentenceSegmenter.segment(paragraph)].map(part => part.segment.trim()).filter(Boolean);
    const bullets = [];
    let current = [], count = 0;
    for (const sentence of sentences) {
      if (current.length && (current.length === 2 || count + words(sentence) > 55)) {
        bullets.push(current.join(' ')); current = []; count = 0;
      }
      current.push(sentence); count += words(sentence);
    }
    if (current.length) bullets.push(current.join(' '));
    return bullets;
  });
}
const validSignal = signal => signal && ['relevance', 'credibility', 'activity', 'corroboration'].every(key => Number.isFinite(signal[key]) && signal[key] >= 0 && signal[key] <= 5);
export function owlScores(scores) {
  if (!scores || !['heat', 'time', 'ethos'].every(key => Number.isInteger(scores[key]) && scores[key] >= 0 && scores[key] <= 100)) {
    throw new Error('Each topic needs integer Heat, Time, and Ethos scores from 0 to 100.');
  }
  const { heat, time, ethos } = scores;
  return { general: Math.round((heat + time + ethos) / 3), heat, time, ethos };
}
const scoreKeys = ['general', 'heat', 'time', 'ethos'];
const publicCitation = source => ({
  site: source.site ?? 'Archived source', title: source.title ?? 'Untitled source',
  publishedAt: source.publishedAt ?? null, dateLabel: source.dateLabel ?? '',
  sourceClass: source.sourceClass ?? 'other'
});
export function normalizeNearMisses(nearMisses = []) {
  if (!Array.isArray(nearMisses)) throw new Error('Near misses must be an array.');
  if (nearMisses.length > nearMissLimit) throw new Error(`Near-miss cap exceeded (${nearMissLimit}).`);
  return nearMisses.map((nearMiss, index) => {
    if (!nearMiss || typeof nearMiss !== 'object') throw new Error(`Near miss ${index + 1} is malformed.`);
    plain(nearMiss.title, 'Near-miss title', 200);
    plain(nearMiss.reason, 'Near-miss reason', 500);
    if (!nearMiss.title.trim() || !nearMiss.reason.trim()) throw new Error('Near misses need a title and reason.');
    const scores = owlScores(nearMiss.scores);
    const scoreNotes = {};
    for (const key of scoreKeys) {
      plain(nearMiss.scoreNotes?.[key], `${key} near-miss score explanation`, 300);
      if (!nearMiss.scoreNotes[key].trim()) throw new Error(`Near misses need a ${key} score explanation.`);
      scoreNotes[key] = nearMiss.scoreNotes[key];
    }
    const normalized = { title: nearMiss.title, reason: nearMiss.reason, scores, scoreNotes };
    for (const key of ['topicKey', 'continuity', 'previousEditionAt', 'previousTopicTitle']) {
      if (nearMiss[key] != null) normalized[key] = nearMiss[key];
    }
    if (Array.isArray(nearMiss.paragraphs)) normalized.paragraphs = [...nearMiss.paragraphs];
    if (Array.isArray(nearMiss.sourceIds)) normalized.sourceIds = [...nearMiss.sourceIds];
    if (Array.isArray(nearMiss.citations)) normalized.citations = nearMiss.citations.map(publicCitation);
    return normalized;
  });
}
export const publicNearMisses = (nearMisses, sources = []) => normalizeNearMisses(nearMisses ?? []).map(nearMiss => {
  const safe = {
    title: nearMiss.title,
    reason: nearMiss.reason,
    scores: nearMiss.scores,
    scoreNotes: nearMiss.scoreNotes
  };
  if (nearMiss.paragraphs?.length) {
    safe.paragraphs = summaryBullets(nearMiss.paragraphs);
    safe.continuity = nearMiss.continuity ?? 'new';
    safe.previousEditionAt = nearMiss.previousEditionAt ?? null;
    safe.citations = nearMiss.citations ?? sources
      .filter(source => nearMiss.sourceIds?.includes(source.id))
      .map(publicCitation);
  }
  return safe;
});
export function validateIssue(issue) {
  if (issue.version !== 4 || !/^\d{4}-\d{2}-\d{2}$/.test(issue.date)) throw new Error('New editions require version 4 and a valid date.');
  const start = Date.parse(issue.window?.start), end = Date.parse(issue.window?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== config.windowHours * 3600000) throw new Error('Edition must cover the 24 hours preceding the manual update.');
  if (issue.date !== editionDate(issue.window)) throw new Error('Edition date does not match its window.');
  const generated = Date.parse(issue.generatedAt);
  if (!Number.isFinite(generated) || generated < end || generated > Date.now() + 300000) throw new Error('Invalid generation time.');
  if ('sections' in issue) throw new Error('New editions use one story pool, not category sections.');
  if (!Array.isArray(issue.sources) || issue.sources.length > config.researchBudget.maxCandidatesTotal) throw new Error('Source cap exceeded.');
  const ids = new Set();
  for (const source of issue.sources) {
    source.accessMethod = normalizeAccessMethod(source.accessMethod);
    if (!source.id) throw new Error('Each source needs an ID.');
    if (ids.has(source.id)) throw new Error('Source IDs must be unique.');
    ids.add(source.id);
    if (!validSourceDate(source.publishedAt)) throw new Error('Publication date is malformed or in the future; use null when unknown.');
    if (source.verified != null && typeof source.verified !== 'boolean') throw new Error('Source verification must be true or false when supplied.');
    if (!publicHttpsUrl(source.url)) throw new Error('Source must use a public HTTPS page.');
    if (source.sourceClass != null && !sourceClasses.includes(source.sourceClass)) throw new Error('Invalid source classification.');
    if (source.accessMethod != null && !accessMethods.includes(source.accessMethod)) throw new Error('Invalid source access method.');
    if (!allowedSourceAccess({ ...source, accessMethod: source.accessMethod ?? 'web-search' })) throw new Error('Reddit, X, and YouTube sources must not use API or JSON endpoints.');
    if (source.signal != null && !validSignal(source.signal)) throw new Error('Source signals must use 0–5 values when supplied.');
    if (source.signal?.reason != null) plain(source.signal.reason, 'Source selection reason', 500);
    plain(source.site, 'Publication name', 120);
    plain(source.title, 'Source title', 300);
    plain(source.contentBasis ?? '', 'Content basis', 300);
    plain(source.dateLabel ?? '', 'Source date description', 120);
  }
  if (!Array.isArray(issue.stories) || (issue.sources.length === 0 && issue.stories.length)) throw new Error('Stories require selected sources.');
  if (issue.stories.length > config.storySelection.maxStories) throw new Error('Story cap exceeded.');
  issue.nearMisses = normalizeNearMisses(issue.nearMisses ?? []);
  const used = new Set(), topicKeys = new Set();
  for (const story of issue.stories) {
    plain(story.title, 'Story title', 200);
    if (!story.title.trim() || !Array.isArray(story.paragraphs) || !story.paragraphs.length || !Array.isArray(story.sourceIds) || !story.sourceIds.length) throw new Error('Each story needs a title, paragraphs, and source IDs.');
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/u.test(story.topicKey ?? '') || topicKeys.has(story.topicKey)) throw new Error('Each story needs a unique stable lowercase topicKey.');
    topicKeys.add(story.topicKey);
    if (!['new', 'update', 'ongoing'].includes(story.continuity)) throw new Error('Topic continuity must be new, update, or ongoing.');
    story.scores = owlScores(story.scores);
    plain(story.scoreNotes?.general, 'general score explanation', 300);
    if (!story.scoreNotes.general.trim()) throw new Error('Each topic needs a concise overall Owl score explanation.');
    for (const key of ['heat', 'time', 'ethos']) {
      plain(story.scoreNotes?.[key], `${key} score explanation`, 300);
      if (!story.scoreNotes[key].trim()) throw new Error('Each score needs a short explanation.');
    }
    if (story.continuity !== 'new') {
      plain(story.previousTopicTitle ?? '', 'Previous topic title', 200);
      const previous = Date.parse(story.previousEditionAt);
    if (!Number.isFinite(previous) || previous >= generated || previous < end - config.historyHours * 3600000) throw new Error('Continuing topics must refer to an edition in the retained history window.');
    }
    for (const paragraph of story.paragraphs) {
      plain(paragraph, 'Summary', Infinity);
      if (!paragraph.trim()) throw new Error('Summary paragraphs must not be empty.');
    }
    for (const id of story.sourceIds) { if (!ids.has(id)) throw new Error('Story cites an unselected source.'); used.add(id); }
  }
  for (const crumb of issue.nearMisses) {
    if (!Array.isArray(crumb.paragraphs) || !crumb.paragraphs.length || !Array.isArray(crumb.sourceIds) || !crumb.sourceIds.length) {
      throw new Error('Each Crumb needs paragraphs and source IDs so it can move into the main edition later.');
    }
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/u.test(crumb.topicKey ?? '') || topicKeys.has(crumb.topicKey)) {
      throw new Error('Each story and Crumb needs a unique stable lowercase topicKey.');
    }
    topicKeys.add(crumb.topicKey);
    if (!['new', 'update', 'ongoing'].includes(crumb.continuity)) throw new Error('Crumb continuity must be new, update, or ongoing.');
    if (crumb.continuity !== 'new') {
      plain(crumb.previousTopicTitle ?? '', 'Previous topic title', 200);
      const previous = Date.parse(crumb.previousEditionAt);
      if (!Number.isFinite(previous) || previous >= generated || previous < end - config.historyHours * 3600000) {
        throw new Error('Continuing Crumbs must refer to an edition in the retained history window.');
      }
    }
    for (const paragraph of crumb.paragraphs) {
      plain(paragraph, 'Crumb summary', Infinity);
      if (!paragraph.trim()) throw new Error('Crumb paragraphs must not be empty.');
    }
    for (const id of crumb.sourceIds) {
      if (!ids.has(id)) throw new Error('Crumb cites an unselected source.');
      used.add(id);
    }
  }
  if (used.size !== ids.size) throw new Error('Each selected source must contribute to a summary.');
  if (issue.updateDurationSeconds != null && (!Number.isInteger(issue.updateDurationSeconds) || issue.updateDurationSeconds < 0)) throw new Error('Update duration must be a whole number of seconds.');
  plain(issue.note ?? '', 'Edition note');
  if (!issue.research || !researchStatuses.includes(issue.research.status)) throw new Error('The story pool needs a valid research status.');
  plain(issue.research.note, 'Research note', 500);
  if (issue.research.status === 'unavailable' && issue.stories.length) throw new Error('Unavailable research cannot contain main-edition stories.');
  return issue;
}

export function toPublicIssue(issue) {
  const stories = issueGroups(issue).flatMap(group => {
    const sources = group.sources ?? [];
    return (group.stories ?? []).map(s => ({
      title: s.title, paragraphs: summaryBullets(s.paragraphs),
      scores: s.scores ? owlScores(s.scores) : null,
      scoreNotes: s.scoreNotes ? Object.fromEntries(['general', 'heat', 'time', 'ethos'].map(key => [key, s.scoreNotes[key] ?? ''])) : null,
      continuity: s.continuity ?? 'new', previousEditionAt: s.previousEditionAt ?? null,
      citations: sources.filter(source => !s.sourceIds || s.sourceIds.includes(source.id)).map(publicCitation)
    }));
  });
  return {
    date: issue.date, generatedAt: issue.generatedAt, updateDurationSeconds: issue.updateDurationSeconds ?? null, window: issue.window, stories,
    nearMisses: publicNearMisses(issue.nearMisses, issue.sources),
    sourceCount: issueSources(issue).length, note: issue.note ?? '',
    research: issue.research ? { status: issue.research.status, note: issue.research.note }
      : { status: stories.length ? 'limited' : 'unavailable', note: 'Saved research from Owl’s earlier category-based format.' },
    sourceMap: {
      watchlist: config.sourceWatchlist.map(site => ({ name: site.name, note: site.noApi ? 'No API calls; permitted public text only.' : 'Permitted public reporting and discovery.' })),
      topics: config.topics
    },
    researchBudget: config.researchBudget,
    storySelection: config.storySelection,
    historyHours: config.historyHours,
    readingMinutes: Math.max(1, Math.ceil(stories.reduce((n, s) => n + words(s.title) + s.paragraphs.reduce((a, p) => a + words(p), 0), 0) / 220))
  };
}
