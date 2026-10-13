// The Business section of a place's detail view (Phase 12J).
//
// One section, self-contained: it fetches the place's business state from
// /api/business/place/:id and renders exactly what the server says the viewer
// may do. The words are the spec's word table: "Claim this business" starts a
// claim, "Claim pending" marks a waiting claim, "Verified business" is
// RESERVED for a reviewer's decision — nothing a person does themselves can
// ever show that chip. Login is not proof of ownership, so a claim is an
// application: contact details plus up to three evidence photos, reviewed by
// a person.
//
// The claim form is inline (an expand under the heading), like the community
// forms; evidence goes through the platform's file storage with PRIVATE
// visibility — a licence photo is exactly the kind of file that must not be
// linkable. When there is no platform shell (standalone/offline), uploading
// is honestly unavailable and the rest of the claim still works.
import { el } from '../dom.js';
import { button } from '../button.js';
import { icon } from '../icons.js';
import { spinner } from '../loading.js';
import { errorState } from '../error-state.js';
import { statusChip, toast } from './status-chip.js';
import { t } from '../../i18n/index.js';
import { getPlaceState, submitClaim, withdrawClaim, flagProfile } from '../../services/business.js';
import * as router from '../../router.js';

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
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The photo could not be prepared.'))), 'image/png');
  });
}

