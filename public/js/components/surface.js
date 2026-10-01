// Present a piece of UI over the current screen: the native kit's bottom
// sheet on touch devices and its centered modal on desktop. When the kit did
// not load (standalone, blocked), a plain overlay keeps the flow usable.
// Returns { dismiss() }; onDismiss runs once however it closes.
import { el } from './dom.js';
import { icon } from './icons.js';

export function present(contentEl, { onDismiss, label = 'Dialog' } = {}) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (onDismiss) onDismiss();
  };
  const kit = window.unNative;
  const desktop = document.documentElement.classList.contains('un-desktop');
  if (kit && typeof kit.presentModal === 'function' && typeof kit.presentSheet === 'function') {
    try {
      const handle = (desktop ? kit.presentModal : kit.presentSheet)({ contentEl, onDismiss: finish });
      return { dismiss: () => handle.dismiss() };
    } catch (err) {
      console.warn('[surface] native kit failed, using the plain overlay', err);
    }
  }
  return fallbackOverlay(contentEl, finish, label);
}

function fallbackOverlay(contentEl, finish, label) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    finish();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const closeBtn = el(
    'button',
    {
      type: 'button',
      class: 'un-touch-target absolute right-3 top-3 rounded-pill p-1 text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
      'aria-label': 'Close',
      onClick: close,
    },
    [icon('close', { class: 'h-5 w-5' })],
  );
  const panel = el(
    'div',
    {
      class: 'relative max-h-full w-full max-w-lg overflow-y-auto rounded-card border border-line bg-surface p-4',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': label,
    },
    [closeBtn, contentEl],
  );
  const overlay = el('div', { class: 'fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center' }, [panel]);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  return { dismiss: close };
}
