// Create a report. Presented over the Community screen.
//
// A report is a type, a location and an optional description; it is public
// the moment the server accepts it. The type picker carries each type's own
// glyph (the same artwork the map pins use), the location comes from the
// device or from the app's place search, and the server is the judge of
// what is valid: its per-field messages are shown beside each field.
import { el } from '../dom.js';
import { button } from '../button.js';
import { icon } from '../icons.js';
import { spinner } from '../loading.js';
import { errorState } from '../error-state.js';
import { present } from '../surface.js';
import { toast } from './parts.js';
import { reportIconMarkup } from '../../map/report-icons.js';
import { t } from '../../i18n/index.js';
import { fetchSuggest } from '../../services/search.js';
import { locateOnce } from '../../services/location.js';
import { fetchReportsMeta, createReport } from '../../services/community.js';

const INPUT =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

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

// opts: { meta?, onSaved(report) }
export function openReportForm({ meta = null, onSaved } = {}) {
  let selectedType = null;
  let location = null; // { lat, lng, name } — display only; the server keeps the coordinates
  let place = null; // { id, provider } — set when a place search result is attached
  let busy = false;
  let surface = null;

  const body = el('div', { class: 'flex flex-col gap-4 p-1', dataset: { reportForm: 'create' } }, [
    el('div', { class: 'flex justify-center py-6' }, [spinner()]),
  ]);

  let fType = null;
  let fLocation = null;
  let fDescription = null;
  let formError = null;
  let actions = null;

  function buildForm(m) {
    // ── type picker ──
    const typeGrid = el('div', {
      class: 'flex flex-wrap gap-2',
      role: 'radiogroup',
      'aria-label': t('reports.typeLabel'),
      dataset: { reportTypePicker: 'true' },
    });

    function renderTypes() {
      typeGrid.replaceChildren(
        ...m.types.map((ty) => {
          const on = selectedType === ty.id;
          return el(
            'button',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': on ? 'true' : 'false',
              class: [
                'inline-flex items-center gap-1.5 rounded-pill border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                on ? 'border-transparent bg-accent-soft text-brand' : 'border-line text-muted hover:text-ink',
              ].join(' '),
              dataset: { reportType: ty.id },
              onClick: () => {
                selectedType = ty.id;
                fType.error.classList.add('hidden');
                renderTypes();
              },
            },
            [
              el('span', { class: 'shrink-0', html: reportIconMarkup(ty.id, 'h-4 w-4') }),
              el('span', { text: t(`reports.type.${ty.id}`) }),
            ],
          );
        }),
      );
    }
    renderTypes();

    // ── location ──
    const locSearch = el('input', {
      id: 'report-location',
      class: INPUT,
      type: 'search',
      placeholder: t('reports.searchPlaceholder'),
      autocomplete: 'off',
      dataset: { reportLocation: 'true' },
    });
    const locResults = el('div', { class: 'hidden flex-col divide-y divide-line rounded-lg border border-line', role: 'listbox' });
    const locChosen = el('div', { class: 'hidden items-center justify-between gap-3 rounded-lg bg-surface-raised px-3 py-2' });
    const locateBtn = button(t('reports.useMyLocation'), { variant: 'ghost', class: 'self-start px-0' });
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
          button(t('reports.change'), {
            variant: 'ghost',
            class: 'px-2 py-1',
            onClick: () => {
              location = null;
              place = null;
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
        locResults.replaceChildren(el('div', { class: 'flex items-center justify-center gap-2 p-3' }, [spinner(), el('span', { class: 'text-xs text-muted', text: t('reports.searching') })]));
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
                        location = {
                          name: r.detail ? `${r.name}, ${r.detail}`.slice(0, 200) : r.name,
                          lat: r.lat,
                          lng: r.lon,
                        };
                        // The place reference rides along: it is what tells
                        // reviewers which named place the report is about.
                        place = r.id && r.provider ? { id: r.id, provider: r.provider } : null;
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
              : [el('p', { class: 'px-3 py-2 text-sm text-muted', text: t('reports.noResults') })]),
          );
        } catch (err) {
          if (seq !== searchSeq) return;
          locResults.replaceChildren(
            el('p', { class: 'px-3 py-2 text-sm text-muted', text: (err && err.message) || t('reports.noResults') }),
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
      place = null;
      location = { name: `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}`, lat: pos.lat, lng: pos.lng };
      renderLocation();
    });

    // ── description ──
    const description = el('textarea', {
      id: 'report-description',
      class: `${INPUT} min-h-20`,
      rows: '4',
      maxlength: String(m.limits.descriptionMax),
      placeholder: t('reports.descriptionPlaceholder'),
      dataset: { reportDescription: 'true' },
    });
    description.addEventListener('input', () => fDescription.error.classList.add('hidden'));

    // ── assembly ──
    fType = field(t('reports.typeLabel'), typeGrid, 'type');
    fLocation = field(t('reports.locationLabel'), locWrap, 'location', t('reports.locationHint'));
    fDescription = field(t('reports.descriptionLabel'), description, 'description');
    formError = el('p', { class: 'hidden text-sm text-danger', role: 'alert', dataset: { formError: 'true' } });

    async function submit() {
      if (busy) return;
      // The two things a report cannot go without are checked here, with the
      // same field messages the server would send, so the person sees the gap
      // before the round trip.
      const clientErrors = {};
      if (!selectedType) clientErrors.type = t('reports.needType');
      if (!location) clientErrors.location = t('reports.needLocationFirst');
      if (clientErrors.type || clientErrors.location) {
        showErrors({ fields: clientErrors });
        return;
      }
      busy = true;
      actions.querySelectorAll('button').forEach((b) => (b.disabled = true));
      showErrors(null);
      try {
        const created = await createReport({
          type: selectedType,
          lat: location.lat,
          lng: location.lng,
          ...(description.value.trim() ? { description: description.value.trim() } : {}),
          ...(place ? { placeId: place.id, placeProvider: place.provider } : {}),
        });
        surface.dismiss();
        toast(t('reports.createdToast'));
        if (onSaved) onSaved(created);
      } catch (err) {
        showErrors(err);
      } finally {
        busy = false;
        actions.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
    }

    function showErrors(err) {
      const fieldErrors = { type: fType, location: fLocation, description: fDescription };
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
      if (err && (!err.fields || !Object.keys(err.fields).length)) {
        formError.textContent = (err && err.message) || t('error.somethingWentWrong');
        formError.classList.remove('hidden');
      }
    }

    actions = el('div', { class: 'flex flex-wrap justify-end gap-2 pt-2' }, [
      button(t('reports.submit'), { onClick: submit, attrs: { 'data-submit-report': 'true' } }),
    ]);

    body.replaceChildren(
      el('h2', { class: 'text-lg font-semibold text-ink', text: t('reports.formTitle') }),
      el('p', { class: 'text-sm leading-relaxed text-muted', text: t('reports.formIntro') }),
      fType.node,
      fLocation.node,
      fDescription.node,
      formError,
      actions,
    );
    renderLocation();
  }

  // The meta (type list and limits) may arrive with the caller or load here.
  // A failure is the form's error state with Try again, never a blank sheet.
  async function start(m) {
    if (m) {
      buildForm(m);
      return;
    }
    body.replaceChildren(el('div', { class: 'flex justify-center py-6' }, [spinner()]));
    try {
      buildForm(await fetchReportsMeta());
    } catch (err) {
      body.replaceChildren(
        errorState({
          title: t('reports.errorTitle'),
          description: (err && err.message) || t('common.tryAgain'),
          onRetry: () => start(null),
        }),
      );
    }
  }
  start(meta);

  surface = present(body, { label: t('reports.formTitle') });
  return surface;
}