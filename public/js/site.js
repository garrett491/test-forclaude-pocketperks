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
    button.addEventListener('click', async () => {
      // The current page URL, which is now a real deal page rather than the
      // homepage link the old share button sent for every offer.
      const url = location.href;
      const title = button.dataset.title || document.title;
      try {
        if (navigator.share) {
          await navigator.share({ title, url });
        } else {
          await navigator.clipboard.writeText(url);
          const original = button.textContent;
          button.textContent = 'Link copied';
          setTimeout(() => { button.textContent = original; }, 2200);
        }
      } catch {
        // The visitor cancelled the share sheet. Not an error.
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
/* Carousel                                                            */
/*                                                                     */
/* Three problems this fixes, all of which showed up on mobile:         */
/*                                                                     */
/* 1. It restarted from the beginning while the page was scrolled.      */
/*    Mobile browsers fire `resize` when the address bar hides or       */
/*    shows, and the old handler reset the offset on any resize. It now */
/*    only re-measures when the WIDTH actually changes.                 */
/*                                                                     */
/* 2. It stuttered during vertical scrolling, because every animation   */
/*    frame called getBoundingClientRect and forced a layout. Widths    */
/*    are measured once and cached.                                     */
/*                                                                     */
/* 3. Touching a card paused it for a moment, which is right, but a tap */
/*    must never stop the slideshow for good. Only the pause button     */
/*    does that.                                                        */
/* ------------------------------------------------------------------ */

function initCarousel() {
  const root = document.querySelector('[data-carousel]');
  if (!root) return;

  const track = root.querySelector('[data-carousel-track]');
  if (!track) return;

  const originals = Array.from(track.querySelectorAll('[data-slide]'));
  if (!originals.length) return;

  const prev = root.querySelector('[data-carousel-prev]');
  const next = root.querySelector('[data-carousel-next]');
  const pauseButton = root.querySelector('[data-carousel-pause]');
  const pauseLabel = root.querySelector('[data-pause-label]');
  const pauseIcon = root.querySelector('[data-pause-icon]');
  const manualControls = root.querySelector('[data-manual-controls]');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const autoplay = root.dataset.autoplay !== 'false';
  const seconds = Math.min(20, Math.max(4, parseFloat(root.dataset.seconds || '8') || 8));

  const cloneAll = () => {
    originals.forEach((slide) => {
      const clone = slide.cloneNode(true);
      clone.setAttribute('aria-hidden', 'true');
      clone.removeAttribute('data-track-impression');
      // Clones must not be reachable by keyboard: tabbing would cycle
      // through the same business several times.
      clone.querySelectorAll('a, button').forEach((el) => el.setAttribute('tabindex', '-1'));
      track.appendChild(clone);
    });
  };

  let copies = 0;
  while (track.scrollWidth < window.innerWidth * 2 && copies < 8) { cloneAll(); copies += 1; }
  cloneAll();
  copies += 1;

  // Measured once, and again only on a real width change.
  let slideStep = 0;
  let loopWidth = 0;
  let lastWidth = window.innerWidth;

  /**
   * If a slide ever measures zero the drift distance per frame becomes zero
   * and the carousel is frozen for good — silently, with no error. That can
   * happen when the strip is measured before web fonts settle, or while it
   * sits in a container that has not been laid out yet.
   *
   * So: never trust a zero. Fall back to the width the CSS would give,
   * re-measure once the page has finished loading, and keep retrying for a
   * short while until a real number arrives.
   */
  const fallbackWidth = () => Math.min(544, window.innerWidth * 0.82) + 16;

  const measure = () => {
    const first = track.querySelector('[data-slide]');
    const gap = parseFloat(getComputedStyle(track).gap || '0') || 16;
    const measured = first ? first.getBoundingClientRect().width : 0;
    slideStep = (measured > 0 ? measured : fallbackWidth()) + (measured > 0 ? gap : 0);
    loopWidth = slideStep * originals.length * copies;
    return measured > 0;
  };

  let measured = measure();

  if (!measured) {
    let attempts = 0;
    const retry = () => {
      if (measured || attempts > 20) return;
      attempts += 1;
      measured = measure();
      if (!measured) setTimeout(retry, 150);
    };
    setTimeout(retry, 150);
  }

  // Fonts and images change slide width after first paint.
  window.addEventListener('load', () => { measure(); }, { once: true });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => measure()).catch(() => {});
  }

  let offset = 0;
  let manual = reduceMotion || !autoplay;
  let held = false;
  let last = 0;

  const applyOffset = () => { track.style.transform = `translate3d(${-offset}px, 0, 0)`; };

  const step = (now) => {
    if (!last) last = now;
    const delta = Math.min(0.05, (now - last) / 1000); // cap after a stall
    last = now;

    if (!manual && !held && !document.hidden) {
      offset += (slideStep / seconds) * delta;
      if (loopWidth > 0 && offset >= loopWidth) offset -= loopWidth;
      applyOffset();
    }
    requestAnimationFrame(step);
  };

  const setManual = (value) => {
    manual = value;
    root.classList.toggle('is-manual', manual);
    if (manualControls) manualControls.hidden = !manual;
    if (pauseButton) {
      pauseButton.setAttribute('aria-pressed', manual ? 'true' : 'false');
      if (pauseLabel) pauseLabel.textContent = manual ? 'Resume slideshow' : 'Pause slideshow';
      if (pauseIcon) pauseIcon.textContent = manual ? '▶' : '❚❚';
    }
  };

  const snap = () => {
    if (slideStep <= 0) return;
    offset = Math.round(offset / slideStep) * slideStep;
    if (loopWidth > 0) { if (offset < 0) offset += loopWidth; if (offset >= loopWidth) offset -= loopWidth; }
  };

  const glide = () => {
    track.style.transition = 'transform 320ms cubic-bezier(0.2, 0, 0, 1)';
    applyOffset();
    setTimeout(() => { track.style.transition = ''; }, 340);
  };

  const nudge = (direction) => {
    snap();
    offset += direction * slideStep;
    if (loopWidth > 0) { if (offset < 0) offset += loopWidth; if (offset >= loopWidth) offset -= loopWidth; }
    glide();
  };

  if (prev) prev.addEventListener('click', () => nudge(-1));
  if (next) next.addEventListener('click', () => nudge(1));

  if (pauseButton) {
    pauseButton.addEventListener('click', () => {
      const goingManual = !manual;
      if (goingManual) { snap(); glide(); }
      setManual(goingManual);
    });
  }

  // A pointer resting on the strip pauses it; moving away resumes. This is
  // temporary by design — tapping a card opens the deal and never stops the
  // slideshow permanently.
  const hold = () => { held = true; };
  const release = () => { held = false; };
  root.addEventListener('mouseenter', hold, { passive: true });
  root.addEventListener('mouseleave', release, { passive: true });
  root.addEventListener('focusin', hold);
  root.addEventListener('focusout', release);

  /*
    Touch is the subtle one. A finger landing on the carousel might be
    starting a horizontal swipe of the strip, or a vertical scroll of the
    page that happens to begin here. Pausing on every touch made the
    carousel feel broken while scrolling, so we watch the direction: a
    mostly-vertical move is the page scrolling and is left alone.
  */
  let touchX = 0, touchY = 0, horizontal = false;
  root.addEventListener('touchstart', (event) => {
    const t = event.touches[0];
    touchX = t.clientX; touchY = t.clientY; horizontal = false;
    held = true;
  }, { passive: true });

  root.addEventListener('touchmove', (event) => {
    const t = event.touches[0];
    if (!horizontal && Math.abs(t.clientY - touchY) > Math.abs(t.clientX - touchX) + 6) {
      held = false; // vertical scroll — let it keep drifting
    } else if (Math.abs(t.clientX - touchX) > 10) {
      horizontal = true; held = true;
    }
  }, { passive: true });

  root.addEventListener('touchend', () => {
    if (horizontal) {
      const moved = touchX;
      void moved;
    }
    setTimeout(() => { held = false; }, 600);
  }, { passive: true });

  root.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') { event.preventDefault(); if (!manual) setManual(true); nudge(1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); if (!manual) setManual(true); nudge(-1); }
  });

  // Only a genuine width change matters. Mobile browsers fire resize when
  // the address bar hides on scroll, and reacting to that is what made the
  // carousel jump back to the start mid-scroll.
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    measure();
    snap();
    applyOffset();
  }, { passive: true });

  setManual(manual);
  applyOffset();
  requestAnimationFrame(step);
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
  const oneYear = 60 * 60 * 24 * 365;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  if (slug) {
    document.cookie = `${TOWN_KEY}=${encodeURIComponent(slug)}; Path=/; Max-Age=${oneYear}; SameSite=Lax${secure}`;
  } else {
    document.cookie = `${TOWN_KEY}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
  }
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

function renderDealCard(item) {
  const art = item.image
    ? `<div class="art${item.isLogoArt ? ' is-logo' : ''}">
         <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.merchantName)}"
              width="380" height="238" loading="lazy" decoding="async">
       </div>`
    : `<div class="art"><div class="art-fallback" aria-hidden="true">
         <span>${escapeHtml(item.initials)}</span></div></div>`;

  const code = item.couponCode
    ? `<div class="stitch-panel code-panel">
         <span class="code-label">Code</span>
         <span class="code-value">${escapeHtml(item.couponCode)}</span>
       </div>` : '';

  // Same loud band as the server-rendered cards. Search results that quietly
  // dropped it would make a business look like it has one offer.
  const more = item.siblingCount > 0
    ? `<a class="more-band" href="${escapeHtml(item.merchantHref)}">
         <span class="mb-text">See ${item.siblingCount} more ${item.siblingCount === 1 ? 'deal' : 'deals'} from ${escapeHtml(item.merchantName)}</span>
         <span class="mb-arrow" aria-hidden="true">&rarr;</span>
       </a>`
    : '';

  return `<article class="deal-card card" data-deal-id="${escapeHtml(item.dealId)}"
            data-merchant-id="${escapeHtml(item.merchantId)}" data-track-impression>
      ${art}
      <div class="body">
        <p class="merchant-line">
          <span class="merchant-name">${escapeHtml(item.merchantName)}</span>
          ${item.categoryName ? `<span class="dot" aria-hidden="true"></span><span class="cat">${escapeHtml(item.categoryName)}</span>` : ''}
        </p>
        <h3 class="headline"><a href="${escapeHtml(item.href)}" class="stretch">${escapeHtml(item.headline)}</a></h3>
        ${item.description ? `<p class="desc">${escapeHtml(item.description)}</p>` : ''}
        ${code}
        ${more}
        <div class="meta">
          ${item.expiry ? `<span class="expiry">${escapeHtml(item.expiry)}</span>` : ''}
          <span class="see">See deal</span>
        </div>
      </div>
    </article>`;
}

function renderMerchantCard(item) {
  const logo = item.image
    ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" width="68" height="68" loading="lazy">`
    : `<span class="logo-fallback" aria-hidden="true">${escapeHtml(item.initials)}</span>`;

  const meta = [item.categoryName, item.townName].filter(Boolean).join(' · ');

  return `<article class="merchant-card card" data-merchant-id="${escapeHtml(item.merchantId)}">
      <div class="head">
        <div class="logo">${logo}</div>
        <div class="head-text">
          <h3 class="name"><a href="${escapeHtml(item.href)}" class="stretch">${escapeHtml(item.name)}</a></h3>
          ${meta ? `<p class="cat">${escapeHtml(meta)}</p>` : ''}
        </div>
      </div>
      ${item.tagline ? `<p class="tagline">${escapeHtml(item.tagline)}</p>` : ''}
      <div class="meta">
        ${item.status ? `<span class="status">${escapeHtml(item.status)}</span>` : ''}
        ${item.dealCount ? '' : '<span class="note">No deals right now</span>'}
      </div>
      ${item.dealCount ? `<a class="more-band more-band-soft" href="${escapeHtml(item.href)}">
         <span class="mb-text">See ${item.dealCount} ${item.dealCount === 1 ? 'deal' : 'deals'} from ${escapeHtml(item.name)}</span>
         <span class="mb-arrow" aria-hidden="true">&rarr;</span>
       </a>` : ''}
    </article>`;
}

