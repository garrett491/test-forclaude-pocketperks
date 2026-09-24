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
 */
async function shrinkImage(file, maxEdge) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas unavailable');
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.82));
  if (!blob) throw new Error('encode failed');
  return { blob, width, height };
}

function initUploads() {
  document.querySelectorAll('[data-upload]').forEach((root) => {
    const fileInput = root.querySelector('[data-file]');
    const idInput = root.querySelector('[data-media-id]');
    const altInput = root.querySelector('[data-alt]');
    const preview = root.querySelector('[data-preview]');
    const clearButton = root.querySelector('[data-clear]');
    const status = root.querySelector('.upload-status');
    if (!fileInput || !idInput || !preview || !status) return;

    const maxEdge = parseInt(root.dataset.maxEdge || '1200', 10);
    const say = (message, state) => { status.textContent = message; status.dataset.state = state; };

    if (clearButton) {
      clearButton.addEventListener('click', () => {
        idInput.value = '';
        preview.innerHTML = '<span class="preview-empty">No image yet</span>';
        clearButton.hidden = true;
        fileInput.value = '';
        say('Image removed. Save the form to apply it.', 'ok');
      });
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;

      if (file.size > 25000000) {
        say('That file is enormous. Pick something under 25 MB.', 'error');
        fileInput.value = '';
        return;
      }

      say('Preparing image…', 'busy');

      try {
        const { blob, width, height } = await shrinkImage(file, maxEdge);

        const body = new FormData();
        body.append('file', blob, 'image.webp');
        body.append('width', String(width));
        body.append('height', String(height));
        body.append('alt_text', altInput ? altInput.value.trim() : '');

        say('Uploading…', 'busy');
        const response = await fetch('/api/admin/upload', { method: 'POST', body });
        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          say(result.message || 'That did not upload. Try again.', 'error');
          fileInput.value = '';
          return;
        }

        idInput.value = result.media.id;
        preview.innerHTML = '';
        const img = document.createElement('img');
        img.src = result.preview_url;
        img.alt = altInput ? altInput.value.trim() : '';
        img.width = 240;
        img.height = Math.round((height / width) * 240);
        preview.appendChild(img);
        if (clearButton) clearButton.hidden = false;

        say('Uploaded. Save the form to apply it.', 'ok');
      } catch {
        say('That image could not be processed. Try a different file.', 'error');
        fileInput.value = '';
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Password reset                                                      */
/*                                                                     */
/* The reset button lives in its own form so Enter in the password box  */
/* never triggers it. This copies whatever is typed in the email field  */
/* across, so the reset works without asking for the address twice.     */
/* ------------------------------------------------------------------ */

function initResetMirror() {
  const mirror = document.querySelector('[data-mirror-email]');
  const email = document.getElementById('email');
  if (!mirror || !email) return;

  const sync = () => { mirror.value = email.value; };
  email.addEventListener('input', sync);
  sync();

  const form = mirror.closest('form');
  if (form) {
    form.addEventListener('submit', (event) => {
      sync();
      if (!mirror.value.trim()) {
        event.preventDefault();
        email.focus();
        alert('Type your email address in the box above first, then press "Forgot your password?".');
      }
    });
  }
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
  ['password reset', initResetMirror],
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
