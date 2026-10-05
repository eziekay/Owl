const sourceClassNames = { primary: 'Primary source', 'major-news': 'Major publication', specialist: 'Specialist publication', community: 'Community source', social: 'Social source', other: 'Public source' };
const staticSite = document.documentElement?.dataset?.mode === 'static';
const main = document.querySelector('#newsletter');
const status = document.querySelector('#edition-status');
let displayed = null;
let latestIssue = null;
let viewing = null;
let savedEditions = [];
let displayedHistory = null;
let screen = 'home';
let activeJob = null;
let polling = false;
const page = document.querySelector('.page');
const actions = document.querySelector('#title-actions');
const menu = document.querySelector('#edition-menu');
const notice = document.querySelector('#title-notice');
const progress = document.querySelector('#update-progress');
const updateButton = document.querySelector('#update-button');
const readButton = document.querySelector('#read-button');
const homeButton = document.querySelector('#home-button');
const otherEditionsButton = document.querySelector('#other-editions-button');
const nearMissRegion = document.querySelector('#crumbs');
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const regionAnimations = new WeakMap();
let screenTransition = null;
let screenRevision = 0;
let screenReady = false;
if (staticSite) updateButton.hidden = true;
else try { activeJob = sessionStorage.getItem('owl-update'); } catch {}

