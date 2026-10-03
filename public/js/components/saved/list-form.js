// List form — the create/edit sheet for a saved places list. Reuses the
// proposal-form's pattern: present() sheet, per-field error slots, a form
// error area, and validation that mirrors the server's rules (saved/model.js)
// so the common mistakes fail fast without a round trip.
import { el } from '../dom.js';
import { button } from '../button.js';
import { present } from '../surface.js';
import { toast } from '../community/parts.js';
import { EMOJIS, visibilityNote } from './parts.js';
import * as saved from '../../services/saved.js';
import { t } from '../../i18n/index.js';

const NAME_MAX = 60;

const VISIBILITIES = ['private', 'link', 'public'];
const VISIBILITY_LABELS = {
  private: t('saved.visibilityPrivate'),
  link: t('saved.visibilityShared'),
  public: t('saved.visibilityPublic'),
};

function fieldError() {
  return el('p', {
    class: 'hidden text-xs text-danger',
    dataset: { fieldError: 'true' },
  });
}

function setError(node, message) {
  if (message) {
    node.textContent = message;
    node.classList.remove('hidden');
  } else {
    node.textContent = '';
    node.classList.add('hidden');
  }
}

function nameInput(value) {
  return el('input', {
    type: 'text',
    maxlength: String(NAME_MAX),
    value: value || '',
    placeholder: t('saved.formNamePlaceholder'),
    class:
      'w-full rounded-lg border border-line bg-surface px-3 py-2 text-base text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
    'aria-label': t('saved.formName'),
    dataset: { savedListName: 'true' },
  });
}

// The emoji palette: the list's emoji doubles as the map marker glyph for its
// places, so the palette is the whole curated set the server accepts.
function emojiPalette(selected) {
  let current = selected || EMOJIS[0];
  const grid = el('div', {
    class: 'grid grid-cols-8 gap-1.5',
    role: 'radiogroup',
    'aria-label': t('saved.formEmoji'),
    dataset: { savedEmojiPalette: 'true' },
  });
  for (const emoji of EMOJIS) {
    const cell = el('button', {
      type: 'button',
      class:
        'flex h-10 w-full items-center justify-center rounded-lg border border-line bg-surface text-xl hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
      'aria-pressed': 'false',
      'aria-label': t('saved.formEmojiAria').replace('{emoji}', emoji),
      title: emoji,
      onClick: () => select(emoji),
    }, [document.createTextNode(emoji)]);
    grid.appendChild(cell);
  }
  function render() {
    for (const cell of grid.children) {
      const active = cell.textContent === current;
      cell.setAttribute('aria-pressed', active ? 'true' : 'false');
      cell.classList.toggle('bg-accent-soft', active);
      cell.classList.toggle('border-brand', active);
    }
  }
  function select(emoji) {
    current = emoji;
    render();
  }
  render();
  grid.dataset.value = current;
  const proxy = { value: () => current, node: grid };
  return proxy;
}

// The visibility selector: three labelled pills with the level's meaning
// spelled out underneath, updated as the selection changes.
function visibilityPicker(selected) {
  let current = selected || 'private';
  const group = el('div', {
    class: 'flex gap-1 rounded-pill bg-surface-raised p-1',
    role: 'radiogroup',
    'aria-label': t('saved.formVisibility'),
    dataset: { savedVisibilityPicker: 'true' },
  });
  for (const visibility of VISIBILITIES) {
    const pill = el('button', {
      type: 'button',
      class:
        'flex-1 rounded-pill px-3 py-1.5 text-sm font-medium text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
      'aria-pressed': 'false',
      'aria-label': VISIBILITY_LABELS[visibility],
      onClick: () => select(visibility),
    }, [VISIBILITY_LABELS[visibility]]);
    group.appendChild(pill);
  }
  const note = el('p', {
    class: 'text-xs text-muted leading-relaxed',
    dataset: { savedVisibilityNote: 'true' },
  });
  function render() {
    for (const pill of group.children) {
      const active = pill.textContent === VISIBILITY_LABELS[current];
      pill.setAttribute('aria-pressed', active ? 'true' : 'false');
      pill.classList.toggle('bg-surface', active);
      pill.classList.toggle('text-ink', active);
      pill.classList.toggle('shadow-sm', active);
    }
    note.textContent = visibilityNote(current);
  }
  function select(visibility) {
    current = visibility;
    render();
  }
  render();
  return { value: () => current, node: group, note };
}

// Open the sheet. Without `list` it creates; with it, the same form edits the
// existing values. `onSaved(card)` fires after the server has accepted.
export function openListForm({ list = null, onSaved } = {}) {
  const nameErr = fieldError();
  const formErr = el('p', { class: 'hidden text-sm text-danger', dataset: { formError: 'true' } });
  const emoji = emojiPalette(list ? list.emoji : null);
  const visibility = visibilityPicker(list ? list.visibility : 'private');

  const submitBtn = button(list ? t('common.save') : t('saved.formCreate'), { variant: 'primary' });
  const cancelBtn = button(t('common.cancel'), { variant: 'secondary', onClick: () => surface.dismiss() });
  const form = el('form', {
    class: 'flex flex-col gap-4',
    dataset: { savedListForm: 'true' },
    onSubmit: (event) => {
      event.preventDefault();
      submit();
    },
  }, [
      el('h2', { class: 'text-lg font-semibold text-ink', text: list ? t('saved.formEditTitle') : t('saved.formNewTitle') }),
      el('div', { class: 'flex flex-col gap-1.5' }, [
        el('label', { class: 'text-sm font-medium text-ink', text: t('saved.formName') }),
        nameInput(list ? list.name : ''),
        nameErr,
      ]),
      el('div', { class: 'flex flex-col gap-1.5' }, [
        el('p', { class: 'text-sm font-medium text-ink', text: t('saved.formEmoji') }),
        emoji.node,
      ]),
      el('div', { class: 'flex flex-col gap-1.5' }, [
        el('p', { class: 'text-sm font-medium text-ink', text: t('saved.formVisibility') }),
        visibility.node,
        visibility.note,
      ]),
      formErr,
      el('div', { class: 'flex flex-col gap-2 pt-1' }, [submitBtn, cancelBtn]),
    ]);

  const surface = present(form, { label: list ? t('saved.formEditTitle') : t('saved.formNewTitle') });

  const nameField = form.querySelector('[data-saved-list-name]');

  async function submit() {
    const name = nameField.value.trim();
    let bad = false;
    if (!name) {
      setError(nameErr, t('saved.formNameRequired'));
      bad = true;
    } else if (name.length > NAME_MAX) {
      setError(nameErr, t('saved.formNameTooLong'));
      bad = true;
    } else {
      setError(nameErr, null);
    }
    setError(formErr, null);
    if (bad) return;

    const payload = { name, emoji: emoji.value(), visibility: visibility.value() };
    submitBtn.disabled = true;
    try {
      const cardSaved = list
        ? await saved.updateList(list.id, payload)
        : await saved.createList(payload);
      surface.dismiss();
      if (onSaved) onSaved(cardSaved);
    } catch (err) {
      // Server-side validation answers with per-field errors; show them on
      // the fields they name and everything else on the form error line.
      const fields = err && err.fields;
      if (fields && fields.name) setError(nameErr, fields.name);
      else setError(formErr, (err && err.message) || t('error.somethingWentWrong'));
      submitBtn.disabled = false;
    }
  }

  submitBtn.addEventListener('click', submit);
  nameField.addEventListener('input', () => setError(nameErr, null));
  return surface;
}