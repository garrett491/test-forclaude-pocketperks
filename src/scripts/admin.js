/**
 * Pocket Perks — admin behaviour.
 *
 * External for the same reason as site.js: a strict script-src 'self' policy
 * works with no inline hashes. Loaded only inside /admin.
 *
 * Every form on the admin works without this file. What it adds is the
 * confirmation on destructive actions, the print button, and client-side
 * image resizing.
 */

/* ------------------------------------------------------------------ */
/* Confirmations                                                       */
/* ------------------------------------------------------------------ */

function initConfirmations() {
  document.querySelectorAll('form[data-confirm-archive]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      const heading = document.querySelector('h1');
      const name = heading ? heading.textContent.trim() : 'this record';
      const message = form.dataset.confirmArchive
        || `Archive ${name}? It will disappear from the website right away. You can turn it back on later.`;
      if (!confirm(message)) event.preventDefault();
    });
  });

  document.querySelectorAll('form[data-confirm-reset]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!confirm('Put every colour, font and size back to the original Pocket Perks look?')) {
        event.preventDefault();
      }
    });
  });

  document.querySelectorAll('form[data-confirm-delete]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!confirm(form.dataset.confirmDelete || 'Remove this link from the site?')) {
        event.preventDefault();
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Print                                                               */
/* ------------------------------------------------------------------ */

function initPrint() {
  document.querySelectorAll('[data-print]').forEach((button) => {
    button.addEventListener('click', () => window.print());
  });
}

/* ------------------------------------------------------------------ */
/* Image upload                                                        */
/* ------------------------------------------------------------------ */

/**
 * Resize and re-encode in the browser before uploading.
 *
 * Three jobs at once: a 12 MP phone photo becomes a few hundred kilobytes
 * instead of crossing the network at full size; the output is WebP whatever
 * went in; and because the bytes come out of the canvas encoder, EXIF
 * (including GPS coordinates from a phone) and anything hidden inside the
 * original container are gone by construction.
 *
 * Only ever scaled down, never cropped: the whole image is kept.
 */
async function encode(bitmap, maxEdge, quality) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  if (!blob) throw new Error('encode failed');
  return { blob, width, height };
}

/**
 * Smaller copies for phones. Cards are roughly 360px wide, which is ~720
 * real pixels on a typical phone screen and ~1100 on a sharp one, so those
 * are the two sizes made. Each is only made when it is meaningfully smaller
 * than the image being uploaded.
 */
const VARIANT_EDGES = [640, 1200];

function sizeWarning(kind, width, height) {
  const ratio = width / height;
  const notes = [];
  const shortEdge = Math.min(width, height);
  if (kind === 'logo' ? Math.max(width, height) < 240 : width < 600) {
    notes.push(`This image is small (${width} × ${height} pixels). It will show, but may look soft — a larger version would be sharper.`);
  }
  if (ratio > 4 || ratio < 0.25) {
    notes.push(`This image is very ${ratio > 1 ? 'wide' : 'tall'}. It will be shown whole, with plain space around it on cards. A less extreme version will appear larger.`);
  }
  if (!notes.length && shortEdge < 1) notes.push('That image has no size.');
  return notes.join(' ');
}

/** Rebuilds a preview frame around a local image, matching MediaFrame. */
function fillPreview(container, url, width, height, kind) {
  const frame = container.querySelector('.mf');
  if (!frame) return;
  frame.style.setProperty('--ar', (width / height).toFixed(4));
  frame.style.setProperty('--nw', `${width}px`);
  frame.style.setProperty('--nh', `${height}px`);
  frame.classList.remove('is-empty', 'is-broken');
  const fallback = frame.querySelector('.mf-fallback');
  if (fallback) fallback.hidden = true;
  frame.querySelectorAll('img').forEach((img) => img.remove());
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.width = width;
  img.height = height;
  frame.prepend(img);
  frame.classList.toggle('mf-logo', kind === 'logo');
}

