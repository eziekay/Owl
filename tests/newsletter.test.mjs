import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, blankIssue, editionWindow, editionDate, selectSources, validateIssue, toPublicIssue, validateDiscovery, summaryBullets } from '../scripts/lib.mjs';
import { closeByStories, recentEditions, loadHistory, pruneHistory, validateContinuity } from '../scripts/history.mjs';
const execute = promisify(execFile);

function validIssue() {
  const issue = blankIssue(new Date('2026-09-28T18:00:00Z'));
  issue.generatedAt = '2026-09-28T18:00:00Z';
  return issue;
}
function source(id, publishedAt = '2026-09-28T12:00:00Z', overrides = {}) {
  return {
    id: `web:${id}`, site: 'Example News', title: `Verified source ${id}`,
    url: `https://news.example.com/articles/${id}`, publishedAt,
    fetchedAt: '2026-09-28T18:00:00Z', verified: true,
    sourceClass: 'major-news', accessMethod: 'public-page',
    contentBasis: 'Article text', body: 'Private audit notes.',
    signal: { relevance: 4, credibility: 4, activity: 3, corroboration: 3, reason: 'Relevant recent reporting with independent support.' },
    ...overrides
  };
}
function populate(issue, sources) {
  issue.sources = sources;
  issue.stories = [{
    title: 'The day’s topic', topicKey: 'stable-topic', continuity: 'new',
    scores: { heat: 80, time: 95, ethos: 60 },
    scoreNotes: { general: 'Recent attention makes this useful despite limited verification.', heat: 'Attention in the sampled community.', time: 'Recent activity.', ethos: 'Evidence supports only the attributed account.' },
    paragraphs: ['A concise synthesis of reporting and visible discussion.'], sourceIds: sources.map(item => item.id)
  }];
  issue.research = { status: 'limited', note: 'A bounded sample of current public reporting was reviewed.' };
  return issue;
}
function crumb(sourceId = 'web:crumb') {
  return {
    title: 'A promising but stale lead', topicKey: 'promising-stale-lead', continuity: 'new', previousEditionAt: null,
    reason: 'It was outside the fresh window and did not fill a remaining main-edition slot.',
    scores: { heat: 65, time: 45, ethos: 70 },
    scoreNotes: {
      general: 'Useful context with enough attention, but not selected for the main edition.',
      heat: 'Meaningful attention cleared the editorial floor.',
      time: 'The visible development was outside the fresh window.',
      ethos: 'The available reporting was credible but incomplete.'
    },
    paragraphs: ['A concise synthesis of the promising lead and why it matters.'],
    sourceIds: [sourceId]
  };
}

test('Close by reuses the latest saved version once and resets at 9 AM fixed PST', () => {
  const edition = (at, key, title, heat) => {
    const issue = populate(validIssue(), [source(key)]);
    issue.generatedAt = at;
    issue.stories[0].topicKey = key;
    issue.stories[0].title = title;
    issue.stories[0].scores.heat = heat;
    return issue;
  };
  const beforeDay = edition('2026-09-30T16:59:59Z', 'old', 'Before reset', 75);
  const first = edition('2026-09-30T17:10:00Z', 'returning', 'First version', 60);
  const revised = edition('2026-09-30T18:00:00Z', 'returning', 'Latest version', 91);
  const inLatest = edition('2026-09-30T18:30:00Z', 'main-story', 'Earlier main story', 70);
  const current = edition('2026-09-30T19:00:00Z', 'main-story', 'Current main story', 80);
  const history = [beforeDay, first, inLatest, revised, current];
  const nearby = closeByStories(current, history, new Date('2026-09-30T20:00:00Z'));
  assert.equal(nearby.length, 1);
  assert.equal(nearby[0].title, 'Latest version');
  assert.equal(nearby[0].firstCoveredAt, first.generatedAt);
  assert.deepEqual(nearby[0].scores, toPublicIssue(revised).stories[0].scores);
  assert.deepEqual(nearby[0].scoreNotes, toPublicIssue(revised).stories[0].scoreNotes);
  assert.deepEqual(closeByStories(current, history, new Date('2026-10-01T17:00:00Z')), []);
});

