// Search bar — the input the whole search flow starts from.
//
// Rebuilt in place is not an option for the input itself (it would drop the
// caret on every keystroke), so this component is created once per screen and
// updated in place via update(state). The clear button and the spinner live
// on top of the input's right edge and are shown/hidden by toggling `hidden`.
//
// Combobox semantics per ARIA: the input is role="combobox", the results
// panel (built by search-results.js) is its listbox, and keyboard focus
// management uses aria-activedescendant so the input never loses the caret.
import { el } from '../dom.js';
import { icon } from '../icons.js';

export function createSearchBar({ onInput, onFocus, onBlur, onKeydown, onClear }) {
  const input = el('input', {
    type: 'search',
    dataset: { searchInput: 'true' },
    placeholder: 'Search places',
    'aria-label': 'Search places',
    role: 'combobox',
    'aria-autocomplete': 'list',
    'aria-expanded': 'false',
    'aria-controls': 'hm-search-listbox',
    class:
      'w-full rounded-pill border border-line bg-surface px-4 py-3 pr-11 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-70',
  });
  input.addEventListener('input', () => onInput(input.value));
  input.addEventListener('focus', onFocus);
  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', onKeydown);

  // Clear (X). preventDefault on mousedown keeps the input focused, so the
  // panel does not flicker closed and reopened while clicking it.
  const clearBtn = el(
    'button',
    {
      type: 'button',
      class:
        'absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
      'aria-label': 'Clear',
      dataset: { searchClear: 'true' },
    },
    [icon('close', { class: 'h-4 w-4' })],
  );
  clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
  clearBtn.addEventListener('click', () => onClear());

  const root = el('div', { class: 'relative' }, [input, clearBtn]);

  function update(state) {
    if (input.value !== state.query) input.value = state.query;
    input.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    const showClear = state.query.length > 0;
    clearBtn.classList.toggle('hidden', !showClear);
    // Point at the keyboard-highlighted option while the listbox is open.
    if (state.open && state.highlighted >= 0) {
      input.setAttribute('aria-activedescendant', `hm-search-opt-${state.highlighted}`);
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  update({ query: '', open: false, highlighted: -1 });

  return { root, input, update };
}