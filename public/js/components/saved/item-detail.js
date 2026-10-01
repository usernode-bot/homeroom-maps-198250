// Item detail — one place inside a list: the Place Card built from the saved
// snapshot, the owner's note, and the comment thread any viewer of the list
// can join. The owner can edit the note and remove the place; the thread is
// the same for everyone the list is visible to. Everything is driven by the
// real API (services/saved.js); nothing here invents a note or a comment.
import { el } from '../dom.js';
import { button } from '../button.js';
import { errorState } from '../error-state.js';
import { createPlaceCard } from '../place/place-card.js';
import { toast, timeAgo } from '../community/parts.js';
import { confirmableButton } from './parts.js';
import * as saved from '../../services/saved.js';
import { t } from '../../i18n/index.js';

const NOTE_MAX = 500;
const COMMENT_MAX = 1000;

function sectionHeading(text) {
  return el('p', {
    class: 'text-xs font-medium uppercase tracking-wide text-muted',
    text,
  });
}

function pillBackButton(label, onClick) {
  return el('button', {
    type: 'button',
    class:
      'rounded-pill border border-line bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
    dataset: { savedItemBack: 'true' },
    onClick,
  }, [label]);
}

export function createItemDetailView({ list, item, viewer, key = null, onBack, onItemRemoved }) {
  const isOwner = Boolean(viewer && viewer.isOwner);

  const root = el('div', {
    class: 'flex flex-col gap-4',
    dataset: { savedItemDetail: String(item.id) },
  });

  // --- header: back + the Place Card projection of the snapshot ---
  const place = {
    id: item.id,
    name: item.place.name,
    address: item.place.address,
    category: null,
    subcategory: item.place.kind,
    coordinates: { lat: item.place.lat, lon: item.place.lng },
    photos: [],
    dataSource: item.place.provider || 'unknown',
  };
  const headerCard = createPlaceCard(place, {});
  headerCard.setAttribute('data-saved-item-header', 'true');
  headerCard.setAttribute('aria-label', `${item.place.name}: ${t('saved.itemDetailAria')}`);
  root.appendChild(pillBackButton(t('common.back'), () => onBack && onBack()));
  root.appendChild(headerCard);

  if (item.source === 'suggestion' && item.addedBy) {
    root.appendChild(el('p', {
      class: 'text-xs text-muted',
      text: t('saved.suggestedBy').replace('{name}', item.addedBy.username),
    }));
  }

  // --- note ---
  const noteSection = el('section', { class: 'flex flex-col gap-2', dataset: { savedNote: 'true' } });
  root.appendChild(noteSection);

  const noteField = el('textarea', {
    rows: '3',
    maxlength: String(NOTE_MAX),
    class:
      'w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
    'aria-label': t('saved.note'),
    placeholder: t('saved.noteOwnerPlaceholder'),
    dataset: { savedNoteField: 'true' },
  });
  noteField.value = item.note || '';
  const noteErr = el('p', { class: 'hidden text-xs text-danger', dataset: { savedNoteError: 'true' } });
  const saveNoteBtn = button(t('common.save'), {
    variant: 'secondary',
    class: 'self-start',
    onClick: saveNote,
  });

  function renderNote() {
    if (isOwner) {
      noteSection.replaceChildren(
        sectionHeading(t('saved.note')),
        noteField,
        noteErr,
        el('p', { class: 'text-xs text-muted', text: t('saved.noteOwnerHint') }),
        saveNoteBtn,
      );
    } else if (item.note) {
      noteSection.replaceChildren(
        sectionHeading(t('saved.note')),
        el('p', { class: 'text-sm text-ink leading-relaxed', text: item.note }),
      );
    } else {
      noteSection.replaceChildren();
      noteSection.classList.add('hidden');
    }
  }

  async function saveNote() {
    const note = noteField.value.trim();
    if (note.length > NOTE_MAX) {
      noteErr.textContent = t('saved.noteTooLong');
      noteErr.classList.remove('hidden');
      return;
    }
    saveNoteBtn.disabled = true;
    try {
      await saved.updateNote(list.id, item.id, note || null);
      item.note = note || null;
      renderNote();
      toast(t('saved.noteSaved'));
    } catch (err) {
      noteErr.textContent = (err && err.message) || t('error.somethingWentWrong');
      noteErr.classList.remove('hidden');
    } finally {
      saveNoteBtn.disabled = false;
    }
  }

  renderNote();

  // --- comments ---
  const commentsSection = el('section', { class: 'flex flex-col gap-2', dataset: { savedComments: 'true' } });
  root.appendChild(commentsSection);

  const commentsHeading = el('p', {
    class: 'text-xs font-medium uppercase tracking-wide text-muted',
    dataset: { savedCommentsHeading: 'true' },
  });
  const commentsList = el('div', { class: 'flex flex-col gap-3', dataset: { savedCommentsList: 'true' } });
  const commentField = el('input', {
    type: 'text',
    maxlength: String(COMMENT_MAX),
    placeholder: t('saved.commentPlaceholder'),
    class:
      'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
    'aria-label': t('saved.commentPlaceholder'),
    dataset: { savedCommentField: 'true' },
  });
  const commentErr = el('p', { class: 'hidden text-xs text-danger', dataset: { savedCommentError: 'true' } });
  const postBtn = button(t('saved.postComment'), {
    variant: 'secondary',
    class: 'self-start',
    onClick: postComment,
  });

  commentsSection.append(
    commentsHeading,
    commentsList,
    el('div', { class: 'flex flex-col gap-2' }, [commentField, commentErr, postBtn]),
  );

  let comments = [];

  function canDelete(comment) {
    return isOwner || (viewer && comment.author && comment.author.id === viewer.id);
  }

  function renderComments() {
    commentsHeading.textContent = `${t('saved.comments')} (${comments.length})`;
    commentsList.replaceChildren(
      ...(comments.length
        ? comments.map((comment) =>
            el('div', { class: 'flex flex-col gap-0.5', dataset: { savedComment: comment.id } }, [
              el('div', { class: 'flex items-baseline gap-2' }, [
                el('span', { class: 'text-xs font-medium text-ink', text: comment.author.username }),
                el('span', { class: 'text-xs text-muted', text: timeAgo(comment.createdAt) }),
                canDelete(comment)
                  ? el('button', {
                      type: 'button',
                      class:
                        'ml-auto text-xs text-muted hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded',
                      'aria-label': t('saved.deleteComment'),
                      dataset: { savedDeleteComment: comment.id },
                      onClick: () => removeComment(comment),
                    }, [t('saved.delete')])
                  : null,
              ]),
              el('p', { class: 'text-sm text-ink leading-relaxed break-words', text: comment.body }),
            ]))
        : [el('p', { class: 'text-sm text-muted', text: t('saved.noComments'), dataset: { savedNoComments: 'true' } })]),
    );
  }

  async function loadComments() {
    try {
      comments = await saved.fetchComments(item.id, { key });
      renderComments();
    } catch {
      commentsList.replaceChildren(errorState({
        title: t('saved.commentsUnavailable'),
        description: null,
        onRetry: loadComments,
      }));
    }
  }

  async function postComment() {
    const body = commentField.value.trim();
    if (!body) {
      commentErr.textContent = t('saved.commentRequired');
      commentErr.classList.remove('hidden');
      return;
    }
    commentErr.classList.add('hidden');
    postBtn.disabled = true;
    try {
      const posted = await saved.addComment(item.id, body, { key });
      comments = comments.concat(posted);
      commentField.value = '';
      renderComments();
    } catch (err) {
      commentErr.textContent = (err && err.message) || t('error.somethingWentWrong');
      commentErr.classList.remove('hidden');
    } finally {
      postBtn.disabled = false;
    }
  }

  async function removeComment(comment) {
    try {
      await saved.deleteComment(comment.id);
      comments = comments.filter((c) => c.id !== comment.id);
      renderComments();
    } catch (err) {
      toast((err && err.message) || t('error.somethingWentWrong'), { error: true });
    }
  }

  // --- owner: remove the place ---
  if (isOwner) {
    root.appendChild(
      el('div', { class: 'border-t border-line pt-3', dataset: { savedItemOwnerActions: 'true' } }, [
        confirmableButton(t('saved.removePlace'), t('saved.removePlaceConfirm'), {
          variant: 'secondary',
          onConfirm: async () => {
            try {
              await saved.removePlace(list.id, item.id);
              toast(t('saved.placeRemoved'));
              if (onItemRemoved) onItemRemoved();
            } catch (err) {
              toast((err && err.message) || t('error.somethingWentWrong'), { error: true });
            }
          },
        }),
      ]),
    );
  }

  loadComments();
  return { root };
}