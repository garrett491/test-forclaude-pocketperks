/**
 * Pocket Perks — public site behaviour.
 *
 * Deliberately one external file rather than per-component inline scripts.
 * Inline scripts force a Content-Security-Policy to either allow
 * 'unsafe-inline' or carry a hash for every one of them; an external file
 * needs neither, and it is cached once across the whole site.
 *
 * Plain JavaScript, no build step. Everything here is progressive: the site
 * works with this file blocked, it just loses the conveniences.
 */

/* ------------------------------------------------------------------ */
/* Event tracking                                                      */
/*                                                                     */
/* Nothing is measured unless it maps to something we could honestly   */
/* describe to a paying merchant. No scroll depth, no hover, no        */
/* time-on-page. The browser never writes to the database: events POST */
/* to /api/track, which filters bots and hashes the session server-side.*/
/* ------------------------------------------------------------------ */

function sendEvent(payload) {
  const body = JSON.stringify({ ...payload, path: location.pathname });
  // sendBeacon survives the page unload that follows an outbound click.
  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
  } else {
    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  }
}

function initPageViews() {
  const profile = document.querySelector('[data-track-merchant-view]');
  if (profile && profile.dataset.merchantId) {
    sendEvent({ event_type: 'merchant_view', merchant_id: profile.dataset.merchantId });
  }

  const dealPage = document.querySelector('[data-track-deal-open]');
  if (dealPage && dealPage.dataset.dealId) {
    sendEvent({
      event_type: 'deal_open',
      merchant_id: dealPage.dataset.merchantId,
      deal_id: dealPage.dataset.dealId,
    });
  }
}

/**
 * Impressions are counted once per deal per page view, and only when the card
 * has been at least half visible for 500ms. A card that scrolled past in a
 * flick was not seen, and counting it would inflate every merchant report.
 */
function initImpressions() {
  if (!('IntersectionObserver' in window)) return;

  const seen = new Set();
  const pending = new Map();

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target;
      const dealId = el.dataset.dealId;
      if (!dealId || seen.has(dealId)) { observer.unobserve(el); continue; }

      if (entry.isIntersecting) {
        pending.set(el, window.setTimeout(() => {
          seen.add(dealId);
          sendEvent({ event_type: 'deal_view', merchant_id: el.dataset.merchantId, deal_id: dealId });
          observer.unobserve(el);
        }, 500));
      } else {
        const timer = pending.get(el);
        if (timer) { clearTimeout(timer); pending.delete(el); }
      }
    }
  }, { threshold: 0.5 });

  document
    .querySelectorAll('[data-track-impression][data-deal-id]')
    .forEach((el) => observer.observe(el));
}

function initIntentClicks() {
  document.addEventListener('click', (event) => {
    const target = event.target.closest && event.target.closest('[data-track]');
    if (!target) return;
    sendEvent({
      event_type: target.dataset.track,
      merchant_id: target.dataset.merchant || null,
      deal_id: target.dataset.deal || null,
    });
  });
}

/* ------------------------------------------------------------------ */
/* Copy code and share                                                 */
/* ------------------------------------------------------------------ */

function initCopyButtons() {
  document.querySelectorAll('[data-copy-code]').forEach((button) => {
    const original = button.textContent;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copyCode);
        button.textContent = 'Copied';
      } catch {
        // Clipboard access can be refused. Say so, rather than claiming
        // success — which is what the old copy button did unconditionally.
        button.textContent = 'Press and hold to copy';
      }
      setTimeout(() => { button.textContent = original; }, 2200);
    });
  });
}

