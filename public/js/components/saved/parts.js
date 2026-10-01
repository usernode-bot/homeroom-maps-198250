// Small shared pieces of the saved-places UI: the curated emoji palette,
// the emoji badge (which is also the future map marker glyph) and the
// visibility pill. Pill and badge classes are whole literals so the Tailwind
// extractor sees them.
import { el } from '../dom.js';
import { button } from '../button.js';
import { t } from '../../i18n/index.js';

// The palette the list form offers. Keep in step with the server's curated
// set (saved/model.js EMOJIS): the server refuses anything else, so the
// palette is the single source of what a person can pick.
export const EMOJIS = [
  '⭐', '🧭', '✈️', '🍴', '☕', '🥐', '🌅', '🌊',
  '🏛️', '🌳', '⛰️', '🏖️', '🎡', '🛍️', '🎨', '🎭',
  '🍺', '🍜', '🚲', '⛺', '📸', '💗', '🗺️', '🏪',
];

// The emoji badge. This is the glyph every item of the list carries and the
// glyph the map phase will draw as the list's marker.
export function emojiBadge(emoji, { class: extra = 'h-12 w-12 text-2xl' } = {}) {
  return el('span', {
    class: `flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface-raised ${extra}`,
    text: emoji || EMOJIS[0],
    'aria-hidden': 'true',
    dataset: { savedEmoji: emoji || EMOJIS[0] },
  });
}

const VISIBILITY_CLASSES = {
  private: 'bg-surface-raised text-muted',
  link: 'bg-accent-soft text-accent',
  public: 'bg-accent-soft text-accent',
};

const VISIBILITY_KEYS = {
  private: 'saved.visibilityPrivate',
  link: 'saved.visibilityShared',
  public: 'saved.visibilityPublic',
};

export function visibilityPill(visibility) {
  return el('span', {
    class: `inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-xs font-medium ${VISIBILITY_CLASSES[visibility] || VISIBILITY_CLASSES.private}`,
    text: t(VISIBILITY_KEYS[visibility] || VISIBILITY_KEYS.private),
    dataset: { savedVisibility: visibility },
  });
}

export function visibilityNote(visibility) {
  const keys = {
    private: 'saved.visibilityPrivateNote',
    link: 'saved.visibilitySharedNote',
    public: 'saved.visibilityPublicNote',
  };
  return t(keys[visibility] || keys.private);
}

// Two-step destructive confirmation, used for deleting a list and removing a
// place: the first tap swaps the button into its confirm state, a second tap
// commits, and anything else (blur, a tap elsewhere) disarms it. No
// window.confirm, matching the rest of the app.
export function confirmableButton(label, confirmLabel, { variant = 'secondary', onConfirm }) {
  let armed = false;
  const btn = button(label, {
    variant,
    onClick: () => {
      if (!armed) {
        armed = true;
        apply();
        return;
      }
      onConfirm();
    },
  });
  // The confirm state is applied by updating the button in place: swapping the
  // node would fire focusout on the removed (still focused) element and disarm
  // the button the same instant it armed.
  btn.addEventListener('focusout', () => {
    if (armed) {
      armed = false;
      apply();
    }
  });
  function apply() {
    btn.textContent = armed ? confirmLabel : label;
  }
  return btn;
}