function animateRegion(node, expanded) {
  const previous = regionAnimations.get(node);
  if (reducedMotion() || !node.animate) { previous?.cancel(); node.hidden = !expanded; return; }
  const currentHeight = node.hidden ? 0 : node.getBoundingClientRect?.().height ?? 0;
  const currentOpacity = node.hidden ? 0 : Number(getComputedStyle(node).opacity);
  previous?.cancel();
  node.hidden = false;
  const style = getComputedStyle(node);
  const fullHeight = node.getBoundingClientRect().height;
  const full = { height: `${fullHeight}px`, opacity: 1, transform: 'translateY(0)', marginTop: style.marginTop, marginBottom: style.marginBottom, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom, overflow: 'hidden' };
  const collapsed = { height: '0px', opacity: 0, transform: 'translateY(-6px)', marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px', overflow: 'hidden' };
  const start = previous ? { ...full, height: `${currentHeight}px`, opacity: currentOpacity } : expanded ? collapsed : full;
  const animation = node.animate([start, expanded ? full : collapsed], { duration: 260, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' });
  regionAnimations.set(node, animation);
  animation.finished.then(() => {
    if (regionAnimations.get(node) !== animation) return;
    node.hidden = !expanded;
    animation.cancel(); regionAnimations.delete(node);
  }).catch(() => {});
}

function animateDisclosure(details) {
  const summary = details.querySelector('summary');
  const content = details.querySelector('.disclosure-content');
  let desiredOpen = details.open;
  let heightAnimation = null, contentAnimation = null;
  summary.addEventListener('click', event => {
    event.preventDefault();
    desiredOpen = !desiredOpen;
    const from = details.getBoundingClientRect().height;
    const opacity = details.open ? Number(getComputedStyle(content).opacity) : 0;
    heightAnimation?.cancel(); contentAnimation?.cancel();
    if (reducedMotion() || !details.animate) { details.open = desiredOpen; return; }
    details.open = desiredOpen;
    const to = details.getBoundingClientRect().height;
    // Keep the content visible while the closing animation plays.
    details.open = true;
    const animation = details.animate([{ height: `${from}px`, overflow: 'hidden' }, { height: `${to}px`, overflow: 'hidden' }], { duration: 280, easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' });
    heightAnimation = animation;
    contentAnimation = content.animate([
      { opacity, transform: desiredOpen ? 'translateY(-6px)' : 'translateY(0)' },
      { opacity: desiredOpen ? 1 : 0, transform: desiredOpen ? 'translateY(0)' : 'translateY(-6px)' }
    ], { duration: 240, easing: 'ease-out', fill: 'both' });
    animation.finished.then(() => {
      if (heightAnimation !== animation) return;
      details.open = desiredOpen;
      animation.cancel(); contentAnimation.cancel();
      heightAnimation = contentAnimation = null;
    }).catch(() => {});
  });
}

function transitionScreen(change) {
  const revision = ++screenRevision;
  screenTransition?.skipTransition?.();
  screenTransition?.cancel?.();
  const commit = () => { if (revision === screenRevision) change(); };
  if (reducedMotion()) { commit(); return; }
  if (document.startViewTransition) {
    screenTransition = document.startViewTransition(commit);
    screenTransition.ready.catch(() => {});
    screenTransition.finished.catch(() => {});
  } else if (page.animate) {
    const exit = page.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(-10px)' }], { duration: 120, easing: 'ease-in', fill: 'both' });
    screenTransition = exit;
    exit.finished.then(() => {
      if (revision !== screenRevision) return;
      commit(); exit.cancel();
      screenTransition = page.animate([{ opacity: 0, transform: 'translateX(10px)' }, { opacity: 1, transform: 'translateX(0)' }], { duration: 240, easing: 'ease-out' });
    }).catch(() => {});
  } else commit();
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function localDate(value, options = {}) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Date unknown';
  return new Intl.DateTimeFormat('en-US', options).format(new Date(value));
}
const editionTime = value => localDate(value, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const topicCount = issue => issue.stories.length;

function scoreHeading(story, id, tag = 'h2') {
  const heading = element(tag, story.title);
  if (story.continuity !== 'new') {
    const label = element('span', story.continuity === 'update' ? 'Update' : 'Ongoing', 'continuity');
    label.title = `Continues the ${editionTime(story.previousEditionAt)} edition`;
    heading.append(label);
  }
  if (!story.scores) return { heading, explanation: null };
  const button = element('button', undefined, 'score-toggle');
  button.type = 'button';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', id);
  const labels = { general: 'Owl', heat: 'Heat', time: 'Time', ethos: 'Ethos' };
  button.setAttribute('aria-label', `${Object.entries(labels).map(([key, label]) => `${label} ${story.scores[key]}`).join(', ')}. Explain scores.`);
  const explanation = element('div', undefined, 'score-explanation');
  explanation.id = id; explanation.hidden = true;
  for (const [key, label] of Object.entries(labels)) {
    const text = key === 'general' ? story.scoreNotes?.general || 'Owl’s overall impression, informed by attention, recency, and source quality.' : story.scoreNotes?.[key] || 'No explanation was saved.';
    const number = element('span', String(story.scores[key]), `score-${key}`);
    number.title = `${label}: ${text}`;
    button.append(number);
    const line = element('p');
    line.append(element('span', `${label} ${story.scores[key]}`, `score-${key}`), document.createTextNode(` · ${text}`));
    explanation.append(line);
  }
  button.addEventListener('click', () => {
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(expanded));
    animateRegion(explanation, expanded);
  });
  heading.append(button);
  return { heading, explanation };
}

function citationDetails(citations) {
  if (!citations.length) return null;
  const sites = [...new Set(citations.map(citation => citation.site))];
  const details = element('details', undefined, 'citations');
  const summary = element('summary', `Sources · ${sites.join(', ')}`);
  const list = element('ol');
  for (const citation of citations) {
    const date = citation.publishedAt ? localDate(citation.publishedAt, { month: 'short', day: 'numeric', year: 'numeric' }) : citation.dateLabel || 'Publication date unknown';
    list.append(element('li', `${citation.title} — ${citation.site}, ${date}. ${sourceClassNames[citation.sourceClass] ?? 'Public source'}.`));
  }
  const content = element('div', undefined, 'disclosure-content');
  content.append(list);
  details.append(summary, content);
  animateDisclosure(details);
  return details;
}
function storyArticle(story, id, nearby = false) {
  const article = element('article', undefined, nearby ? 'close-by-story' : undefined);
  const { heading, explanation } = scoreHeading(story, id, nearby ? 'h3' : 'h2');
  article.append(heading);
  if (nearby) article.append(element('p', `First covered today · ${editionTime(story.firstCoveredAt)}`, 'close-by-date'));
  if (explanation) article.append(explanation);
  const paragraphs = element('ul', undefined, 'story-paragraphs');
  for (const paragraph of story.paragraphs) paragraphs.append(element('li', paragraph));
  article.append(paragraphs);
  const citations = citationDetails(story.citations ?? []);
  if (citations) article.append(citations);
  return article;
}
function nearMissArticle(nearMiss, index) {
  const article = element('article', undefined, 'near-miss-story');
  const { heading, explanation } = scoreHeading(nearMiss, `near-miss-${index}-scores`, 'h3');
  article.append(heading);
  if (explanation) article.append(explanation);
  if (nearMiss.paragraphs?.length) {
    const paragraphs = element('ul', undefined, 'story-paragraphs');
    for (const paragraph of nearMiss.paragraphs) paragraphs.append(element('li', paragraph));
    article.append(paragraphs);
    const citations = citationDetails(nearMiss.citations ?? []);
    if (citations) article.append(citations);
  }
  article.append(element('p', `Not included: ${nearMiss.reason}`, 'near-miss-reason'));
  return article;
}
function renderNearMisses(issue) {
  const nearMisses = issue.nearMisses ?? [];
  nearMissRegion.replaceChildren();
  if (!nearMisses.length) { nearMissRegion.hidden = true; return; }
  const heading = element('h2', 'Crumbs');
  heading.id = 'crumbs-heading';
  nearMissRegion.append(heading, element('p', 'The strongest sourced candidates rejected from the latest main edition. Their scores and exclusion reasons show what Owl considered and why it did not make the cut.', 'near-misses-intro'));
  nearMisses.forEach((nearMiss, index) => nearMissRegion.append(nearMissArticle(nearMiss, index)));
  nearMissRegion.hidden = false;
}
function render(issue) {
  updateDateline(issue);
  const key = JSON.stringify([issue, viewing]);
  if (displayed === key) return;
  displayed = key;
  const total = topicCount(issue);
  const rejectedCount = issue.nearMisses?.length ?? 0;
  const retainedPass = (issue.lastAttempt?.storyCount ?? issue.lastAttempt?.sourceCount) === 0 && issue.lastAttempt.checkedAt !== issue.generatedAt;
  status.classList.toggle('attention', total === 0 || retainedPass);
  status.textContent = viewing ? `Saved edition · ${editionTime(issue.generatedAt)} · ${total} ${total === 1 ? 'story' : 'stories'}`
    : total === 0 ? `No main stories were selected${rejectedCount ? `; ${rejectedCount} rejected ${rejectedCount === 1 ? 'candidate is' : 'candidates are'} shown below` : ', and no rejected candidates had enough evidence to show'}.`
    : retainedPass ? `The latest pass selected no main stories. Showing your last saved digest${rejectedCount ? ` with ${rejectedCount} rejected ${rejectedCount === 1 ? 'candidate' : 'candidates'} below` : ''}.`
    : `${issue.readingMinutes} min read · ${total} ${total === 1 ? 'story' : 'stories'}`;
  main.replaceChildren();
  document.querySelector('.end').textContent = total === 0 ? 'Research pass complete.' : 'That’s your edition.';
  const method = document.querySelector('#method-copy');
  method.replaceChildren();
  const selection = issue.storySelection ?? { targetMin: 7, maxStories: 15 };
  method.append(element('p', `Market research for popular commentary videos and popular video games: normally ${selection.targetMin}–${selection.maxStories} substantive, high-engagement or outlier stories, in short, easily understood bullets with background, audience reactions, and why they matter. Every topic gets a focused discovery search, without forcing a story from every topic. No reading-time ceiling, video angles, or game ideas.`));
  method.append(element('p', 'The unordered watchlist starts discovery cheaply; other permitted sources remain in scope. No paid APIs, or API calls to Reddit, X, or YouTube. Reactions describe sampled audiences, not everyone. Uncertain claims are attributed and reflected in the scores.'));
  method.append(element('p', 'A 24-hour news focus, plus a seven-day fallback for sufficiently hot, supported stories that are new to Owl and a 14-day lookback for notable events happening within about 30 days. Lower Time alone does not disqualify a fallback story. The Owl day starts at 9 AM fixed PST (UTC−8). Previously covered main stories return only for a meaningful new development or clearly sustained major discussion. Close by shows other stories saved earlier in the current Owl day without counting toward the edition target. Expand sources below each story. Click scores for their reasoning; scores are editorial estimates from 0 to 100. Text only, no outbound links.'));
  method.append(element('p', 'Crumbs are up to five of the strongest documentable candidates rejected from the main edition. They may have low Heat, be stale or routine, duplicate a recent story, lack corroboration, or lose out to stronger material. Each keeps bullets, Owl scores, citations, and the specific rejection reason. Search noise and claims without enough visible evidence are omitted. Crumbs do not count toward the main-story target.'));
  const budget = issue.researchBudget;
  if (budget) method.append(element('p', `Research budget: ${budget.maxQueriesTotal} searches, ${budget.maxPageOpensTotal} page opens, ${budget.maxCandidatesTotal} candidate sources, roughly ${budget.maxResearchMinutes} minutes. Reading time is an estimate, not a limit.`));
  const watchlist = document.querySelector('#watchlist-items');
  watchlist.replaceChildren();
  for (const site of issue.sourceMap?.watchlist ?? []) watchlist.append(element('li', `${site.name} — ${site.note}`));
  const topics = document.querySelector('#topic-items');
  topics.replaceChildren();
  for (const topic of issue.sourceMap?.topics ?? []) topics.append(element('li', topic));
  const legend = document.querySelector('#score-legend');
  legend.replaceChildren();
  const legendItems = element('p', undefined, 'score-key');
  for (const [name, className, description] of [
    ['Owl', 'score-general', 'overall editorial impression'],
    ['Heat', 'score-heat', 'attention and consequence'],
    ['Time', 'score-time', 'recency of the latest development'],
    ['Ethos', 'score-ethos', 'evidence quality and reliability']
  ]) {
    const item = element('span', undefined, 'legend-item');
    item.append(element('span', name, className), document.createTextNode(` — ${description}`));
    legendItems.append(item);
  }
  legend.append(legendItems);
  if (issue.lastAttempt?.checkedAt && issue.lastAttempt.checkedAt !== issue.generatedAt) method.append(element('p', `Last research pass: ${localDate(issue.lastAttempt.checkedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}.`));
  if (issue.note) main.append(element('p', issue.note, 'edition-note'));
  issue.stories.forEach((story, index) => main.append(storyArticle(story, `story-${index}-scores`)));
  if (!viewing && issue.closeBy?.length) {
    const section = element('section', undefined, 'close-by');
    section.setAttribute('aria-labelledby', 'close-by-heading');
    const heading = element('h2', 'Close by');
    heading.id = 'close-by-heading';
    section.append(heading, element('p', `${issue.closeBy.length} ${issue.closeBy.length === 1 ? 'story' : 'stories'} from earlier editions today, since 9 AM fixed PST.`, 'close-by-intro'));
    issue.closeBy.forEach((story, index) => section.append(storyArticle(story, `close-by-${index}-scores`, true)));
    main.append(section);
  }
  renderNearMisses(issue);
}
function updateDateline(issue) {
  const updated = document.querySelector('#last-updated');
  const duration = document.querySelector('#update-duration');
  if (issue.generatedAt) {
    updated.dateTime = issue.generatedAt;
    updated.textContent = localDate(issue.generatedAt, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    const seconds = issue.updateDurationSeconds;
    duration.textContent = Number.isInteger(seconds)
      ? ` in ${Math.floor(seconds / 60) ? `${Math.floor(seconds / 60)} min ` : ''}${seconds % 60} sec`
      : '';
  } else {
    updated.removeAttribute('datetime');
    updated.textContent = 'not yet';
    duration.textContent = '';
  }
}
function renderHistory() {
  // Keep the buttons stable when a background refresh returns the same list.
  const key = JSON.stringify([savedEditions, latestIssue?.generatedAt]);
  if (displayedHistory === key) return;
  displayedHistory = key;
  const recentList = document.querySelector('#edition-list-24h');
  const weekList = document.querySelector('#edition-list-7d');
  recentList.replaceChildren(); weekList.replaceChildren();
  const now = Date.now(), dayAgo = now - 24 * 60 * 60 * 1000;
  const recent = savedEditions.filter(edition => Date.parse(edition.generatedAt) >= dayAgo);
  const older = savedEditions.filter(edition => Date.parse(edition.generatedAt) < dayAgo);
  const addEditions = (list, editions, emptyText) => {
    if (!editions.length) list.append(element('p', emptyText, 'menu-empty'));
    for (const edition of editions) {
      const count = topicCount(edition);
      const button = element('button', `${editionTime(edition.generatedAt)} · ${count ? `${count} ${count === 1 ? 'story' : 'stories'}` : 'Research pass'}`, 'history-button');
      button.type = 'button';
      button.addEventListener('click', () => openEdition(edition));
      list.append(button);
    }
  };
  addEditions(recentList, recent, 'No editions in the past 24 hours.');
  addEditions(weekList, older, 'No earlier editions in the past 7 days.');
  if (!savedEditions.length && latestIssue?.generatedAt) {
    const button = element('button', 'View last saved edition · older than 7 days', 'history-button');
    button.type = 'button'; button.addEventListener('click', () => openEdition(latestIssue)); weekList.append(button);
  }
}
function showScreen(value, afterChange = () => {}) {
  const previous = screen;
  screen = value;
  const change = () => {
    const reading = value === 'reader', updating = value === 'updating';
    page.classList.toggle('title-page', !reading);
    document.querySelector('#dateline').hidden = updating;
    actions.hidden = reading || updating;
    notice.hidden = updating;
    if (!reading) {
      menu.hidden = true;
      otherEditionsButton.setAttribute('aria-expanded', 'false');
    }
    progress.hidden = !updating;
    main.hidden = status.hidden = document.querySelector('footer').hidden = !reading;
    document.querySelector('.skip').hidden = !reading;
    if (!reading && latestIssue) updateDateline(latestIssue);
    afterChange();
  };
  if (!screenReady || previous === value) {
    ++screenRevision;
    screenTransition?.skipTransition?.(); screenTransition?.cancel?.();
    change();
  }
  else transitionScreen(change);
}
function openEdition(issue) {
  viewing = issue.generatedAt === latestIssue?.generatedAt ? null : issue.generatedAt;
  const selected = viewing ? issue : latestIssue ?? issue;
  menu.hidden = true;
  otherEditionsButton.setAttribute('aria-expanded', 'false');
  showScreen('reader', () => {
    updateDateline(selected); render(selected); window.scrollTo(0, 0); main.focus({ preventScroll: true });
  });
}
async function refresh() {
  try {
    const [response, history] = await Promise.all([
      fetch(staticSite ? 'api/issue.json' : '/api/issue', { cache: 'no-store' }),
      fetch(staticSite ? 'api/history.json' : '/api/history', { cache: 'no-store' })
    ]);
    if (!response.ok || !history.ok) throw new Error('unavailable');
    latestIssue = await response.json();
    savedEditions = (await history.json()).editions;
    const saved = savedEditions.find(edition => edition.generatedAt === viewing);
    if (!saved) viewing = null;
    if (screen === 'reader') { updateDateline(saved || latestIssue); render(saved || latestIssue); }
    else updateDateline(latestIssue);
    renderHistory();
    return true;
  } catch {
    notice.textContent = 'The saved editions could not be loaded. Try opening Owl again.';
    return false;
  }
}
function rememberJob(id) {
  activeJob = id;
  try { if (id) sessionStorage.setItem('owl-update', id); else sessionStorage.removeItem('owl-update'); } catch {}
}
function updateProgress(job) {
  const seconds = job.estimatedRemainingSeconds;
  const taskLabels = {
    starting: 'Preparing recent-story context',
    research: 'Searching for and checking current stories',
    writing: 'Writing summaries, scores, and citations',
    publishing: 'Validating and publishing the edition',
    checking: 'Verifying the saved edition'
  };
  document.querySelector('#update-task').textContent = job.currentTask || taskLabels[job.phase] || taskLabels.starting;
  document.querySelector('#update-eta').textContent = seconds == null
    ? 'Taking longer than estimated…'
    : `About ${Math.max(1, Math.ceil(seconds / 60))} min remaining`;
  document.querySelector('#progress-bar').value = job.progress ?? 0;
}
async function applyJob(job) {
  if (job.status === 'running') {
    rememberJob(job.id); showScreen('updating', () => updateProgress(job));
  } else if (activeJob && job.id === activeJob) {
    if (job.status === 'complete') {
      document.querySelector('#progress-bar').value = 100;
      if (!(await refresh())) {
        document.querySelector('#update-eta').textContent = 'Update complete · opening your edition…'; return;
      }
      rememberJob(null);
      notice.textContent = job.retainedPrevious ? 'No new observations were available. Showing your last saved edition.' : '';
      const edition = savedEditions.find(item => item.generatedAt === job.editionAt) || latestIssue;
      if (edition?.generatedAt) openEdition(edition);
      else { showScreen('home'); notice.textContent = 'The update finished without a readable edition.'; }
    } else if (job.status === 'failed') {
      rememberJob(null); showScreen('home');
      notice.textContent = job.error || 'The update could not finish. Please try again.';
      updateButton.focus();
    }
  }
}
async function pollUpdate() {
  if (polling) return;
  polling = true;
  try {
    const response = await fetch('/api/update', { cache: 'no-store' });
    if (!response.ok) throw new Error('unavailable');
    await applyJob(await response.json());
  } catch {
    if (screen === 'updating') document.querySelector('#update-eta').textContent = 'Reconnecting… Your update continues in the background.';
  } finally { polling = false; }
}
updateButton.addEventListener('click', async () => {
  if (screen === 'updating') return;
  notice.textContent = '';
  showScreen('updating', () => {
    document.querySelector('#update-task').textContent = 'Starting Owl’s research';
    document.querySelector('#update-eta').textContent = 'Starting update…';
    document.querySelector('#progress-bar').value = 0;
  });
  try {
    const response = await fetch('/api/update', { method: 'POST', headers: { 'X-Owl-Update': '1' } });
    const job = await response.json();
    rememberJob(job.id); await applyJob(job);
    if (!['running', 'complete', 'failed'].includes(job.status)) throw new Error('unavailable');
  } catch {
    // A lost response does not mean the server failed to launch the job.
    await pollUpdate();
    if (!activeJob) { showScreen('home'); notice.textContent = 'The update could not be started. Try opening Owl again.'; }
  }
});
readButton.addEventListener('click', async () => {
  notice.textContent = '';
  if (!latestIssue?.generatedAt) await refresh();
  if (latestIssue?.generatedAt) openEdition(latestIssue);
  else notice.textContent = 'No saved edition to read yet. Update Owl first.';
});
homeButton.addEventListener('click', () => {
  viewing = null;
  showScreen('home', () => { window.scrollTo(0, 0); readButton.focus(); });
});
otherEditionsButton.addEventListener('click', async () => {
  await refresh();
  const expanded = menu.hidden;
  otherEditionsButton.setAttribute('aria-expanded', String(expanded));
  animateRegion(menu, expanded);
});
animateDisclosure(document.querySelector('#method'));
animateDisclosure(document.querySelector('#source-watchlist'));
animateDisclosure(document.querySelector('#topics'));
showScreen('home');
screenReady = true;
Promise.all([refresh(), ...(staticSite ? [] : [pollUpdate()])]);
if (!staticSite) setInterval(pollUpdate, 2500);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); if (!staticSite) pollUpdate(); } });