function initShareButtons() {
  document.querySelectorAll('[data-share]').forEach((button) => {
    const status = button.parentElement && button.parentElement.querySelector('.share-status');
    const say = (text) => {
      if (!status) return;
      status.textContent = text;
      setTimeout(() => { status.textContent = ''; }, 3000);
    };
    button.addEventListener('click', async () => {
      // This deal's own page, so the preview shows this offer.
      const url = location.origin + location.pathname;
      const title = button.dataset.title || document.title;
      sendEvent({ event_type: 'share', merchant_id: button.dataset.merchant || null, deal_id: button.dataset.deal || null });
      try {
        if (navigator.share) {
          await navigator.share({ title, url });
        } else if (navigator.clipboard) {
          await navigator.clipboard.writeText(url);
          say('Link copied. Paste it anywhere to share.');
        } else {
          window.prompt('Copy this link to share it:', url);
        }
      } catch (error) {
        // Cancelling the share sheet is not an error; a refused clipboard is.
        if (error && error.name !== 'AbortError') window.prompt('Copy this link to share it:', url);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Newsletter                                                          */
/* ------------------------------------------------------------------ */

const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[a-z]{2,}$/i;

function initNewsletterForms() {
  document.querySelectorAll('form[data-newsletter]').forEach((form) => {
    const status = form.querySelector('.nl-status');
    const button = form.querySelector('button[type=submit]');
    const input = form.querySelector('input[name=email]');
    if (!status || !button || !input) return;
    const original = button.textContent;

    const say = (message, state) => { status.textContent = message; status.dataset.state = state; };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = input.value.trim();

      if (!email || !EMAIL_RE.test(email)) {
        input.setAttribute('aria-invalid', 'true');
        say('That address does not look right. Check it and try again.', 'error');
        input.focus();
        return;
      }
      input.removeAttribute('aria-invalid');

      button.disabled = true;
      button.textContent = 'Sending…';

      try {
        const companyField = form.querySelector('input[name=company]');
        const response = await fetch('/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email,
            source: form.dataset.source,
            company: companyField ? companyField.value : '',
            path: location.pathname,
          }),
        });
        const result = await response.json().catch(() => ({}));

        if (response.ok) {
          const field = form.querySelector('.field');
          if (field) field.remove();
          button.remove();
          say(result.message || "You're on the list. Watch your inbox.", 'ok');
        } else {
          say(result.message || 'That did not save. Try again in a moment.', 'error');
          button.disabled = false;
          button.textContent = original;
        }
      } catch {
        // The old site used mode:'no-cors', which made every response
        // unreadable and every success message a guess. This one is real.
        say('No connection. Check your signal and try again.', 'error');
        button.disabled = false;
        button.textContent = original;
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Business enquiry form                                               */
/* ------------------------------------------------------------------ */

function initLeadForm() {
  const form = document.querySelector('form[data-lead]');
  if (!form) return;

  const status = form.querySelector('.lead-status');
  const button = form.querySelector('button[type=submit]');
  if (!status || !button) return;
  const original = button.textContent;

  const say = (message, state) => { status.textContent = message; status.dataset.state = state; };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    // Point at the first thing that is actually wrong and move focus there.
    // An error message with no destination is a dead end.
    for (const name of ['business_name', 'contact_name', 'phone', 'email']) {
      const input = form.elements.namedItem(name);
      if (!input || !input.value.trim()) {
        if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
        say('Fill in the business name, your name, a phone number and an email.', 'error');
        return;
      }
      input.removeAttribute('aria-invalid');
    }

    button.disabled = true;
    button.textContent = 'Sending…';

    try {
      const response = await fetch('/api/merchant-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const result = await response.json().catch(() => ({}));

      if (response.ok) {
        const grid = form.querySelector('.form-grid');
        if (grid) grid.remove();
        button.remove();
        say(result.message || 'Got it. We will be in touch.', 'ok');
      } else {
        say(result.message || 'That did not send. Try again.', 'error');
        button.disabled = false;
        button.textContent = original;
      }
    } catch {
      say('No connection. Check your signal and try again.', 'error');
      button.disabled = false;
      button.textContent = original;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Featured carousel                                                   */
/*                                                                     */
/* A continuous drift that loops without ever visibly resetting.       */
/*                                                                     */
/* How the loop stays seamless: the strip is followed by inert copies  */
/* of itself, and the position wraps by exactly the measured width of  */
/* one set. At the moment of wrapping, the copy on screen is pixel-    */
/* identical to the original it replaces, so nothing jumps.            */
/*                                                                     */
/* How it stays cheap: one requestAnimationFrame loop that runs only    */
/* while the strip is moving AND on screen AND the tab is visible. When */
/* paused, scrolled away or hovered, it stops completely.               */
/*                                                                     */
/* How it stays tappable: slides are ordinary links. Movement is a      */
/* transform, which never interferes with a tap; a drag is told apart   */
/* from a tap and never opens a link by accident.                       */
/* ------------------------------------------------------------------ */

function initCarousel() {
  document.querySelectorAll('[data-carousel]').forEach(setupCarousel);
}

function setupCarousel(root) {
  const viewport = root.querySelector('[data-carousel-viewport]');
  const track = root.querySelector('[data-carousel-track]');
  if (!viewport || !track) return;
  const originals = Array.from(track.querySelectorAll('[data-slide]'));
  if (!originals.length) return;

  const controls = root.querySelector('[data-carousel-controls]');
  const prevButton = root.querySelector('[data-carousel-prev]');
  const nextButton = root.querySelector('[data-carousel-next]');
  const pauseButton = root.querySelector('[data-carousel-pause]');
  const pauseLabel = root.querySelector('[data-pause-label]');
  const pauseIcon = root.querySelector('[data-pause-icon]');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const seconds = Math.min(20, Math.max(4, parseFloat(root.dataset.seconds || '8') || 8));
  const autoplayWanted = root.dataset.autoplay !== 'false';

  viewport.classList.add('is-enhanced');
  viewport.scrollLeft = 0;

  let clones = [];
  let loopWidth = 0;       // width of one full set of slides, gap included
  let positions = [];      // left edge of each original, relative to the first
  let offset = 0;          // current distance moved, always 0 <= offset < loopWidth
  let staticStrip = false; // everything fits: no movement, no controls
  let playing = autoplayWanted && !reduceMotion.matches;
  let hasPlayed = playing;
  let onScreen = true;
  let hovered = false;
  let focused = false;
  let dragging = false;
  let tween = null;
  let frame = 0;
  let lastTime = 0;
  let lastWidth = 0;

  const apply = () => { track.style.transform = `translate3d(${-offset}px, 0, 0)`; };
  const wrap = (value) => (loopWidth > 0 ? ((value % loopWidth) + loopWidth) % loopWidth : 0);

  function measure() {
    const first = originals[0];
    const last = originals[originals.length - 1];
    const gap = parseFloat(getComputedStyle(track).columnGap) || 16;
    loopWidth = last.offsetLeft + last.offsetWidth + gap - first.offsetLeft;
    positions = originals.map((slide) => slide.offsetLeft - first.offsetLeft);
    // If every business already fits on screen there is nothing to scroll
    // to, and a drifting copy of the same card would just look odd.
    const visibleWidth = viewport.clientWidth - first.offsetLeft;
    staticStrip = loopWidth - gap <= visibleWidth;
  }

  function buildClones() {
    clones.forEach((clone) => clone.remove());
    clones = [];
    if (staticStrip) return;
    // Enough copies to cover the screen twice over past the end of one set,
    // so neither the drift nor a step back ever shows an empty edge.
    const sets = Math.ceil(viewport.clientWidth / loopWidth) + 2;
    for (let set = 0; set < sets; set += 1) {
      originals.forEach((slide) => {
        const clone = slide.cloneNode(true);
        // inert: unreachable by keyboard, invisible to screen readers,
        // and ignored by the impression counter. One business, one stop.
        clone.setAttribute('inert', '');
        clone.setAttribute('aria-hidden', 'true');
        clone.removeAttribute('data-track-impression');
        clone.removeAttribute('aria-label');
        track.appendChild(clone);
        clones.push(clone);
      });
    }
  }

  function layout() {
    lastWidth = viewport.clientWidth;
    const fraction = loopWidth > 0 ? offset / loopWidth : 0;
    measure();
    buildClones();
    offset = staticStrip ? 0 : wrap(fraction * loopWidth);
    apply();
    render();
  }

  /* ---- The drift loop ---- */

  const shouldRun = () =>
    playing && !staticStrip && onScreen && !document.hidden && !hovered && !focused && !dragging && !tween;

  function schedule() {
    track.classList.toggle('is-moving', shouldRun() || !!tween);
    if (!frame && (shouldRun() || tween)) {
      lastTime = 0;
      frame = requestAnimationFrame(step);
    }
  }

  function step(now) {
    frame = 0;
    const delta = lastTime ? Math.min(0.05, (now - lastTime) / 1000) : 0;
    lastTime = now;

    if (tween) {
      const t = Math.min(1, (now - tween.start) / tween.duration);
      const eased = 1 - Math.pow(1 - t, 3);
      offset = tween.from + (tween.to - tween.from) * eased;
      if (t >= 1) { offset = wrap(tween.to); tween = null; }
      apply();
    } else if (shouldRun()) {
      offset = wrap(offset + (loopWidth / originals.length / seconds) * delta);
      apply();
    }

    if (shouldRun() || tween) frame = requestAnimationFrame(step);
    else track.classList.remove('is-moving');
  }

  function glideTo(target) {
    const duration = reduceMotion.matches ? 0 : 380;
    if (duration === 0) { offset = wrap(target); apply(); return; }
    tween = { from: offset, to: target, start: performance.now(), duration };
    schedule();
  }

  /* ---- Manual movement ---- */

  function nearest(from) {
    let best = 0;
    let bestDistance = Infinity;
    for (const p of [...positions, loopWidth]) {
      const distance = Math.abs(p - from);
      if (distance < bestDistance) { best = p; bestDistance = distance; }
    }
    return best;
  }

  function moveBy(direction) {
    if (staticStrip) return;
    tween = null;
    if (direction < 0 && offset < 2) { offset += loopWidth; apply(); }
    const candidates = [...positions, ...positions.map((p) => p + loopWidth), loopWidth * 2];
    const target = direction > 0
      ? candidates.find((p) => p > offset + 2)
      : [...candidates].reverse().find((p) => p < offset - 2);
    if (target !== undefined) glideTo(target);
  }

  /* ---- Controls ---- */

  function render() {
    const moving = !reduceMotion.matches && !staticStrip;
    if (controls) controls.hidden = staticStrip;
    if (pauseButton) pauseButton.hidden = !moving;
    if (prevButton) prevButton.hidden = playing && moving;
    if (nextButton) nextButton.hidden = playing && moving;
    if (pauseLabel) {
      pauseLabel.textContent = playing ? 'Pause slideshow' : hasPlayed ? 'Resume slideshow' : 'Play slideshow';
    }
    if (pauseIcon) pauseIcon.textContent = playing ? '❚❚' : '▶';
    root.classList.toggle('is-paused', !playing);
  }

  function setPlaying(value) {
    playing = value && !reduceMotion.matches;
    if (playing) hasPlayed = true;
    if (!playing) glideTo(nearest(offset));
    render();
    schedule();
  }

  if (pauseButton) pauseButton.addEventListener('click', () => setPlaying(!playing));
  if (prevButton) prevButton.addEventListener('click', () => moveBy(-1));
  if (nextButton) nextButton.addEventListener('click', () => moveBy(1));

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    if (playing) setPlaying(false);
    moveBy(event.key === 'ArrowRight' ? 1 : -1);
  });

  /* ---- Pausing while someone is using it ---- */

  viewport.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse') { hovered = true; schedule(); }
  });
  viewport.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse') { hovered = false; schedule(); }
  });

  // A keyboard user tabbing onto a slide that is off screen: stop, and
  // bring it into view. Browsers otherwise scroll the clipped container
  // behind our back, which knocks the loop out of line.
  track.addEventListener('focusin', (event) => {
    focused = true;
    viewport.scrollLeft = 0;
    const slide = event.target.closest('[data-slide]');
    const index = originals.indexOf(slide);
    if (index >= 0 && !staticStrip) {
      const first = originals[0];
      const room = viewport.clientWidth - first.offsetLeft;
      const left = positions[index] - offset;
      if (left < 0 || left + slide.offsetWidth > room) glideTo(positions[index]);
    }
    schedule();
  });
  track.addEventListener('focusout', (event) => {
    if (!track.contains(event.relatedTarget)) { focused = false; schedule(); }
  });

  /* ---- Swipe and drag ---- */

  let pointer = null;
  let suppressClickUntil = 0;

  viewport.addEventListener('pointerdown', (event) => {
    if (staticStrip || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, start: offset, decided: false };
  });

  viewport.addEventListener('pointermove', (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (!pointer.decided) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { pointer = null; return; } // page scroll wins
      if (Math.abs(dx) < 8 || Math.abs(dx) <= Math.abs(dy)) return;
      pointer.decided = true;
      dragging = true;
      tween = null;
      pointer.start = offset + dx; // no jump at the moment the drag is recognised
      try { viewport.setPointerCapture(event.pointerId); } catch { /* not all pointers can be captured */ }
    }
    offset = wrap(pointer.start - dx);
    apply();
  });

  const endDrag = (event) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    const wasDragging = pointer.decided;
    const dx = event.clientX - pointer.x;
    pointer = null;
    if (!wasDragging) return;
    dragging = false;
    suppressClickUntil = Date.now() + 400;
    // A flick of more than 40px moves one business in that direction;
    // anything less settles on the closest one.
    if (dx < -40) moveBy(1);
    else if (dx > 40) moveBy(-1);
    else glideTo(nearest(offset));
    schedule();
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);

  // A drag that ends over a link must not open it.
  track.addEventListener('click', (event) => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  track.addEventListener('dragstart', (event) => event.preventDefault());

  /* ---- Visibility, size and preferences ---- */

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      schedule();
    }).observe(root);
  }
  document.addEventListener('visibilitychange', schedule);

  // Only a real change of width matters. Phones fire resize when the
  // address bar slides away during scrolling; reacting to that is what
  // used to make carousels jump back to the start.
  const onResize = () => { if (viewport.clientWidth !== lastWidth) layout(); };
  if ('ResizeObserver' in window) new ResizeObserver(onResize).observe(viewport);
  else window.addEventListener('resize', onResize, { passive: true });

  const onMotionChange = () => { if (reduceMotion.matches) playing = false; render(); schedule(); };
  if (reduceMotion.addEventListener) reduceMotion.addEventListener('change', onMotionChange);

  layout();
  schedule();
}

