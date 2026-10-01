// Create or edit a proposal. Presented over the Community screen.
//
// Create offers Publish (primary) and Save draft; edit offers Save changes.
// The server is the judge of what is valid: its per-field messages are shown
// beside each field, and nothing is saved until it says so.
//
// Location is picked from the app's own place search, or the device location.
// Photos go through the platform's file storage (usernode.uploadFile) and only
// the returned URL is kept; outside Homeroom there is nowhere to store them,
// so the control says so instead of failing.
import { el } from '../dom.js';
import { button } from '../button.js';
import { icon } from '../icons.js';
import { spinner } from '../loading.js';
import { present } from '../surface.js';
import { toast } from './parts.js';
import { fetchSuggest } from '../../services/search.js';
import { locateOnce } from '../../services/location.js';
import { createProposal, updateProposal } from '../../services/community.js';

const INPUT =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';
const MAX_EDGE = 2048;
const MAX_UPLOAD_BYTES = 4.5 * 1024 * 1024;

// Downscale large camera photos before upload; the platform does no resizing
// and caps files at 5 MB. Small images pass through untouched.
async function prepareImage(file) {
  if (file.size <= MAX_UPLOAD_BYTES && file.type !== 'image/heic') {
    try {
      const bmp = await createImageBitmap(file);
      const fits = Math.max(bmp.width, bmp.height) <= MAX_EDGE;
      bmp.close();
      if (fits) return file;
    } catch {
      return file; // let the platform's own validation answer
    }
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  const name = (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name, { type: 'image/jpeg' });
}

function field(label, control, key, hint) {
  const error = el('p', { class: 'hidden text-xs text-danger', dataset: { fieldError: key }, role: 'alert' });
  return {
    node: el('div', { class: 'flex flex-col gap-1.5' }, [
      el('label', { class: 'text-sm font-medium text-ink', for: control.id || null, text: label }),
      hint ? el('p', { class: 'text-xs text-muted', text: hint }) : null,
      control,
      error,
    ]),
    error,
  };
}

// opts: { meta, proposal?, onSaved(proposal, how) }
export function openProposalForm({ meta, proposal = null, onSaved }) {
  const editing = Boolean(proposal);
  let location = proposal ? proposal.location : null;
  let attachments = proposal ? proposal.attachments.slice() : [];
  let busy = false;
  let surface = null;

  const category = el(
    'select',
    { id: 'proposal-category', class: INPUT, dataset: { proposalCategory: 'true' } },
    [
      el('option', { value: '', text: 'Choose a category' }),
      ...meta.categories.map((c) => el('option', { value: c.id, text: c.label })),
    ],
  );
  if (proposal) category.value = proposal.category;

  const title = el('input', {
    id: 'proposal-title',
    class: INPUT,
    type: 'text',
    maxlength: String(meta.limits.titleMax),
    placeholder: 'For example: Add the corner bakery',
    dataset: { proposalTitle: 'true' },
  });
  if (proposal) title.value = proposal.title;

  const description = el('textarea', {
    id: 'proposal-description',
    class: `${INPUT} min-h-28`,
    rows: '5',
    maxlength: String(meta.limits.descriptionMax),
    placeholder: 'What is wrong or missing, and how do you know?',
    dataset: { proposalDescription: 'true' },
  });
  if (proposal) description.value = proposal.description;

  // ── location ──
  const locSearch = el('input', {
    id: 'proposal-location',
    class: INPUT,
    type: 'search',
    placeholder: 'Search for a place or address',
    autocomplete: 'off',
    dataset: { proposalLocation: 'true' },
  });
  const locResults = el('div', { class: 'hidden flex-col divide-y divide-line rounded-lg border border-line', role: 'listbox' });
  const locChosen = el('div', { class: 'hidden items-center justify-between gap-3 rounded-lg bg-surface-raised px-3 py-2' });
  const locateBtn = button('Use my location', { variant: 'ghost', class: 'self-start px-0' });
  const locWrap = el('div', { class: 'flex flex-col gap-2' }, [locSearch, locResults, locChosen, locateBtn]);

  function renderLocation() {
    if (location) {
      locSearch.classList.add('hidden');
      locResults.classList.add('hidden');
      locResults.classList.remove('flex');
      locChosen.classList.remove('hidden');
      locChosen.classList.add('flex');
      locChosen.replaceChildren(
        el('span', { class: 'flex min-w-0 items-center gap-2' }, [
          icon('pin', { class: 'h-4 w-4 shrink-0 text-muted' }),
          el('span', { class: 'truncate text-sm text-ink', text: location.name, dataset: { chosenLocation: 'true' } }),
        ]),
        button('Change', {
          variant: 'ghost',
          class: 'px-2 py-1',
          onClick: () => {
            location = null;
            renderLocation();
            locSearch.focus();
          },
        }),
      );
    } else {
      locSearch.classList.remove('hidden');
      locChosen.classList.add('hidden');
      locChosen.classList.remove('flex');
    }
  }

  let searchTimer = null;
  let searchSeq = 0;
  locSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = locSearch.value.trim();
    if (q.length < 2) {
      locResults.classList.add('hidden');
      locResults.classList.remove('flex');
      return;
    }
    searchTimer = setTimeout(async () => {
      const seq = ++searchSeq;
      locResults.replaceChildren(el('div', { class: 'flex justify-center p-3' }, [spinner()]));
      locResults.classList.remove('hidden');
      locResults.classList.add('flex');
      try {
        const results = await fetchSuggest(q, { limit: 5 });
        if (seq !== searchSeq) return;
        locResults.replaceChildren(
          ...(results.length
            ? results.map((r) =>
                el(
                  'button',
                  {
                    type: 'button',
                    role: 'option',
                    class: 'flex flex-col px-3 py-2 text-left hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                    onClick: () => {
                      location = { name: r.detail ? `${r.name}, ${r.detail}`.slice(0, 200) : r.name, lat: r.lat, lng: r.lon };
                      locSearch.value = '';
                      fLocation.error.classList.add('hidden');
                      renderLocation();
                    },
                  },
                  [
                    el('span', { class: 'truncate text-sm font-medium text-ink', text: r.name }),
                    el('span', { class: 'truncate text-xs text-muted', text: r.detail || '' }),
                  ],
                ),
              )
            : [el('p', { class: 'px-3 py-2 text-sm text-muted', text: 'No places match that search.' })]),
        );
      } catch (err) {
        if (seq !== searchSeq) return;
        locResults.replaceChildren(
          el('p', { class: 'px-3 py-2 text-sm text-muted', text: err.message || 'Place search is unavailable right now.' }),
        );
      }
    }, 250);
  });

  locateBtn.addEventListener('click', async () => {
    locateBtn.disabled = true;
    const pos = await locateOnce();
    locateBtn.disabled = false;
    if (!pos.ok) {
      toast(pos.message, { error: !pos.pending });
      return;
    }
    fLocation.error.classList.add('hidden');
    location = { name: `My location (${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)})`, lat: pos.lat, lng: pos.lng };
    renderLocation();
  });

  // ── photos ──
  const canUpload = typeof window.usernode?.uploadFile === 'function';
  const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'hidden' });
  const thumbs = el('div', { class: 'flex flex-wrap gap-2' });
  const addPhoto = button('Add photo', { variant: 'secondary', class: 'self-start', onClick: () => fileInput.click() });
  const photoNote = el('p', { class: 'text-xs text-muted' });

  function renderPhotos() {
    thumbs.replaceChildren(
      ...attachments.map((a, i) =>
        el('div', { class: 'relative' }, [
          el('img', { src: a.url, alt: a.filename || 'Attached photo', class: 'h-16 w-16 rounded-lg border border-line object-cover' }),
          el(
            'button',
            {
              type: 'button',
              class: 'absolute -right-2 -top-2 rounded-pill border border-line bg-surface p-0.5 text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
              'aria-label': 'Remove photo',
              onClick: () => {
                attachments.splice(i, 1);
                renderPhotos();
              },
            },
            [icon('close', { class: 'h-3.5 w-3.5' })],
          ),
        ]),
      ),
    );
    const full = attachments.length >= meta.limits.attachmentsMax;
    addPhoto.disabled = !canUpload || full;
    photoNote.textContent = !canUpload
      ? 'Photo uploads work when Homeroom Maps is opened inside Homeroom.'
      : full
        ? `You can attach up to ${meta.limits.attachmentsMax} photos.`
        : 'Optional. PNG, JPEG, GIF or WebP.';
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    addPhoto.disabled = true;
    photoNote.textContent = 'Uploading photo';
    try {
      const stored = await window.usernode.uploadFile(await prepareImage(file), { visibility: 'public' });
      attachments.push({ url: stored.url, filename: stored.filename, contentType: stored.contentType });
    } catch (err) {
      toast((err && err.message) || 'The photo could not be uploaded.', { error: true });
    }
    renderPhotos();
  });

  // ── assembly ──
  const fCategory = field('Category', category, 'category');
  const fTitle = field('Title', title, 'title');
  const fDescription = field('Description', description, 'description');
  const fLocation = field('Location', locWrap, 'location', 'Needed for everything except map improvements.');
  const fAttachments = field('Photos', el('div', { class: 'flex flex-col gap-2' }, [thumbs, addPhoto, photoNote, fileInput]), 'attachments');
  const fieldErrors = { category: fCategory, title: fTitle, description: fDescription, location: fLocation, attachments: fAttachments };
  // A field's message goes away as soon as the person changes that field.
  const clearOn = (control, key) =>
    control.addEventListener(control.tagName === 'SELECT' ? 'change' : 'input', () => {
      fieldErrors[key].error.classList.add('hidden');
    });
  const formError = el('p', { class: 'hidden text-sm text-danger', role: 'alert', dataset: { formError: 'true' } });

  clearOn(category, 'category');
  clearOn(title, 'title');
  clearOn(description, 'description');

  function showErrors(err) {
    for (const f of Object.values(fieldErrors)) {
      f.error.classList.add('hidden');
      f.error.textContent = '';
    }
    formError.classList.add('hidden');
    if (err && err.fields) {
      for (const [key, msg] of Object.entries(err.fields)) {
        if (!fieldErrors[key]) continue;
        fieldErrors[key].error.textContent = msg;
        fieldErrors[key].error.classList.remove('hidden');
      }
    }
    if (err) {
      formError.textContent = err.message || 'Something went wrong. Please try again.';
      formError.classList.remove('hidden');
    }
  }

  async function submit(how) {
    if (busy) return;
    busy = true;
    actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
    showErrors(null);
    const values = {
      category: category.value,
      title: title.value,
      description: description.value,
      location,
      attachments,
    };
    try {
      const saved = editing
        ? await updateProposal(proposal.id, values)
        : await createProposal(values, { publish: how === 'publish' });
      surface.dismiss();
      toast(editing ? 'Changes saved' : how === 'publish' ? 'Published' : 'Draft saved');
      if (onSaved) onSaved(saved, editing ? 'edit' : how);
    } catch (err) {
      showErrors(err);
    } finally {
      busy = false;
      actions.querySelectorAll('button').forEach((b) => (b.disabled = false));
      renderPhotos();
    }
  }

  const actions = el(
    'div',
    { class: 'flex flex-wrap justify-end gap-2 pt-2' },
    editing
      ? [button('Save changes', { onClick: () => submit('save') })]
      : [
          button('Save draft', { variant: 'secondary', onClick: () => submit('draft') }),
          button('Publish', { onClick: () => submit('publish') }),
        ],
  );

  const content = el('form', { class: 'flex flex-col gap-4 p-1', dataset: { proposalForm: editing ? 'edit' : 'create' }, novalidate: true }, [
    el('h2', { class: 'text-lg font-semibold text-ink', text: editing ? 'Edit proposal' : 'New proposal' }),
    editing
      ? null
      : el('p', {
          class: 'text-sm text-muted leading-relaxed',
          text: 'Publish to open it for votes now, or save a draft that only you can see.',
        }),
    fCategory.node,
    fTitle.node,
    fDescription.node,
    fLocation.node,
    fAttachments.node,
    formError,
    actions,
  ]);
  content.addEventListener('submit', (e) => e.preventDefault());

  renderLocation();
  renderPhotos();
  surface = present(content, { label: editing ? 'Edit proposal' : 'New proposal' });
  return surface;
}