// opts: { place } — the place object the detail view is showing
// (services/places-model.js shape: { id, name, address, category,
// coordinates: { lat, lon } }).
export function createBusinessSection({ place } = {}) {
  let state = null;
  let loadError = null;
  let formOpen = false;
  let busy = false;

  const host = el('section', { class: 'flex flex-col gap-2', dataset: { businessSection: 'true' } });
  const heading = el('p', {
    class: 'text-xs font-medium uppercase tracking-wide text-muted',
    text: t('business.sectionTitle'),
  });

  host.appendChild(heading);
  const body = el('div', { class: 'flex flex-col gap-2', dataset: { businessBody: 'true' } }, [
    el('div', { class: 'flex items-center gap-3', role: 'status' }, [
      spinner(),
      el('p', { class: 'text-sm text-muted', text: t('common.loading') }),
    ]),
  ]);
  host.appendChild(body);

  load();

  async function load() {
    loadError = null;
    renderLoading();
    try {
      state = await getPlaceState(place.id);
      formOpen = false;
      renderReady();
    } catch (err) {
      loadError = err;
      renderError(err);
    }
  }

  function renderLoading() {
    body.replaceChildren(
      el('div', { class: 'flex items-center gap-3', role: 'status' }, [
        spinner(),
        el('p', { class: 'text-sm text-muted', text: t('business.loading') }),
      ]),
    );
  }

  function renderError(err) {
    body.replaceChildren(
      errorState({
        title: t('business.loadError'),
        description: (err && err.message) || t('common.tryAgain'),
        onRetry: () => load(),
      }),
    );
  }

  function claimPayload() {
    const coords = place.coordinates || {};
    return {
      place: {
        id: place.id,
        name: place.name,
        address: place.address || null,
        category: place.category || null,
        lat: Number.isFinite(coords.lat) ? coords.lat : null,
        lng: Number.isFinite(coords.lon) ? coords.lon : null,
      },
    };
  }

  function renderReady() {
    const v = state.viewer || {};
    const profile = state.profile;
    const myClaim = state.myClaim;
    // A SUSPENDED profile does not hold the place: its note is shown and,
    // below it, the claim route as the server computed it. A new claimant
    // verifying then transfers ownership (the audited path).
    const suspendedNote = profile && profile.status === 'suspended'
      ? el('p', { class: 'text-sm text-muted leading-relaxed', text: t('business.suspendedNote') })
      : null;
    const prefix = suspendedNote ? [suspendedNote] : [];

    if (profile && profile.status === 'active') {
      body.replaceChildren(renderProfile(profile));
      return;
    }
    if (myClaim) {
      body.replaceChildren(...prefix, renderMyClaim(myClaim));
      return;
    }
    if (v.canClaim) {
      body.replaceChildren(...prefix, formOpen ? renderClaimForm() : renderClaimEntry());
      return;
    }
    // Honest block: signed out, someone else's active claim, the pending
    // claims cap, or the 7-day cool-down. The server wrote the sentence.
    body.replaceChildren(
      ...prefix,
      el('p', {
        class: 'text-sm text-muted leading-relaxed',
        text: v.claimBlockedReason || t('business.claimUnavailable'),
      }),
    );
  }

  function renderClaimEntry() {
    return el('div', { class: 'flex flex-col gap-2' }, [
      el('p', {
        class: 'text-sm text-muted leading-relaxed',
        text: t('business.claimIntro'),
      }),
      el('div', {}, [
        button(t('business.claimCta'), {
          attrs: { 'data-business-claim': 'true' },
          onClick: () => {
            formOpen = true;
            renderReady();
          },
        }),
      ]),
    ]);
  }

  // ── the claim form ───────────────────────────────────────────────────────

  function renderClaimForm() {
    const meta = { evidenceMax: 3 };
    let evidence = []; // [{ url, filename, contentType }]
    let submitting = false;

    const canUpload = typeof window.usernode?.uploadFile === 'function';
    const fileInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'hidden' });
    const thumbs = el('div', { class: 'flex flex-wrap gap-2' });
    const addPhoto = button(t('business.form.addPhoto'), { variant: 'secondary', class: 'self-start', onClick: () => fileInput.click() });
    const photoNote = el('p', { class: 'text-xs text-muted' });

    const contact = el('input', { class: INPUT, placeholder: t('business.form.contactPlaceholder') });
    const fContact = fieldWrap(t('business.form.contact'), contact, 'contactValue', t('business.form.contactHint'));
    const fEvidence = fieldWrap(t('business.form.evidence'), el('div', { class: 'flex flex-col gap-2' }, [thumbs, addPhoto, photoNote, fileInput]), 'evidence');
    const formError = el('p', { class: 'hidden text-xs text-danger', role: 'alert' });

    function renderPhotos() {
      thumbs.replaceChildren(
        ...evidence.map((a, i) =>
          el('div', { class: 'relative' }, [
            el('img', { src: a.url, alt: a.filename || 'Evidence photo', class: 'h-16 w-16 rounded-lg border border-line object-cover' }),
            el(
              'button',
              {
                type: 'button',
                class: 'absolute -right-2 -top-2 rounded-pill border border-line bg-surface p-0.5 text-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                'aria-label': 'Remove photo',
                onClick: () => {
                  evidence.splice(i, 1);
                  renderPhotos();
                },
              },
              [icon('close', { class: 'h-3.5 w-3.5' })],
            ),
          ]),
        ),
      );
      const full = evidence.length >= meta.evidenceMax;
      addPhoto.disabled = !canUpload || full;
      photoNote.textContent = !canUpload
        ? t('business.form.uploadUnavailable')
        : full
          ? t('business.form.evidenceFull', { count: meta.evidenceMax })
          : t('business.form.evidenceHint');
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      addPhoto.disabled = true;
      photoNote.textContent = t('business.form.uploading');
      try {
        const stored = await window.usernode.uploadFile(await prepareImage(file), { visibility: 'private' });
        evidence.push({ url: stored.url, filename: stored.filename, contentType: stored.contentType });
      } catch (err) {
        toast((err && err.message) || t('business.form.uploadFailed'), { error: true });
      }
      renderPhotos();
    });

    const submitBtn = button(t('business.form.submit'), {
      attrs: { 'data-business-claim-submit': 'true' },
      onClick: () => submit(),
    });
    const cancelBtn = button(t('common.cancel'), { variant: 'secondary', onClick: () => {
      formOpen = false;
      renderReady();
    } });

    const form = el('form', {
      class: 'flex flex-col gap-3 rounded-card border border-line bg-surface p-3',
      dataset: { businessClaimForm: 'true' },
      onSubmit: (e) => e.preventDefault(),
    }, [
      el('p', { class: 'text-sm text-muted leading-relaxed', text: t('business.form.intro') }),
      fContact.node,
      fEvidence.node,
      formError,
      el('div', { class: 'flex flex-wrap gap-2' }, [submitBtn, cancelBtn]),
    ]);
    renderPhotos();

    contact.addEventListener('input', () => fContact.error.classList.add('hidden'));

    async function submit() {
      if (submitting) return;
      submitting = true;
      submitBtn.disabled = true;
      formError.classList.add('hidden');
      fContact.error.classList.add('hidden');
      fEvidence.error.classList.add('hidden');
      try {
        await submitClaim(place.id, {
          ...claimPayload(),
          contactValue: contact.value,
          evidence,
        });
        toast(t('business.claimSent'));
        formOpen = false;
        state = await getPlaceState(place.id);
        renderReady();
      } catch (err) {
        const fields = (err && err.fields) || {};
        for (const [key, f] of Object.entries({ contactValue: fContact, evidence: fEvidence })) {
          if (fields[key]) {
            f.error.textContent = fields[key];
            f.error.classList.remove('hidden');
          }
        }
        formError.textContent = (err && err.message) || t('business.actionFailed');
        formError.classList.remove('hidden');
      } finally {
        submitting = false;
        submitBtn.disabled = false;
      }
    }

    return form;
  }

  function fieldWrap(label, control, key, hint) {
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

  // ── the viewer's own claim on this place ─────────────────────────────────

  function renderMyClaim(claim) {
    const rows = [
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        statusChip(claim.status, claim.statusLabel),
        claim.status === 'pending' && claim.daysLeft != null
          ? el('span', { class: 'text-xs text-muted', text: t('business.pendingDays', { days: claim.daysLeft }) })
          : null,
      ]),
    ];
    if (claim.status === 'rejected' && claim.decisionReason) {
      rows.push(
        el('p', {
          class: 'text-sm text-muted leading-relaxed',
          text: t(`business.rejectReason.${claim.decisionReason}`),
        }),
      );
      if (claim.decisionNote) {
        rows.push(el('p', { class: 'text-sm text-muted leading-relaxed', text: claim.decisionNote }));
      }
    }
    if (claim.viewer && claim.viewer.canWithdraw) {
      rows.push(
        el('div', {}, [
          button(t('business.withdraw'), {
            variant: 'secondary',
            attrs: { 'data-business-withdraw': 'true' },
            onClick: async () => {
              if (busy) return;
              busy = true;
              try {
                await withdrawClaim(claim.id);
                state = await getPlaceState(place.id);
                renderReady();
              } catch (err) {
                toast((err && err.message) || t('business.actionFailed'), { error: true });
              } finally {
                busy = false;
              }
            },
          }),
        ]),
      );
    }
    return el('div', { class: 'flex flex-col gap-2', dataset: { businessMyClaim: claim.status } }, rows);
  }

  // ── the verified profile ─────────────────────────────────────────────────

  function renderProfile(profile) {
    const v = profile.viewer || {};
    const rows = [
      el('div', { class: 'flex flex-wrap items-center gap-2' }, [
        statusChip(profile.status, t('business.verifiedChip')),
        el('span', { class: 'text-xs text-muted', text: t('business.ownerLine', { username: profile.owner.username }) }),
      ]),
    ];
    const details = el('div', { class: 'flex flex-col gap-1.5' });
    if (profile.address) {
      details.appendChild(detailRow(t('business.form.address'), profile.address));
    }
    if (profile.phone) {
      details.appendChild(detailRow(t('business.form.phone'), profile.phone));
    }
    if (profile.website) {
      details.appendChild(detailRow(t('business.form.website'), el('a', {
        href: profile.website,
        target: '_blank',
        rel: 'noopener noreferrer',
        class: 'min-w-0 break-all text-right text-sm text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded',
        text: profile.website.replace(/^https?:\/\//i, ''),
      })));
    }
    if (profile.hours) {
      details.appendChild(detailRow(t('business.form.hours'), profile.hours));
    }
    if (profile.description) {
      details.appendChild(el('p', { class: 'whitespace-pre-line text-sm text-ink leading-relaxed', text: profile.description }));
    }
    rows.push(details);

    const actions = [];
    if (v.canEdit) {
      actions.push(
        button(t('business.editProfile'), {
          variant: 'secondary',
          attrs: { 'data-business-edit': 'true' },
          onClick: () => router.navigate('business'),
        }),
      );
    }
    if (v.canFlag) {
      actions.push(
        button(t('business.flag'), {
          variant: 'ghost',
          attrs: { 'data-business-flag': 'true' },
          onClick: async () => {
            try {
              await flagProfile(profile.id, null);
              toast(t('business.flaggedToast'));
            } catch (err) {
              toast((err && err.message) || t('business.actionFailed'), { error: true });
            }
          },
        }),
      );
    }
    if (actions.length) {
      rows.push(el('div', { class: 'flex flex-wrap gap-2' }, actions));
    }
    return el('div', { class: 'flex flex-col gap-2', dataset: { businessProfile: 'active' } }, rows);
  }

  function detailRow(label, value) {
    return el('div', { class: 'flex items-baseline justify-between gap-4' }, [
      el('p', { class: 'shrink-0 text-sm text-muted', text: label }),
      typeof value === 'string'
        ? el('p', { class: 'min-w-0 break-words text-right text-sm text-ink', text: value })
        : value,
    ]);
  }

  return { root: host, reload: load };
}