function initUploads() {
  document.querySelectorAll('[data-upload]').forEach((root) => {
    const fileInput = root.querySelector('[data-file]');
    const idInput = root.querySelector('[data-media-id]');
    const altInput = root.querySelector('[data-alt]');
    const previews = root.querySelector('[data-previews]');
    const empty = root.querySelector('[data-preview-empty]');
    const warning = root.querySelector('[data-warning]');
    const clearButton = root.querySelector('[data-clear]');
    const status = root.querySelector('.upload-status');
    if (!fileInput || !idInput || !status) return;

    const kind = root.dataset.kind || 'photo';
    const maxEdge = parseInt(root.dataset.maxEdge || '1200', 10);
    const form = root.closest('form');
    const say = (message, state) => { status.textContent = message; status.dataset.state = state; };
    const warn = (text) => { if (warning) { warning.textContent = text; warning.hidden = !text; } };
    let busy = false;

    // Saving while an upload is still in flight would save the old image.
    if (form) {
      form.addEventListener('submit', (event) => {
        if (busy) { event.preventDefault(); say('Wait for the image to finish uploading, then save.', 'error'); }
      });
    }

    if (clearButton) {
      clearButton.addEventListener('click', () => {
        idInput.value = '';
        if (previews) previews.hidden = true;
        if (empty) empty.hidden = false;
        clearButton.hidden = true;
        fileInput.value = '';
        warn('');
        say('Image removed. Save the form to apply it.', 'ok');
      });
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;

      if (file.size > 25000000) {
        say('That file is very large. Pick something under 25 MB.', 'error');
        fileInput.value = '';
        return;
      }

      busy = true;
      say('Preparing image…', 'busy');
      warn('');

      try {
        const bitmap = await createImageBitmap(file);
        const main = await encode(bitmap, maxEdge, 0.82);
        const variants = [];
        for (const edge of VARIANT_EDGES) {
          if (Math.max(main.width, main.height) > edge * 1.25) variants.push(await encode(bitmap, edge, 0.8));
        }
        bitmap.close();

        // Show it straight away, from the file itself.
        const localUrl = URL.createObjectURL(main.blob);
        root.querySelectorAll('[data-preview-card], [data-preview-page]').forEach((container) =>
          fillPreview(container, localUrl, main.width, main.height, kind));
        if (previews) previews.hidden = false;
        if (empty) empty.hidden = true;
        warn(sizeWarning(kind, main.width, main.height));

        const body = new FormData();
        body.append('file', main.blob, 'image.webp');
        body.append('width', String(main.width));
        body.append('height', String(main.height));
        variants.forEach((variant, index) => {
          body.append(`variant_${index}`, variant.blob, `image-${variant.width}.webp`);
          body.append(`variant_${index}_width`, String(variant.width));
          body.append(`variant_${index}_height`, String(variant.height));
        });
        body.append('alt_text', altInput ? altInput.value.trim() : '');

        say('Uploading…', 'busy');
        const response = await fetch('/api/admin/upload', { method: 'POST', body });
        const result = await response.json().catch(() => ({}));

        if (!response.ok || !result.media) {
          say(result.message || 'That did not upload. Try again.', 'error');
          fileInput.value = '';
          return;
        }

        idInput.value = result.media.id;
        if (clearButton) clearButton.hidden = false;
        say('Uploaded. Press Save to put it on the site.', 'ok');
      } catch {
        say('That image could not be read. Try a JPEG or PNG.', 'error');
        fileInput.value = '';
      } finally {
        busy = false;
      }
    });
  });
}

/* ------------------------------------------------------------------ */

/* Slider labels update as you drag, so the number is not a mystery until
   you save. */
function initRangeLabels() {
  document.querySelectorAll('input[type=range][id]').forEach((input) => {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (!label) return;
    const base = label.textContent.split('—')[0].trim();
    const render = () => { label.textContent = `${base} — ${input.value}%`; };
    input.addEventListener('input', render);
    render();
  });
}

/* Same isolation as the public site: one broken starter must not take the
   rest of the admin down with it. */
[
  ['confirmations', initConfirmations],
  ['slider labels', initRangeLabels],
  ['image upload', initUploads],
  ['print', initPrint],
].forEach(([name, start]) => {
  try {
    start();
  } catch (error) {
    console.error(`Pocket Perks admin: ${name} failed to start`, error);
  }
});