test('manual updates cover exactly the preceding 24 hours at any time of day', () => {
  for (const hour of ['03', '16', '23']) {
    const now = new Date(`2026-09-28T${hour}:42:17.123Z`);
    const window = editionWindow(now);
    assert.equal(window.end, now.toISOString());
    assert.equal(Date.parse(window.end) - Date.parse(window.start), 24 * 3600000);
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    assert.equal(editionDate(window), expected);
  }
});

test('selection retains older, undated, and unverified sources while rejecting malformed records and duplicates', () => {
  const candidates = [
    source('valid'), source('valid'),
    source('old', '2026-09-26T18:00:00Z'), source('future', '2100-09-28T19:00:00Z'),
    source('unchecked', null, { verified: false }),
    source('local', undefined, { url: 'http://127.0.0.1/private' }),
    source('incomplete', undefined, { signal: {} })
  ];
  assert.deepEqual(selectSources(candidates, 10).map(item => item.id), ['web:valid', 'web:old', 'web:unchecked']);
});

test('selection weights relevance, activity, corroboration, credibility, and applies caps', () => {
  const low = source('low', undefined, { sourceClass: 'other', signal: { relevance: 1, credibility: 1, activity: 1, corroboration: 1, reason: 'Weak but valid signal.' } });
  const high = source('high', undefined, { sourceClass: 'primary', signal: { relevance: 5, credibility: 5, activity: 4, corroboration: 5, reason: 'Primary evidence with strong independent attention.' } });
  const selected = selectSources([low, high, source('middle')], 2, validIssue().window);
  assert.deepEqual(selected.map(item => item.id), ['web:high', 'web:middle']);
});

test('publishing accepts an honest empty report and a sourced digest', () => {
  assert.deepEqual(validateIssue(validIssue()).stories, []);
  assert.equal(validateIssue(populate(validIssue(), [source('abc')])).sources.length, 1);
});

test('publishing accepts gaming press sources', () => {
  const issue = populate(validIssue(), [source('gamesradar', undefined, { sourceClass: 'gaming-press' })]);
  assert.equal(validateIssue(issue).sources[0].sourceClass, 'gaming-press');
});

test('publishing accepts distinct items cited from the same listing page', () => {
  const listing = 'https://news.example.com/latest';
  const issue = populate(validIssue(), [
    source('first-item', undefined, { url: listing, title: 'First visible item' }),
    source('second-item', undefined, { url: listing, title: 'Second visible item' })
  ]);
  assert.deepEqual(validateIssue(issue).sources.map(item => item.id), ['web:first-item', 'web:second-item']);
});

test('publishing still rejects duplicate source IDs', () => {
  const issue = populate(validIssue(), [
    source('same-id'),
    source('same-id', undefined, { url: 'https://news.example.com/another-item' })
  ]);
  assert.throws(() => validateIssue(issue), /Source IDs must be unique/);
});

test('publishing accepts uncertainty and old evidence, but rejects source caps and invented citations', () => {
  assert.throws(() => validateIssue(populate(validIssue(), Array.from({ length: config.researchBudget.maxCandidatesTotal + 1 }, (_, index) => source(`${index}`)))), /cap exceeded/);
  assert.equal(validateIssue(populate(validIssue(), [source('old', '2020-09-26T12:00:00Z')])).sources.length, 1);
  assert.equal(validateIssue(populate(validIssue(), [source('rumor', null, { verified: false })])).sources.length, 1);
  const invented = populate(validIssue(), [source('real')]); invented.stories[0].sourceIds = ['web:fake'];
  assert.throws(() => validateIssue(invented), /unselected/);
  const omitted = populate(validIssue(), [source('real'), source('omitted')]); omitted.stories[0].sourceIds = ['web:real'];
  assert.throws(() => validateIssue(omitted), /must contribute/);
});

test('reader-facing prose rejects outbound URLs and HTML without imposing a reading-time ceiling', () => {
  for (const bad of ['Read https://example.com', '<img src=x>', '[Click](https://example.com)']) {
    const issue = populate(validIssue(), [source('real')]); issue.stories[0].paragraphs = [bad];
    assert.throws(() => validateIssue(issue), /plain text/);
  }
  const issue = populate(validIssue(), [source('real')]);
  issue.stories[0].paragraphs = Array.from({ length: 12 }, () => 'word '.repeat(250));
  assert.ok(toPublicIssue(validateIssue(issue)).readingMinutes > 10);
});

