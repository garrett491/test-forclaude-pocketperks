/**
 * Serves the PRODUCTION build the way Netlify does: static files from dist/
 * first, everything else through the compiled SSR function, with the
 * headers from netlify.toml applied — including the Content Security
 * Policy, so the end-to-end suite catches anything the policy would block.
 *
 * Test tooling only. Run `npm run build` first.
 *
 *   node --env-file=.env tests/support/serve-build.mjs
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const PORT = Number(process.env.WEB_PORT || 4321);
const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');

const { default: handler } = await import(join(ROOT, '.netlify/v1/functions/ssr/ssr.mjs'));

/** The [[headers]] blocks of netlify.toml. A small parser for the one shape used. */
function readHeaderRules() {
  const text = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
  const rules = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '[[headers]]') { current = { for: '', values: {} }; rules.push(current); continue; }
    if (!current || line.startsWith('#') || !line.includes('=')) continue;
    const key = line.slice(0, line.indexOf('=')).trim();
    const value = line.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '');
    if (key === 'for') current.for = value;
    else if (!line.startsWith('[')) current.values[key] = value;
  }
  return rules;
}
const rules = readHeaderRules();
// The one test-only change: the local Supabase stand-in is on http://127.0.0.1,
// so it is added alongside *.supabase.co. Everything else is the real policy.
for (const rule of rules) {
  const csp = rule.values['Content-Security-Policy'];
  if (csp) rule.values['Content-Security-Policy'] = csp.replaceAll('https://*.supabase.co', 'https://*.supabase.co http://127.0.0.1:54321');
}

function headersFor(pathname) {
  const out = {};
  for (const rule of rules) {
    const pattern = new RegExp('^' + rule.for.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    if (pattern.test(pathname)) Object.assign(out, rule.values);
  }
  return out;
}

const TYPES = {
  '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.txt': 'text/plain', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.json': 'application/json', '.xml': 'application/xml',
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const extra = headersFor(url.pathname);

  const file = join(DIST, decodeURIComponent(url.pathname));
  if (file.startsWith(DIST) && existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', ...extra });
    return res.end(readFileSync(file));
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(url, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])),
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });

  try {
    const response = await handler(request, { ip: '127.0.0.1', geo: {}, cookies: undefined });
    const headers = {};
    response.headers.forEach((value, key) => {
      if (key === 'set-cookie') return;
      headers[key] = value;
    });
    const cookies = response.headers.getSetCookie?.() ?? [];
    res.writeHead(response.status, { ...extra, ...headers, ...(cookies.length ? { 'set-cookie': cookies } : {}) });
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  } catch (error) {
    console.error('[serve-build] handler threw', error);
    res.writeHead(500);
    res.end('handler error');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[serve-build] http://127.0.0.1:${PORT}`));
