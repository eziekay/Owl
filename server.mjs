import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { config, blankIssue, publicNearMisses, toPublicIssue } from './scripts/lib.mjs';
import { closeByStories, loadHistory } from './scripts/history.mjs';
import { createUpdater } from './scripts/updater.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const updater = createUpdater();
const ipv4Number = address => address.split('.').reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
const localNetworks = () => Object.values(networkInterfaces()).flat().filter(address =>
  address?.family === 'IPv4' && !address.internal);
function allowedClient(req) {
  const host = req.headers.host ?? '';
  const remote = req.socket.remoteAddress?.replace(/^::ffff:/u, '') ?? '';
  if ([`127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(host)) return remote === '127.0.0.1' || remote === '::1';
  const network = localNetworks().find(address => host === `${address.address}:${config.port}`);
  if (!network || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(remote)) return false;
  const mask = ipv4Number(network.netmask);
  return (ipv4Number(remote) & mask) === (ipv4Number(network.address) & mask);
}
const routes = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['public/style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']]
]);
const server = http.createServer(async (req, res) => {
  const security = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  };
  try {
    if (!allowedClient(req)) {
      res.writeHead(403, security); res.end('Local network access only.'); return;
    }
    const host = req.headers.host;
    const path = new URL(req.url, `http://127.0.0.1:${config.port}`).pathname;
    if (path === '/api/update' && req.method === 'POST') {
      // A page on another website cannot trigger work on this computer.
      if (req.headers.origin !== `http://${host}` || req.headers['x-owl-update'] !== '1'
        || req.headers['sec-fetch-site'] === 'cross-site') {
        res.writeHead(403, security); res.end('Open Owl to request an update.'); return;
      }
      const state = await updater.start();
      res.writeHead(state.status === 'failed' ? 503 : 202, { ...security, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(state)); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { ...security, Allow: path === '/api/update' ? 'GET, HEAD, POST' : 'GET, HEAD' }); res.end(); return;
    }
    let content, type;
    if (path === '/api/issue') {
      let issue;
      try { issue = JSON.parse(await readFile(join(root, 'data/latest.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; issue = blankIssue(); }
      const safe = toPublicIssue(issue);
      safe.closeBy = closeByStories(issue, await loadHistory());
      try {
        const attempt = JSON.parse(await readFile(join(root, 'data/last-attempt.json'), 'utf8'));
        safe.lastAttempt = {
          date: attempt.date, checkedAt: attempt.checkedAt, sourceCount: attempt.sourceCount ?? attempt.postCount,
          storyCount: attempt.storyCount,
          nearMisses: publicNearMisses(attempt.nearMisses)
        };
        if (Array.isArray(attempt.nearMisses)) safe.nearMisses = publicNearMisses(attempt.nearMisses);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      content = JSON.stringify(safe); type = 'application/json; charset=utf-8';
    } else if (path === '/api/update') {
      content = JSON.stringify(await updater.status()); type = 'application/json; charset=utf-8';
    } else if (path === '/api/history') {
      content = JSON.stringify({ hours: config.historyHours, editions: (await loadHistory()).map(toPublicIssue) });
      type = 'application/json; charset=utf-8';
    } else if (path === '/api/health') {
      content = JSON.stringify({ service: 'owl-newsletter', status: 'ok' }); type = 'application/json';
    } else if (routes.has(path)) {
      const route = routes.get(path); content = await readFile(join(root, route[0])); type = route[1];
    } else {
      res.writeHead(404, security); res.end('Not found.'); return;
    }
    res.writeHead(200, { ...security, 'Content-Type': type });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    console.error('Owl request failed:', error.message);
    res.writeHead(503, { ...security, 'Content-Type': 'text/plain' });
    res.end('Owl is temporarily unavailable. Your saved edition is still on disk.');
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? 'Owl port 4173 is already in use. Check the existing Owl server or change newsletter.config.json.' : error.message);
  process.exitCode = 1;
});
server.listen(config.port, '0.0.0.0', () => console.log(`Owl is reading at http://127.0.0.1:${config.port} and on this PC's local network`));