test('public issue exposes bibliography metadata but strips URLs, bodies, IDs, and signal scores', () => {
  const issue = populate(validIssue(), [source('secret', undefined, { author: 'audit-author' })]);
  const publicIssue = toPublicIssue(issue);
  assert.deepEqual(publicIssue.stories[0].citations[0], {
    site: 'Example News', title: 'Verified source secret', publishedAt: '2026-09-28T12:00:00Z', dateLabel: '', sourceClass: 'major-news'
  });
  assert.deepEqual(publicIssue.stories[0].scores, { general: 78, heat: 80, time: 95, ethos: 60 });
  assert.equal(publicIssue.stories[0].scoreNotes.ethos, 'Evidence supports only the attributed account.');
  const output = JSON.stringify(publicIssue);
  for (const text of ['https:', 'web:secret', 'Private audit notes', 'audit-author', 'independent support', 'stable-topic']) assert.ok(!output.includes(text));
});

test('general score is derived, zero scores are publishable, and out-of-range components are rejected', () => {
  const issue = populate(validIssue(), [source('real')]);
  const story = issue.stories[0];
  story.scores = { general: 100, heat: 0, time: 0, ethos: 0 };
  assert.deepEqual(validateIssue(issue).stories[0].scores, { general: 0, heat: 0, time: 0, ethos: 0 });
  for (const value of [-1, 101, 40.5, '60', null]) {
    story.scores.heat = value;
    assert.throws(() => validateIssue(issue), /scores from 0 to 100/);
  }
});

test('near misses preserve reader-safe reasons and Owl scores without becoming stories', () => {
  const issue = validIssue();
  issue.sources = [source('crumb')];
  issue.nearMisses = [crumb()];
  const safe = toPublicIssue(validateIssue(issue));
  assert.equal(safe.stories.length, 0);
  assert.deepEqual(safe.nearMisses[0].scores, { general: 60, heat: 65, time: 45, ethos: 70 });
  assert.equal(safe.nearMisses[0].reason, issue.nearMisses[0].reason);
  assert.equal(safe.nearMisses[0].paragraphs.length, 1);
  assert.equal(safe.nearMisses[0].citations.length, 1);
  assert.equal('sourceIds' in safe.nearMisses[0], false);
  issue.nearMisses[0].reason = 'See https://example.com';
  assert.throws(() => validateIssue(issue), /plain text/);
});

test('low-Heat rejected candidates remain valid Crumbs', () => {
  const issue = validIssue();
  issue.sources = [source('low-heat-crumb')];
  issue.nearMisses = [crumb('web:low-heat-crumb')];
  issue.nearMisses[0].scores.heat = 15;
  issue.nearMisses[0].scoreNotes.heat = 'The candidate had little visible attention and did not clear the main-edition bar.';
  issue.nearMisses[0].reason = 'Rejected because the visible attention was too low for the main edition.';
  const safe = toPublicIssue(validateIssue(issue));
  assert.equal(safe.nearMisses[0].scores.heat, 15);
  assert.equal(safe.stories.length, 0);
});

test('a fully researched item can move between Crumbs and the main edition', () => {
  const issue = validIssue();
  issue.sources = [source('crumb')];
  issue.nearMisses = [crumb()];
  validateIssue(issue);
  const promoted = { ...issue.nearMisses[0] };
  delete promoted.reason;
  issue.stories = [promoted]; issue.nearMisses = [];
  issue.research = { status: 'limited', note: 'A test-only reclassification.' };
  assert.equal(validateIssue(issue).stories[0].topicKey, 'promising-stale-lead');
  issue.nearMisses = [{ ...issue.stories[0], reason: 'A future criterion moved this item back to Crumbs.' }];
  issue.stories = [];
  assert.equal(validateIssue(issue).nearMisses[0].sourceIds[0], 'web:crumb');
});