async function fetchResults(term) {
  const params = new URLSearchParams(location.search);
  params.set('q', term);
  params.delete('page');
  const response = await fetch(`/api/search?${params.toString()}`);
  return response.json();
}

/** Debounced: one request per typing pause, not one per keystroke. */
function onTyping(input, handler, wait = 220) {
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(handler, wait);
  });
  const form = input.closest('form');
  if (form) {
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
    if (counter) counter.textContent = initialCount;
    extras.forEach((el) => { el.hidden = false; });
  };

  onTyping(input, async () => {
    const term = input.value.trim();
    const ticket = ++latest;
    if (term.length < 2) return restore();

    // Sections that describe the unfiltered page would contradict the
    // results while a search is showing.
    extras.forEach((el) => { el.hidden = true; });

    try {
      const data = await fetchResults(term);
      if (ticket !== latest) return;

      const cards = [
        ...(data.deals || []).map(renderDealCard),
        ...(data.merchants || []).map(renderMerchantCard),
      ];

      target.innerHTML = cards.length
        ? cards.join('')
        : `<p class="search-empty">Nothing matches &ldquo;${escapeHtml(term)}&rdquo;. Try a business name, a town, or what you are looking for.</p>`;

      if (counter) {
        counter.textContent = `${data.total} ${data.total === 1 ? 'result' : 'results'} for “${term}”`;
      }
    } catch {
      if (ticket === latest) {
        target.innerHTML = '<p class="search-empty">Search is unavailable right now. Try again in a moment.</p>';
      }
    }
  });
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

      const rows = [
        ...(data.deals || []).slice(0, 5).map((d) => `
          <li><a href="${escapeHtml(d.href)}">
            <span class="sg-main">${escapeHtml(d.headline)}</span>
            <span class="sg-sub">${escapeHtml(d.merchantName)}${d.townName ? ' · ' + escapeHtml(d.townName) : ''}</span>
          </a></li>`),
        ...(data.merchants || []).slice(0, 4).map((m) => `
          <li><a href="${escapeHtml(m.href)}">
            <span class="sg-main">${escapeHtml(m.name)}</span>
            <span class="sg-sub">${escapeHtml([m.categoryName, m.townName].filter(Boolean).join(' · '))}</span>
          </a></li>`),
      ];

      panel.innerHTML = rows.length
        ? `<ul class="list-plain">${rows.join('')}</ul>
           <a class="sg-all" href="/deals?q=${encodeURIComponent(term)}">See all ${data.total} results</a>`
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
  ['page views', initPageViews],
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
