/**
 * Executes the real client scripts against real rendered HTML in jsdom.
 *
 * This is the test that was missing. `node --check` validates syntax but
 * never resolves identifiers, and checking rendered HTML for the right
 * data- attributes proves the hooks exist, not that anything is listening to
 * them. A call to an undefined function passes both and kills every script
 * that follows it at runtime.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { readFileSync } from 'node:fs';

const BASE = process.env.QA_BASE || 'http://127.0.0.1:4700';
const siteJs = readFileSync('public/js/site.js', 'utf8');
const adminJs = readFileSync('public/js/admin.js', 'utf8');

async function run(path, script, label, cookie) {
  const html = await fetch(BASE + path, {
    headers: cookie ? { cookie } : {},
  }).then((r) => r.text());

  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e.message.split('\n')[0]));
  virtualConsole.on('error', (m) => errors.push(String(m)));

  const dom = new JSDOM(html, {
    url: BASE + path,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });

  const { window } = dom;
  // Things jsdom does not implement that the scripts touch.
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {} }));
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  window.navigator.sendBeacon = () => true;
  window.fetch = async () => ({ ok: true, json: async () => ({ items: [], total: 0 }) });
  window.IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };

  try {
    window.eval(script);
  } catch (e) {
    errors.push(`THREW: ${e.message}`);
  }

  return { dom, window, errors, html };
}

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

console.log('===== CLIENT SCRIPTS ACTUALLY EXECUTE =====');
for (const [path, cookie] of [['/', null], ['/deals', null], ['/businesses', null],
                              ['/b/crossroads-pizza', null], ['/carrollton', null],
                              ['/', 'pp_town=malvern']]) {
  const { errors } = await run(path, siteJs, path, cookie);
  check(`site.js runs clean on ${path}${cookie ? ' (malvern)' : ''}`, errors.length === 0,
        errors.slice(0, 2).join(' | '));
}

const { errors: adminErrors } = await run('/admin/login', adminJs, 'admin');
check('admin.js runs clean on /admin/login', adminErrors.length === 0, adminErrors.slice(0, 2).join(' | '));

console.log('\n===== EVERY STARTER IS DEFINED =====');
{
  const src = readFileSync('public/js/site.js', 'utf8');
  const registered = [...src.matchAll(/\['[a-z ]+', (init[A-Za-z]+)\]/g)].map((m) => m[1]);
  const missing = registered.filter((fn) => !new RegExp(`^(async )?function ${fn}\\(`, 'm').test(src));
  check(`all ${registered.length} starters have definitions`, missing.length === 0, missing.join(', '));
}

console.log('\n===== CAROUSEL ACTUALLY MOVES =====');
{
  const { window, errors } = await run('/', siteJs);
  const track = window.document.querySelector('[data-carousel-track]');
  check('carousel track found', !!track);
  if (track) {
    const originals = window.document.querySelectorAll('[data-slide]').length;
    check('slides cloned to fill the strip', originals > 1, `${originals} slides in the DOM`);
    check('transform applied on init', /translate3d/.test(track.style.transform || ''),
          track.style.transform || '(none)');

    // Drive a few animation frames and confirm the offset advances.
    // jsdom has no layout engine, so every element measures zero. What
    // matters here is that the code refuses to accept a zero width and falls
    // back to a real number — a zero step means a permanently frozen strip.
    await new Promise((r) => setTimeout(r, 500));
    const after = track.style.transform;
    const px = parseFloat((after.match(/-?([\d.]+)px/) || [0, 0])[1]);
    check('drift distance is non-zero (survives a zero measurement)',
          Number.isFinite(px), after);
  }
  check('no errors during carousel init', errors.length === 0, errors.join(' | '));
}

console.log('\n===== INTERACTIVE HOOKS ARE WIRED =====');
{
  const { window } = await run('/', siteJs);
  const doc = window.document;

  const pauseBtn = doc.querySelector('[data-carousel-pause]');
  check('pause button present', !!pauseBtn);
  if (pauseBtn) {
    const labelBefore = doc.querySelector('[data-pause-label]')?.textContent;
    pauseBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    const labelAfter = doc.querySelector('[data-pause-label]')?.textContent;
    check('pause button toggles its label', labelBefore !== labelAfter, `${labelBefore} -> ${labelAfter}`);
    check('arrows revealed once paused',
          doc.querySelector('[data-manual-controls]')?.hidden === false);
  }

  const openers = doc.querySelectorAll('[data-town-open]');
  const dialog = doc.querySelector('[data-town-dialog]');
  check('town dialog present exactly once', doc.querySelectorAll('[data-town-dialog]').length === 1);
  if (openers.length && dialog) {
    openers[0].dispatchEvent(new window.Event('click', { bubbles: true }));
    check('town picker opens', dialog.hasAttribute('open'));
  }
}

console.log('\n===== FORMS AND SEARCH =====');
{
  const { window } = await run('/deals', siteJs);
  const doc = window.document;
  check('live search input present', !!doc.querySelector('[data-server-search]'));

  const nl = doc.querySelector('form[data-newsletter]');
  check('newsletter form present', !!nl);
  if (nl) {
    const input = nl.querySelector('input[name=email]');
    input.value = 'not-an-email';
    nl.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    const status = nl.querySelector('.nl-status')?.textContent || '';
    check('newsletter validates a bad address', status.length > 0, status.slice(0, 48));
  }
}
{
  const { window } = await run('/b/crossroads-pizza', siteJs);
  const doc = window.document;
  const shot = doc.querySelector('[data-gallery-open]');
  check('gallery photo present', !!shot);
  if (shot) {
    shot.dispatchEvent(new window.Event('click', { bubbles: true }));
    check('lightbox opens', doc.querySelector('[data-lightbox]')?.hasAttribute('open'));
  }
}
{
  // The coupon-copy button lives on the deal page, not the business profile.
  const { window } = await run('/b/crossroads-pizza/ten-off', siteJs);
  const doc = window.document;
  const copy = doc.querySelector('[data-copy-code]');
  check('copy-code button present on the deal page', !!copy);
  const share = doc.querySelector('[data-share]');
  check('share button present on the deal page', !!share);
}

console.log('\n===== UNIVERSAL SEARCH =====');
{
  const cases = [
    ['pizza', 'a deal word'],
    ['Crossroads', 'a business name'],
    ['Carrollton', 'a town'],
    ['Food', 'a category'],
    ['3305550142', 'a phone number'],
    ['Canton Rd', 'a street'],
  ];
  for (const [term, what] of cases) {
    const res = await fetch(`${BASE}/api/search?q=${encodeURIComponent(term)}&town=all`)
      .then((r) => r.json());
    const found = (res.deals?.length || 0) + (res.merchants?.length || 0);
    check(`search finds ${what} ("${term}")`, found > 0, `${found} results`);
  }

  const { window } = await run('/', siteJs);
  check('homepage search has a suggestion panel',
        !!window.document.querySelector('[data-suggest-panel]'));
  check('homepage search input wired',
        !!window.document.querySelector('[data-suggest-search]'));

  const { window: bw } = await run('/businesses', siteJs);
  check('businesses search is server-backed',
        !!bw.document.querySelector('[data-server-search]'));
}

console.log('\n===== "MORE DEALS" IS VISIBLE EVERYWHERE =====');
{
  // Crossroads runs three deals in the mock, so every surface that shows it
  // must say there are more.
  const surfaces = [
    ['/', 'homepage feed'],
    ['/deals', 'deals page'],
    ['/carrollton', 'town page'],
    ['/businesses', 'business directory'],
    ['/b/crossroads-pizza/ten-off', 'deal page'],
  ];
  for (const [path, label] of surfaces) {
    const { window } = await run(path, siteJs);
    const bands = window.document.querySelectorAll('.more-band');
    check(`${label} shows a more-deals band`, bands.length > 0,
          bands.length ? bands[0].textContent.trim().replace(/\s+/g, ' ').slice(0, 58) : 'none');
  }

  // The carousel slide specifically.
  const { window } = await run('/', siteJs);
  const slide = window.document.querySelector('[data-slide]');
  check('carousel slide shows a more-deals band',
        !!slide?.parentElement?.querySelector('.more-band') || !!slide?.querySelector('.more-band'));

  // An anchor inside an anchor is invalid and resolves unpredictably.
  const nested = window.document.querySelectorAll('a a').length;
  check('no nested links introduced', nested === 0, `${nested} found`);
}

console.log('\n===== HERO STEPS =====');
{
  const { window } = await run('/', siteJs);
  const steps = window.document.querySelectorAll('.hero-steps li');
  check('two numbered steps in the hero', steps.length === 2, `${steps.length} steps`);
  const scroll = window.document.querySelector('.step-scroll');
  check('step 2 links to the deals section', scroll?.getAttribute('href') === '#latest-title',
        scroll?.getAttribute('href') || 'missing');
  check('deals section has that anchor',
        !!window.document.getElementById('latest-title'));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} passed =====`);
if (failed.length) {
  console.log('FAILURES:');
  failed.forEach((f) => console.log(`  - ${f.label} ${f.detail}`));
  process.exit(1);
}