test('score explanations stay text-only and ongoing topics must refer to the seven-day window', () => {
  const issue = populate(validIssue(), [source('real')]);
  const story = issue.stories[0];
  story.continuity = 'update'; story.previousEditionAt = '2026-09-27T18:00:00Z';
  assert.equal(validateIssue(issue).stories[0].continuity, 'update');
  story.previousEditionAt = '2026-09-20T18:00:00Z';
  assert.throws(() => validateIssue(issue), /retained history window/);
  story.previousEditionAt = '2026-09-27T18:00:00Z'; story.scoreNotes.ethos = 'Read https://example.com';
  assert.throws(() => validateIssue(issue), /plain text/);
});

test('unknown dates survive bibliography serialization without becoming invented timestamps', () => {
  const issue = populate(validIssue(), [source('unknown', null, { verified: false, dateLabel: 'September 2026' })]);
  const citation = toPublicIssue(validateIssue(issue)).stories[0].citations[0];
  assert.equal(citation.publishedAt, null);
  assert.equal(citation.dateLabel, 'September 2026');
});

test('history includes the seven-day boundary, deduplicates updates, and prefers scored versions', () => {
  const now = new Date('2026-09-29T18:00:00Z');
  const newest = validIssue();
  const duplicate = { version: 2, date: newest.date, generatedAt: newest.generatedAt, sections: [] };
  const boundary = { ...newest, generatedAt: '2026-09-22T18:00:00Z' };
  const expired = { ...newest, generatedAt: '2026-09-22T17:59:59Z' };
  const future = { ...newest, generatedAt: '2026-09-29T18:00:01Z' };
  const saved = recentEditions([duplicate, expired, newest, boundary, future], now);
  assert.deepEqual(saved.map(edition => edition.generatedAt), [newest.generatedAt, boundary.generatedAt]);
  assert.equal(saved[0].version, 4);
});

test('topic continuity matches a real saved topic and cannot invent an earlier edition', () => {
  const previous = populate(validIssue(), [source('old')]);
  previous.generatedAt = '2026-09-27T18:00:00Z';
  const current = populate(validIssue(), [source('new')]);
  const topic = current.stories[0];
  topic.continuity = 'update'; topic.previousEditionAt = previous.generatedAt;
  assert.doesNotThrow(() => validateContinuity(current, [previous]));
  assert.throws(() => validateContinuity(current, []), /does not match/);
  topic.topicKey = 'different-topic';
  assert.throws(() => validateContinuity(current, [previous]), /does not match/);
  delete previous.stories[0].topicKey;
  topic.title = 'A small new development'; topic.previousTopicTitle = previous.stories[0].title;
  assert.doesNotThrow(() => validateContinuity(current, [previous]));
});

test('one story pool caps stories at fifteen and requires unique situations, not category quotas', () => {
  const issue = populate(validIssue(), [source('real')]);
  const story = issue.stories[0];
  assert.equal(config.storySelection.targetMin, 7);
  assert.equal(config.storySelection.maxStories, 15);
  issue.stories = Array.from({ length: 15 }, (_, index) => ({ ...story, topicKey: `story-${index}` }));
  assert.equal(validateIssue(issue).stories.length, 15);
  issue.stories.push({ ...story, topicKey: 'sixteenth-story' });
  assert.throws(() => validateIssue(issue), /Story cap exceeded/);
  issue.stories.pop(); issue.stories[1].topicKey = issue.stories[0].topicKey;
  assert.throws(() => validateIssue(issue), /unique stable/);
});

test('discovery requires every topic, but allows honest limitations and no story quotas', () => {
  const collection = { research: { status: 'complete' }, storyCandidates: [],
    topicChecks: config.topics.map(topic => ({ topic, status: 'searched', query: `${topic} major developments`, note: 'No substantial findings.' })) };
  assert.doesNotThrow(() => validateDiscovery(collection));
  const missing = structuredClone(collection); missing.topicChecks.pop();
  assert.throws(() => validateDiscovery(missing), /every configured topic/);
  collection.topicChecks[0].status = 'not-started';
  assert.throws(() => validateDiscovery(collection), /actual focused query/);
  collection.topicChecks[0] = { topic: config.topics[0], status: 'unavailable', query: null, note: 'Search tool unavailable.' };
  assert.throws(() => validateDiscovery(collection), /marked limited/);
  collection.research.status = 'limited';
  assert.doesNotThrow(() => validateDiscovery(collection));
});

