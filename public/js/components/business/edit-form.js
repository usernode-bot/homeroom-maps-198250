// The owner's business profile edit form (Phase 12J). Rendered inline on the
// Business dashboard under the profile it edits: no modal, no sheet, just an
// expandable form like the community forms. The server is the judge of what
// is valid; its per-field messages are shown beside each field.
import { el } from '../dom.js';
import { button } from '../button.js';
import { t } from '../../i18n/index.js';
import { updateProfile } from '../../services/business.js';

const INPUT =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

function field(label, control, key) {
  const error = el('p', { class: 'hidden text-xs text-danger', dataset: { fieldError: key }, role: 'alert' });
  return {
    node: el('div', { class: 'flex flex-col gap-1.5' }, [
      el('label', { class: 'text-sm font-medium text-ink', for: control.id || null, text: label }),
      control,
      error,
    ]),
    error,
  };
}

function textControl(value, { multiline = false } = {}) {
  const node = el(multiline ? 'textarea' : 'input', {
    id: `business-edit-${Math.random().toString(36).slice(2, 8)}`,
    class: multiline ? `${INPUT} min-h-24` : INPUT,
    rows: multiline ? 3 : undefined,
  });
  node.value = value == null ? '' : String(value);
  return node;
}

// opts: { profile, onSaved(profile) }
export function createEditForm({ profile, onSaved } = {}) {
  let busy = false;
  let onCancel = null;

  const formError = el('p', { class: 'hidden text-xs text-danger', role: 'alert' });

  const name = textControl(profile.name);
  const address = textControl(profile.address);
  const category = textControl(profile.category);
  const description = textControl(profile.description, { multiline: true });
  const phone = textControl(profile.phone);
  const website = textControl(profile.website);
  const hours = textControl(profile.hours, { multiline: true });

  const fields = {
    name: field(t('business.form.name'), name, 'name'),
    address: field(t('business.form.address'), address, 'address'),
    category: field(t('business.form.category'), category, 'category'),
    description: field(t('business.form.description'), description, 'description'),
    phone: field(t('business.form.phone'), phone, 'phone'),
    website: field(t('business.form.website'), website, 'website'),
    hours: field(t('business.form.hours'), hours, 'hours'),
  };

  const saveBtn = button(t('business.form.save'), {
    attrs: { 'data-business-save': 'true' },
    onClick: () => save(),
  });
  const cancelBtn = button(t('common.cancel'), {
    variant: 'secondary',
    attrs: { 'data-business-cancel': 'true' },
    onClick: () => onCancel && onCancel(),
  });

  const root = el(
    'form',
    {
      class: 'flex flex-col gap-3 rounded-card border border-line bg-surface p-3',
      dataset: { businessEditForm: 'true' },
      onSubmit: (e) => e.preventDefault(),
    },
    [
      fields.name.node,
      fields.address.node,
      fields.category.node,
      fields.description.node,
      fields.phone.node,
      fields.website.node,
      fields.hours.node,
      formError,
      el('div', { class: 'flex flex-wrap gap-2' }, [saveBtn, cancelBtn]),
    ],
  );

  root.setCancel = (fn) => {
    onCancel = fn;
  };

  function showFieldErrors(fieldsObj) {
    for (const [key, f] of Object.entries(fields)) {
      const message = (fieldsObj && fieldsObj[key]) || null;
      f.error.textContent = message || '';
      f.error.classList.toggle('hidden', !message);
    }
  }

  async function save() {
    if (busy) return;
    busy = true;
    saveBtn.disabled = true;
    formError.classList.add('hidden');
    showFieldErrors(null);
    const patch = {
      name: name.value,
      address: address.value,
      category: category.value,
      description: description.value,
      phone: phone.value,
      website: website.value,
      hours: hours.value,
    };
    try {
      const updated = await updateProfile(profile.id, patch);
      if (onSaved) onSaved(updated);
    } catch (err) {
      showFieldErrors((err && err.fields) || null);
      formError.textContent = (err && err.message) || t('business.actionFailed');
      formError.classList.remove('hidden');
    } finally {
      busy = false;
      saveBtn.disabled = false;
    }
  }

  return { root, showFieldErrors };
}