/* ------------------------------------------------------------------ */
/* Location picker                                                     */
/*                                                                     */
/* The choice is remembered so nobody is asked twice, but it is never   */
/* guessed. Stored per browser; if storage is unavailable the picker    */
/* still works, it just forgets between visits.                        */
/* ------------------------------------------------------------------ */

const TOWN_KEY = 'pp_town';

/**
 * The chosen town is written to a cookie, not just localStorage, because
 * every list on this site is rendered on the server. With localStorage alone
 * the picker changed a label and nothing else — the carousel respected the
 * town, the business directory did not.
 */
function rememberTown(slug) {
  // "all" is remembered as a choice too. An empty slug forgets the choice.
  const oneYear = 60 * 60 * 24 * 365;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  if (slug) {
    document.cookie = `${TOWN_KEY}=${encodeURIComponent(slug)}; Path=/; Max-Age=${oneYear}; SameSite=Lax${secure}`;
  } else {
    document.cookie = `${TOWN_KEY}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  }
}

/**
 * A town page remembers itself. Someone who arrives at /malvern from a
 * search result and then taps Home should land back in Malvern, not be
 * asked again or shown a different town.
 */
/**
 * On a phone the header scrolls away with the page. Once it is out of
 * view, a slim bar with the town button (and Facebook) stays at the top.
 * On larger screens the header itself stays put, so it never leaves view
 * and this bar never appears.
 */
function initTownBar() {
  const bar = document.querySelector('[data-town-bar]');
  const header = document.querySelector('.site-header');
  if (!bar || !header || !('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver(([entry]) => {
    const show = !entry.isIntersecting;
    bar.hidden = !show;
    // Keep anything reached with Tab clear of the bar (WCAG 2.4.11).
    document.documentElement.classList.toggle('has-town-bar', show);
  });
  observer.observe(header);
}

function initRememberTown() {
  const marker = document.querySelector('[data-remember-town]');
  if (marker && marker.dataset.townSlug) rememberTown(marker.dataset.townSlug);

  // The first-visit chooser and any other town link that sets the choice.
  document.addEventListener('click', (event) => {
    const link = event.target.closest && event.target.closest('[data-town-choice]');
    if (link) rememberTown(link.dataset.townSlug || '');
  });
}

function initTownPicker() {
  const dialog = document.querySelector('[data-town-dialog]');
  if (!dialog || typeof dialog.showModal !== 'function') return;

  let opener = null;

  document.querySelectorAll('[data-town-open]').forEach((button) => {
    button.addEventListener('click', () => {
      opener = button;
      dialog.showModal();
    });
  });

  dialog.querySelectorAll('[data-town-close]').forEach((button) => {
    button.addEventListener('click', () => dialog.close());
  });

  dialog.querySelectorAll('[data-town-option]').forEach((option) => {
    option.addEventListener('click', () => rememberTown(option.dataset.townSlug));
  });

  // Clicking the dark surround closes, which is what everyone expects of a
  // sheet. The inner panel swallows its own clicks.
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { if (opener) opener.focus(); });
}

/* ------------------------------------------------------------------ */
/* Search as you type — every box, every page                          */
/*                                                                     */
/* One behaviour, three placements:                                    */
/*   - the homepage box drops suggestions beneath itself               */
/*   - /deals and /businesses replace their grid in place              */
/*                                                                     */
/* It searches business name, tagline, description, street, city,      */
/* phone, category, town, deal headline and deal description. Typing a */
/* phone number or a town used to find nothing, which reads as "this   */
/* site is empty" rather than "this box only looks at two fields".     */
/* ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Live results come back as HTML rendered by the same components as the
 * page itself (see /search-results), so a search result can never look or
 * behave differently from the card it replaces.
 */
async function fetchResultsHtml(term) {
  const params = new URLSearchParams(location.search);
  params.set('q', term);
  params.delete('page');
  const response = await fetch(`/search-results?${params.toString()}`, { headers: { Accept: 'text/html' } });
  if (!response.ok) throw new Error(`search ${response.status}`);
  return {
    html: await response.text(),
    total: parseInt(response.headers.get('x-result-count') || '0', 10) || 0,
  };
}

async function fetchResults(term) {
  const params = new URLSearchParams(location.search);
  params.set('q', term);
  params.delete('page');
  const response = await fetch(`/api/search?${params.toString()}`);
  if (!response.ok) throw new Error(`search ${response.status}`);
  return response.json();
}

/**
 * Debounced: one request per typing pause, not one per keystroke.
 *
 * `interceptSubmit` is for the results grids, which update in place. The
 * homepage box must NOT intercept: pressing Search there should go to the
 * full results page, not just reopen the suggestion list.
 */
function onTyping(input, handler, { wait = 220, interceptSubmit = false } = {}) {
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(handler, wait);
  });
  const form = input.closest('form');
  if (form && interceptSubmit) {
    form.addEventListener('submit', (event) => {
      if (input.value.trim().length >= 2) { event.preventDefault(); clearTimeout(timer); handler(); }
    });
  }
}

/** Replaces a results grid in place, on /deals and /businesses. */
function initGridSearch() {
  const input = document.querySelector('[data-server-search]');
  if (!input) return;

  const target = document.querySelector(input.dataset.target || '#deal-results');
  if (!target) return;

  const counter = document.querySelector('[data-result-count]');
  const extras = Array.from(document.querySelectorAll('[data-hide-on-search]'));
  const initialHtml = target.innerHTML;
  const initialCount = counter ? counter.textContent : '';
  let latest = 0;

  const restore = () => {
    target.innerHTML = initialHtml;
    target.removeAttribute('aria-busy');
    if (counter) counter.textContent = initialCount;
    extras.forEach((el) => { el.hidden = false; });
    initImageFallbacks(target);
  };

  onTyping(input, async () => {
    const term = input.value.trim();
    const ticket = ++latest;
    if (term.length < 2) return restore();

    // Sections that describe the unfiltered page would contradict the
    // results while a search is showing.
    extras.forEach((el) => { el.hidden = true; });
    target.setAttribute('aria-busy', 'true');

    try {
      const { html, total } = await fetchResultsHtml(term);
      if (ticket !== latest) return;
      target.innerHTML = html;
      target.removeAttribute('aria-busy');
      initImageFallbacks(target);
      if (counter) counter.textContent = `${total} ${total === 1 ? 'result' : 'results'} for “${term}”`;
    } catch {
      if (ticket === latest) {
        target.removeAttribute('aria-busy');
        target.innerHTML = '<p class="search-empty">Search is unavailable right now. Try again in a moment.</p>';
      }
    }
  }, { interceptSubmit: true });
}

/** Suggestion list under the homepage box. */
function initSuggestSearch() {
  const input = document.querySelector('[data-suggest-search]');
  if (!input) return;

  const panel = document.querySelector('[data-suggest-panel]');
  if (!panel) return;
  let latest = 0;

  const hide = () => { panel.hidden = true; panel.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); };

  onTyping(input, async () => {
    const term = input.value.trim();
    const ticket = ++latest;
    if (term.length < 2) return hide();

    try {
      const data = await fetchResults(term);
      if (ticket !== latest) return;

      const rows = (data.results || []).slice(0, 7).map((r) => `
          <li><a href="${escapeHtml(r.href)}">
            <span class="sg-main">${escapeHtml(r.title)}</span>
            <span class="sg-sub">${escapeHtml(r.subtitle)}</span>
          </a></li>`);

      panel.innerHTML = rows.length
        ? `<ul class="list-plain">${rows.join('')}</ul>
           <a class="sg-all" href="/deals?q=${encodeURIComponent(term)}">See all results</a>`
        : `<p class="sg-none">Nothing matches &ldquo;${escapeHtml(term)}&rdquo; yet.</p>`;
      panel.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    } catch {
      hide();
    }
  });

  document.addEventListener('click', (event) => {
    if (!panel.contains(event.target) && event.target !== input) hide();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hide();
    if (event.key === 'ArrowDown') {
      const first = panel.querySelector('a');
      if (first) { event.preventDefault(); first.focus(); }
    }
  });
}

/* ------------------------------------------------------------------ */
/* Broken images                                                       */
/*                                                                     */
/* A missing or broken business image swaps to the initials tile the   */
/* frame already carries, rather than showing the browser's broken-    */
/* image icon or collapsing the card. Images that failed before this   */
/* script ran are caught by checking each one on start.                */
/* ------------------------------------------------------------------ */

function markBroken(img) {
  const frame = img.closest('.mf');
  if (!frame || frame.classList.contains('is-broken')) return;
  frame.classList.add('is-broken');
  const fallback = frame.querySelector('.mf-fallback');
  if (fallback) fallback.hidden = false;
}

function initImageFallbacks(scope) {
  (scope || document).querySelectorAll('img[data-mf-img]').forEach((img) => {
    if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) markBroken(img);
  });
}

function initImageErrorListener() {
  document.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target.tagName === 'IMG' && target.hasAttribute('data-mf-img')) markBroken(target);
  }, true);
}

/* ------------------------------------------------------------------ */
/* Photo lightbox                                                      */
/* ------------------------------------------------------------------ */

function initGallery() {
  const strip = document.querySelector('[data-gallery]');
  const box = document.querySelector('[data-lightbox]');
  if (!strip || !box || typeof box.showModal !== 'function') return;

  const image = box.querySelector('[data-lightbox-image]');
  const caption = box.querySelector('[data-lightbox-caption]');
  const shots = Array.from(strip.querySelectorAll('[data-gallery-open]'));
  if (!shots.length) return;
  let current = 0;
  let opener = null;

  const show = (index) => {
    current = (index + shots.length) % shots.length;
    const shot = shots[current];
    image.src = shot.dataset.full;
    image.alt = shot.querySelector('img')?.alt || '';
    caption.textContent = shot.dataset.caption || '';
  };

  shots.forEach((shot, index) => {
    shot.addEventListener('click', () => {
      opener = shot;
      show(index);
      box.showModal();
    });
  });

  box.querySelector('[data-lightbox-next]')?.addEventListener('click', () => show(current + 1));
  box.querySelector('[data-lightbox-prev]')?.addEventListener('click', () => show(current - 1));
  box.querySelector('[data-lightbox-close]')?.addEventListener('click', () => box.close());

  box.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') show(current + 1);
    if (event.key === 'ArrowLeft') show(current - 1);
  });

  // Clicking the dark surround closes, which is what everyone expects.
  box.addEventListener('click', (event) => { if (event.target === box) box.close(); });

  // Focus returns where it came from, so a keyboard user is not dumped at the
  // top of the document.
  box.addEventListener('close', () => { if (opener) opener.focus(); });
}

/* ------------------------------------------------------------------ */
/* Search usage                                                        */
/*                                                                     */
/* Recorded because knowing what people look for and fail to find is    */
/* how you decide which business to sign next. No merchant id, so it    */
/* never lands in anyone's performance report.                          */
/* ------------------------------------------------------------------ */

function initSearchTracking() {
  document.querySelectorAll('form[role=search]').forEach((form) => {
    form.addEventListener('submit', () => {
      const input = form.querySelector('input[type=search]');
      if (input && input.value.trim()) sendEvent({ event_type: 'search' });
    });
  });
}

/*
 * Each starter runs in isolation.
 *
 * These used to be bare calls in sequence. A reference to a function that
 * did not exist threw on line three and silently killed everything after
 * it — the carousel, the gallery, coupon copying, the newsletter form and
 * all merchant analytics — with no visible error anywhere on the page.
 * Now one failure costs one feature, and says so in the console.
 */
[
  ['image errors', initImageErrorListener],
  ['image fallbacks', () => initImageFallbacks()],
  ['page views', initPageViews],
  ['remember town', initRememberTown],
  ['town bar', initTownBar],
  ['town picker', initTownPicker],
  ['grid search', initGridSearch],
  ['suggestions', initSuggestSearch],
  ['carousel', initCarousel],
  ['search tracking', initSearchTracking],
  ['gallery', initGallery],
  ['impressions', initImpressions],
  ['intent clicks', initIntentClicks],
  ['copy code', initCopyButtons],
  ['share', initShareButtons],
  ['newsletter', initNewsletterForms],
  ['enquiry form', initLeadForm],
].forEach(([name, start]) => {
  try {
    start();
  } catch (error) {
    console.error(`Pocket Perks: ${name} failed to start`, error);
  }
});
