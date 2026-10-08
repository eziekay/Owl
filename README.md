# Owl

**Public reader:** https://eziekay.github.io/Owl/ (published from this repository's `site/` folder)

The public website is a read-only snapshot of the latest edition and recent history. It has no access to your computer or Codex sign-in. Every successful local publication now exports `site/`, commits only that generated snapshot, and pushes `main`; the existing GitHub Pages workflow deploys the commit. Run `node scripts/sync-site.mjs` to retry the site sync without repeating research or republishing the local edition. Anyone can read the public site; someone who wants their own Owl can clone this repository, install Node.js 22 or newer and the Codex CLI, sign in to Codex, and run `npm start`. The local update feature requires that person's own Codex sign-in and the automatic public-site sync requires Git push access to the configured `origin`.

The code is available under the MIT license. News summaries and citations in the exported snapshot remain attributed to their listed sources.

Owl is a local, minimalist, dark-mode news briefing. It follows four editable interests—content creators, content creation platforms, AAA gaming, and indie gaming—to support market research for popular commentary videos and popular video games. An edition aims for 7–15 worthwhile stories across any mix of topics, using short bullets, Owl scores, and expandable citations. The site contains no images, videos, or outbound links.

Double-click **Enable Owl LAN.cmd** once and accept the Windows administrator prompt to allow devices on the local subnet through Windows Firewall. Then double-click **Open Owl.cmd** to start Owl at http://127.0.0.1:4173 on this PC. The launcher also prints a Wi-Fi address to open in a browser on a phone, tablet, or another PC connected to the same network. Owl must be running on this PC, and the network must allow devices to communicate with each other. There is no schedule; updates begin when you press **update** on the site or ask Codex to **“Update Owl.”** The title screen shows the last edition’s timestamp and actual update duration. **read** opens the latest edition; **Other editions** expands separate past-24-hour and past-7-day lists beneath the current edition.

The Update button runs the installed Codex CLI with its saved ChatGPT sign-in. It uses **GPT-6 Luna, High** from `newsletter.config.json`; no separate API key is needed. A manual chat update uses the chat’s selected model and effort, so choose Luna High there if you want the same settings. The progress screen names the current task—such as searching, drafting, or publishing—alongside the estimated time remaining. It reconnects to an update after a tab closes and preserves the last readable edition if a pass has no usable stories. Avoid starting a second update while one is running.

## Update method

`UPDATE_NEWSLETTER.md` is the active agent guide. The previous full guide and config are saved in `docs/history/`. The current instructions keep the topic list and goals explicit and editable in `newsletter.config.json`.

Each update prepares a compact seven-day history plus reusable saved Crumbs, searches each topic once, and runs one batched horizon scan for notable events occurring within about 30 days that were announced or drew attention within 14 days. Fresh stories come first. When fewer than seven qualify, Owl can fill remaining slots with sufficiently hot, supported, new-to-Owl stories from the preceding seven days; low Time alone is acceptable, but low Heat is not. It spends remaining follow-ups on that fallback and the strongest adjacent leads. The current ceilings are six searches, eight page opens, 30 candidate sources, and about five minutes of research; these are ceilings, not quotas. The source watchlist is an unordered, cheap starting point rather than an exclusive or weighted list. Owl can use other permitted public sources, but uses no paid API and no Reddit, X, or YouTube API. Access restrictions are respected.

Past stories are context, not an automatic story pool. A return needs a meaningful new development or clearly sustained major discussion; unchanged stories should not recur merely because they are in the seven-day archive. Owl’s editorial day begins at 9 AM fixed PST (UTC−8) year-round. A story older than seven days needs a substantial new development.

The latest edition also shows **Close by**: distinct stories from earlier editions in the current Owl day that are absent from the latest edition. It reuses their saved text, scores, and citations, shows when each first appeared that day, and does not count toward the 7–15 story target. The section clears at the next 9 AM fixed PST boundary.

The reader can also show up to five **Crumbs** from the latest research pass. These are the strongest documentable candidates rejected from the main edition, including candidates rejected for low Heat, staleness, duplication, routine significance, weak corroboration, or competition from stronger material. Search-result noise and claims without enough visible evidence are omitted. Crumbs retain bullets, scores, citations, and a specific exclusion reason. They do not count toward the main-story target.

The agent writes one finished `data/draft.json`; the publisher validates its scores, citations, and continuity, adds timestamps and duration, and updates the local archive. It does not use a separate candidate-selection write or a second editorial rewrite. No reading-time ceiling applies.

Scores beside each headline are editorial estimates from 0–100: gray Owl is the rounded average of red Heat (attention and consequence), yellow Time (recency), and blue Ethos (evidence quality). Click them for the reasoning. Lower Time can be acceptable for a strong new-to-Owl fallback story; low Heat is not used as filler. Uncertain material should be attributed clearly and reflected in Ethos. Source names appear beneath entries; expandable bibliographies show more metadata. URLs are stored privately for citation validation but never linked from the reading page.

## Maintenance

Edit `newsletter.config.json` to change the model, reasoning effort, budgets, watchlist, topics, goals, or 7–15 story target. Restart the local server after changing config or server code. Existing editions remain readable. Retained archive and research-report records older than 168 hours are pruned after publication; the latest readable edition remains available.

From this directory:

    node server.mjs
    node scripts/collect.mjs
    node scripts/publish.mjs
    node --test tests/*.test.mjs

Only run collection and publication as part of a requested update. The scripts do not research the web or call an AI API on their own.
