// Save button — the one control for saving and unsaving a place.
//
// It reflects the REAL state: `isSaved` asks the server for this user and this
// place, and every press re-renders from what the server answered. Loading,
// busy, saved and error are distinct states; nothing here shows a saved place
// the server did not confirm.
//
// The button does not own any list UI: filing a place into a list is the list
// picker's job (components/saved/list-picker.js), presented from the same row.
import { el } from '../dom.js';
import { icon } from '../icons.js';
import { spinner } from '../loading.js';
import { t } from '../../i18n/index.js';
import { savedPlaces } from '../../services/saved-places.js';

export function createSaveButton(place, { initiallySaved, onChange, onError } = {}) {
  // 'unknown' until the first real answer; `initiallySaved` (a Set the screen
  // already fetched) skips the per-place round trip.
  let state = typeof initiallySaved === 'boolean' ? (initiallySaved ? 'saved' : 'idle') : 'loading';
  let busy = false;

  const node = el('button', {
    type: 'button',
    class:
      'un-touch-target inline-flex items-center gap-1.5 rounded-pill border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60',
    dataset: { saveButton: place.id },
  });

  function paint() {
    const saved = state === 'saved';
    node.replaceChildren(
      busy || state === 'loading'
        ? spinner()
        : icon(saved ? 'check' : 'bookmark', { class: 'h-4 w-4' }),
      el('span', {
        text:
          state === 'loading'
            ? t('saved.checking')
            : busy
              ? t('saved.saving')
              : saved
                ? t('saved.saved')
                : t('saved.save'),
      }),
    );
    node.setAttribute('aria-pressed', saved ? 'true' : 'false');
    node.setAttribute('aria-label', saved ? t('saved.unsaveLabel') : t('saved.saveLabel'));
    node.disabled = busy || state === 'loading';
  }

  function fail(err) {
    state = 'error';
    paint();
    if (onError) onError(err);
    else if (window.unNative && window.unNative.toast) {
      window.unNative.toast((err && err.message) || t('saved.saveError'), { priority: true });
    }
    // Return to a usable control: the next press retries.
    setTimeout(() => {
      if (state === 'error') {
        state = 'idle';
        paint();
      }
    }, 1200);
  }

  async function check() {
    try {
      const saved = await savedPlaces.isSaved(place.id);
      state = saved ? 'saved' : 'idle';
    } catch {
      // A failed check must not claim "not saved": show the idle action so the
      // person can try again, without asserting a state we did not confirm.
      state = 'idle';
    }
    paint();
  }

  async function toggle() {
    if (busy) return;
    busy = true;
    paint();
    const wasSaved = state === 'saved';
    try {
      if (wasSaved) await savedPlaces.unsave(place.id);
      else await savedPlaces.save(place);
      busy = false;
      state = wasSaved ? 'idle' : 'saved';
      paint();
      if (onChange) onChange(state === 'saved');
    } catch (err) {
      busy = false;
      fail(err);
    }
  }

  node.addEventListener('click', toggle);
  paint();
  if (state === 'loading') check();
  return node;
}