test('saved paragraphs display as short sentence groups without changing content or saved data', () => {
  const text = 'The version is 1.5 today. Its price is $3.99. Players have mixed reactions. The developer has not responded. Another update is pending.';
  const paragraphs = [text];
  const bullets = summaryBullets(paragraphs);
  assert.equal(bullets.length, 3);
  assert.equal(bullets.join(' '), text);
  assert.deepEqual(paragraphs, [text]);
  const issue = populate(validIssue(), [source('bullet')]);
  issue.stories[0].paragraphs = paragraphs;
  const snapshot = JSON.stringify(issue);
  assert.deepEqual(toPublicIssue(issue).stories[0].paragraphs, bullets);
  assert.equal(JSON.stringify(issue), snapshot);
});

test('no-API watchlist sources reject API records and disguised JSON endpoints, but accept public text', () => {
  for (const url of [
    'https://www.reddit.com/r/games/top.json', 'https://oauth.reddit.com/hot',
    'https://api.x.com/2/tweets', 'https://www.youtube.com/youtubei/v1/browse',
    'https://youtube.googleapis.com/youtube/v3/videos', 'https://www.googleapis.com/youtube/v3/videos'
  ]) {
    const record = source('restricted', undefined, { url });
    assert.equal(selectSources([record], 40).length, 0);
    assert.throws(() => validateIssue(populate(validIssue(), [record])), /API or JSON endpoints/);
  }
  const page = source('public', undefined, { url: 'https://www.reddit.com/r/games/comments/example', accessMethod: 'web-search' });
  assert.equal(selectSources([page], 40).length, 1);
  page.accessMethod = 'public-api';
  assert.equal(selectSources([page], 40).length, 0);
});

test('legacy categories flatten into stories with their own citations and retain continuity', () => {
  const old = populate(validIssue(), [source('legacy')]);
  const legacy = { version: 3, date: old.date, generatedAt: '2026-09-27T18:00:00Z', window: old.window,
    sections: [{ id: 'old-category', sources: old.sources, stories: old.stories, research: old.research }] };
  const safe = toPublicIssue(legacy);
  assert.equal(safe.stories.length, 1);
  assert.equal(safe.stories[0].citations[0].site, 'Example News');
  assert.equal(safe.generatedAt, legacy.generatedAt);
  assert.equal('sections' in safe, false);
  const current = populate(validIssue(), [source('new')]);
  current.stories[0].continuity = 'update'; current.stories[0].previousEditionAt = legacy.generatedAt;
  assert.doesNotThrow(() => validateContinuity(current, [legacy]));
  assert.equal(safe.sourceMap.watchlist.length, 8);
  assert.equal(safe.sourceMap.topics.length, 4);
});

test('one-draft CLI pipeline preserves a good legacy edition on an empty pass, then publishes a unified digest', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'owl-pipeline-test-'));
  const run = name => execute(process.execPath, [`scripts/${name}.mjs`], { cwd: temporary, windowsHide: true });
  const read = async name => JSON.parse(await readFile(resolve(temporary, `data/${name}.json`), 'utf8'));
  const save = (name, value) => writeFile(resolve(temporary, `data/${name}.json`), JSON.stringify(value));
  try {
    await mkdir(resolve(temporary, 'scripts'));
    await mkdir(resolve(temporary, 'data'));
    await copyFile(new URL('../newsletter.config.json', import.meta.url), resolve(temporary, 'newsletter.config.json'));
    for (const name of ['lib', 'history', 'collect', 'publish']) {
      await copyFile(new URL(`../scripts/${name}.mjs`, import.meta.url), resolve(temporary, `scripts/${name}.mjs`));
    }
    const saved = populate(validIssue(), [source('saved')]);
    saved.generatedAt = new Date(Date.now() - 3600000).toISOString();
    saved.window = editionWindow(new Date(saved.generatedAt)); saved.date = editionDate(saved.window);
    const legacy = { version: 3, date: saved.date, generatedAt: saved.generatedAt, window: saved.window,
      sections: [{ id: 'indie-gaming', sources: saved.sources, stories: saved.stories, research: saved.research }] };
    await save('latest', legacy);
    await run('collect');
    let collection = await read('collection');
    assert.equal(collection.version, 4);
    assert.equal(collection.sourceWatchlist.length, 8);
    assert.deepEqual(collection.topics, config.topics);
    assert.deepEqual(collection.goals, config.goals);
    assert.equal(collection.history[0].topicKey, 'stable-topic');
    assert.equal(collection.history[0].summary.length > 0, true);
    assert.deepEqual(collection.crumbs, []);
    assert.equal('candidates' in collection, false);
    assert.equal('storyCandidates' in collection, false);
    assert.equal('sections' in collection, false);
    await save('draft', {
      sources: [{ id: 'web:crumb-integration', site: 'Example News', title: 'Crumb source', url: 'https://news.example.com/crumb', publishedAt: null }],
      stories: [],
      nearMisses: [{
        ...crumb('web:crumb-integration'),
        title: 'Test Crumb', topicKey: 'test-crumb', reason: 'The test lead was too old for the fresh window.'
      }],
      research: { status: 'limited', note: 'A test-only Crumb pass.' }
    });
    await run('publish');
    assert.equal((await read('latest')).generatedAt, legacy.generatedAt);
    const emptyAttempt = await read('last-attempt');
    assert.equal(emptyAttempt.sourceCount, 1);
    assert.equal(emptyAttempt.storyCount, 0);
    assert.equal(emptyAttempt.nearMisses.length, 1);
    assert.equal(emptyAttempt.nearMisses[0].citations.length, 1);

    await run('collect'); collection = await read('collection');
    assert.equal(collection.crumbs.length, 1);
    assert.equal(collection.crumbs[0].topicKey, 'test-crumb');
    assert.equal(collection.crumbs[0].sources.length, 1);
    await save('draft', {
      sources: [{ id: 'web:integration', site: 'Example News', title: 'Integration source', url: 'https://news.example.com/integration', publishedAt: null }],
      stories: [{ ...saved.stories[0], topicKey: 'integration-topic', sourceIds: ['web:integration'] }],
      research: { status: 'limited', note: 'A test-only sourced pass.' }
    });
    await run('publish');
    const latest = await read('latest');
    assert.equal(latest.version, 4);
    assert.equal(latest.stories.length, 1);
    assert.equal((await read('last-attempt')).sourceCount, 1);
    assert.equal((await loadHistory(new Date(), temporary)).length, 3);
  } finally {
    if (!temporary.startsWith(resolve(tmpdir(), 'owl-pipeline-test-'))) throw new Error('Unexpected test directory.');
    await rm(temporary, { recursive: true, force: true });
  }
});

test('retention removes only expired recognized records and preserves the latest digest and unrelated files', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'owl-history-test-'));
  try {
    await mkdir(resolve(temporary, 'data/archive'), { recursive: true });
    await mkdir(resolve(temporary, 'data/access-reports'), { recursive: true });
    const old = { ...validIssue(), generatedAt: '2026-09-20T18:00:00Z' };
    const current = populate(validIssue(), [source('secret')]);
    await Promise.all([
      writeFile(resolve(temporary, 'data/archive/old.json'), JSON.stringify(old)),
      writeFile(resolve(temporary, 'data/archive/current.json'), JSON.stringify(current)),
      writeFile(resolve(temporary, 'data/access-reports/attempt.json'), JSON.stringify(current)),
      writeFile(resolve(temporary, 'data/archive/notes.json'), '{"personal":"Keep this"}'),
      writeFile(resolve(temporary, 'data/latest.json'), JSON.stringify(old))
    ]);
    const now = new Date('2026-09-29T18:00:00Z');
    assert.equal((await loadHistory(now, temporary)).length, 1);
    assert.equal(await pruneHistory(now, temporary), 1);
    await assert.rejects(readFile(resolve(temporary, 'data/archive/old.json')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(resolve(temporary, 'data/latest.json'))).generatedAt, old.generatedAt);
    assert.equal(JSON.parse(await readFile(resolve(temporary, 'data/archive/notes.json'))).personal, 'Keep this');
    const output = JSON.stringify((await loadHistory(now, temporary)).map(toPublicIssue));
    for (const privateText of ['https:', 'web:secret', 'Private audit notes', 'stable-topic']) assert.ok(!output.includes(privateText));
  } finally {
    if (!temporary.startsWith(resolve(tmpdir(), 'owl-history-test-'))) throw new Error('Unexpected test directory.');
    await rm(temporary, { recursive: true, force: true });
  }
});
