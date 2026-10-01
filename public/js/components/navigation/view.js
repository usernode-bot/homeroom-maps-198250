// Navigation view — the turn-by-turn guidance overlay for the Directions
// screen's map frame, built entirely from the navigation session's snapshots
// (services/navigation/navigation-core.js). Nothing here computes guidance:
// instructions come from the provider's steps (services/navigation/
// maneuvers.js), distances and durations from measured provider data, and a
// value that cannot be measured reads "unavailable".
//
// Safety-first layout, per the spec: one large maneuver banner at the top of
// the map (icon + instruction + distance), a status line for everything the
// session wants to say (off route, rerouting, GPS lost, weak signal,
// arrived), and one large always-visible End control at the bottom with the
// remaining distance and arrival time. No other chrome, no scrolling.
//
// The view is mounted inside the map frame through the extended route map
// (mountOverlay), so guidance never fights the planning layout for space and
// is torn down with the frame.
//
// Rendering budget: the session emits on every GPS fix (up to ~1 Hz), so the
// banner rebuild is coalesced to at most one render per second and fires
// immediately on a structural change (state, GPS status, reroute activity,
// maneuver step). The map work is throttled separately: puck 1 Hz, camera
// recenter 3 s, remaining-line redraw 1 Hz with a 30 m hysteresis so the line
// does not crawl.
import { el } from '../dom.js';
import { button } from '../button.js';
import { icon } from '../icons.js';
import { spinner } from '../loading.js';
import { t, getLocale } from '../../i18n/index.js';
import { formatDistance, formatTime } from '../../i18n/format.js';
import { describeManeuver, maneuverInstruction } from '../../services/navigation/maneuvers.js';
import { remainingGeometry, haversineMeters } from '../../services/navigation/progress.js';
import { NAV_STATE } from '../../services/navigation/navigation-core.js';
import { geometryBounds } from '../../services/routing-core.js';

const DOM_COALESCE_MS = 1000;
const PUCK_MIN_MS = 1000;
const CAMERA_MIN_MS = 3000;
const LINE_MIN_MS = 1000;
const LINE_HYSTERESIS_M = 30;

export function createNavigationView({ session, voice, routeMap } = {}) {
  let unsub = null;
  let coalesceTimer = null;
  let lastStructuralKey = null;
  let lastRenderAt = 0;
  let lastPuckAt = 0;
  let lastCameraAt = 0;
  let lastLineAt = 0;
  let lastLineStart = null; // [lng, lat] of the drawn line's first point
  let fitted = false;
  let destroyed = false;

  const root = el('div', {
    class: 'pointer-events-none absolute inset-0 flex flex-col justify-between p-3',
    dataset: { navigationOverlay: 'true' },
  });
  const banner = el('div', { class: 'flex flex-col items-stretch gap-2' });
  const bottom = el('div', {
    class: 'pointer-events-auto flex flex-col gap-3 rounded-card border border-line bg-surface p-4 shadow-lg',
    dataset: { navigationControls: 'true' },
  });
  root.append(banner, bottom);

  // ── banner pieces ────────────────────────────────────────────────────────

  function statusCard({ tone = 'plain', icon: iconName = null, title, body, spin = false, onRetry = null }) {
    const children = [];
    const head = el('div', { class: 'flex items-center gap-3' });
    if (iconName) head.append(icon(iconName, { class: 'h-8 w-8 shrink-0 text-ink' }));
    if (spin) head.append(spinner());
    head.append(
      el('p', {
        class:
          tone === 'danger'
            ? 'text-lg font-semibold text-danger'
            : 'text-lg font-semibold text-ink',
        text: title,
      }),
    );
    children.push(head);
    if (body) {
      children.push(
        el('p', { class: 'text-sm text-muted leading-relaxed', text: body }),
      );
    }
    if (onRetry) {
      children.push(button(t('common.tryAgain'), { variant: 'secondary', onClick: onRetry }));
    }
    return el(
      'div',
      {
        class: 'pointer-events-auto flex flex-col gap-2 rounded-card border border-line bg-surface p-4 shadow-lg',
        dataset: { navigationBanner: 'true' },
        role: tone === 'danger' ? 'alert' : 'status',
      },
      children,
    );
  }

  // The guidance banner for the states that still have a maneuver to show
  // (navigating). Big icon, big instruction, distance-to-maneuver first —
  // glanceable order per the spec.
  function maneuverBanner(snap) {
    const progress = snap.progress;
    if (!progress || !progress.nextManeuver) {
      // The route carries no placeable steps, or the fix cannot be projected:
      // say so instead of guessing an instruction.
      return statusCard({
        icon: 'straight',
        title: t('navigation.instructionsUnavailable'),
        body: snap.gps === 'weak' ? t('navigation.weakGps') : null,
      });
    }
    const step = progress.nextManeuver.step;
    const described = describeManeuver(step);
    const instruction = maneuverInstruction(step) || t('navigation.instructionsUnavailable');
    const distance = formatDistance(progress.nextManeuver.distanceMeters);

    const head = el('div', { class: 'flex items-center gap-3' });
    head.append(icon(described.icon, { class: 'h-10 w-10 shrink-0 text-ink' }));
    head.append(
      el('div', { class: 'min-w-0' }, [
        distance
          ? el('p', {
              class: 'text-2xl font-semibold leading-tight tracking-tight text-ink',
              text: distance,
            })
          : null,
        el('p', {
          class: 'text-base font-medium leading-snug text-ink',
          text: instruction,
        }),
      ]),
    );

    const children = [head];
    // The maneuver after this one, only when the provider supplied one: a
    // "then" line composed from the next step, never from imagination.
    if (progress.followingManeuver) {
      const then = maneuverInstruction(progress.followingManeuver.step);
      if (then) {
        children.push(
          el('p', {
            class: 'border-t border-line pt-2 text-sm text-muted leading-snug',
            text: `${t('navigation.then')} ${then}`,
          }),
        );
      }
    }
    if (snap.gps === 'weak') {
      children.push(
        el('p', { class: 'text-xs text-muted leading-relaxed', text: t('navigation.weakGps') }),
      );
    }
    return el(
      'div',
      {
        class: 'pointer-events-auto flex flex-col gap-2 rounded-card border border-line bg-surface p-4 shadow-lg',
        dataset: { navigationBanner: 'true' },
      },
      children,
    );
  }

  // Status banner: what the session wants the person to know right now.
  // Off route and its failures lead with the state in the danger tone; GPS
  // and error states explain themselves and how guidance recovers.
  function statusBanner(snap) {
    const reroute = snap.reroute || {};
    switch (snap.state) {
      case NAV_STATE.PREPARING:
        return statusCard({ icon: 'locate', title: t('navigation.locating') });
      case NAV_STATE.OFF_ROUTE:
      case NAV_STATE.REROUTING:
        return statusCard({
          tone: 'danger',
          title: t('navigation.offRoute'),
          body: reroute.inFlight
            ? t('navigation.rerouting')
            : t('navigation.offRouteRetry'),
          spin: reroute.inFlight,
        });
      case NAV_STATE.NETWORK_UNAVAILABLE:
        return statusCard({
          tone: 'danger',
          title: t('navigation.networkTitle'),
          body: t('navigation.rerouteFailed'),
          onRetry: () => session.retryReroute(),
        });
      case NAV_STATE.ROUTE_UNAVAILABLE:
        return statusCard({
          tone: 'danger',
          title: t('navigation.rerouteFailedTitle'),
          body: t('navigation.rerouteFailed'),
          onRetry: () => session.retryReroute(),
        });
      case NAV_STATE.GPS_UNAVAILABLE:
        return statusCard({
          title: t('navigation.gpsLost'),
          body: t('navigation.gpsResume'),
        });
      case NAV_STATE.ARRIVED:
        return statusCard({ icon: 'pin', title: t('navigation.arrived') });
      case NAV_STATE.ERROR: {
        const err = snap.error || {};
        const body =
          err.kind === 'invalid_route'
            ? t('navigation.needsRouteBody')
            : err.message || t('navigation.needsRouteBody');
        return statusCard({
          tone: 'danger',
          title: err.kind === 'invalid_route' ? t('navigation.needsRoute') : t('navigation.errorTitle'),
          body,
        });
      }
      default:
        return null;
    }
  }

  // ── bottom card ──────────────────────────────────────────────────────────

  function renderBottom(snap) {
    const progress = snap.progress;
    const remaining =
      progress && Number.isFinite(progress.remainingDistanceMeters)
        ? formatDistance(progress.remainingDistanceMeters)
        : t('navigation.distanceUnavailable');

    let eta;
    if (
      progress &&
      Number.isFinite(progress.remainingDurationSeconds) &&
      progress.remainingDurationSeconds > 0
    ) {
      const at = new Date(Date.now() + progress.remainingDurationSeconds * 1000);
      eta = t('navigation.arriveAt', { time: formatTime(at, { locale: getLocale() }) });
    } else {
      eta = t('navigation.durationUnavailable');
    }

    const endButton = button(t('navigation.end'), {
      attrs: { dataset: { endNavigation: 'true' } },
      class: 'w-full py-3 text-base',
    });
    endButton.addEventListener('click', () => session.end());

    const children = [
      el('p', {
        class: 'text-lg font-semibold tracking-tight text-ink',
        dataset: { navigationRemaining: 'true' },
        text: remaining,
      }),
      el('p', {
        class: 'text-sm text-muted',
        dataset: { navigationEta: 'true' },
        text: eta,
      }),
    ];
    if (voice && !voice.isAvailable()) {
      children.push(
        el('p', {
          class: 'text-xs text-muted leading-relaxed',
          dataset: { navigationVoiceHint: 'true' },
          text: t('navigation.voiceUnavailable'),
        }),
      );
    }
    children.push(endButton);
    bottom.replaceChildren(...children);
  }

  // ── render ───────────────────────────────────────────────────────────────

  function renderBanner(snap) {
    const node =
      snap.state === NAV_STATE.NAVIGATING ? maneuverBanner(snap) : statusBanner(snap);
    banner.replaceChildren(...(node ? [node] : []));
  }

  function structuralKey(snap) {
    const p = snap.progress;
    const next = p && p.nextManeuver;
    const following = p && p.followingManeuver;
    return [
      snap.state,
      snap.gps,
      snap.error && snap.error.kind,
      snap.reroute && snap.reroute.inFlight,
      snap.reroute && snap.reroute.attempts,
      next ? `${next.legIndex}:${next.stepIndex}` : '',
      following ? `${following.legIndex}:${following.stepIndex}` : '',
      voice ? voice.isAvailable() : true,
    ].join('|');
  }

  function scheduleRender(snap) {
    const key = structuralKey(snap);
    const now = Date.now();
    const structural = key !== lastStructuralKey;
    if (structural && coalesceTimer) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
    if (structural || now - lastRenderAt >= DOM_COALESCE_MS) {
      if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      lastStructuralKey = key;
      lastRenderAt = now;
      renderBanner(snap);
      renderBottom(snap);
      return;
    }
    if (!coalesceTimer) {
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        lastStructuralKey = key;
        lastRenderAt = Date.now();
        renderBanner(snap);
        renderBottom(snap);
      }, DOM_COALESCE_MS - (now - lastRenderAt));
    }
  }

  // ── map work, throttled ──────────────────────────────────────────────────

  function updateMap(snap) {
    const now = Date.now();
    const fix = snap.fix;

    if (!fitted && snap.route && Array.isArray(snap.route.geometry)) {
      fitted = true;
      const bounds = geometryBounds(snap.route.geometry);
      if (bounds) routeMap.apply((svc) => svc.fitBounds(bounds));
    }

    if (fix && now - lastPuckAt >= PUCK_MIN_MS) {
      lastPuckAt = now;
      routeMap.apply((svc) =>
        svc.setUserLocation({ lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy }),
      );
    }

    const progress = snap.progress;
    const active = [
      NAV_STATE.NAVIGATING,
      NAV_STATE.OFF_ROUTE,
      NAV_STATE.REROUTING,
      NAV_STATE.GPS_UNAVAILABLE,
    ].includes(snap.state);

    if (active && progress && Array.isArray(progress.snapPoint)) {
      if (now - lastCameraAt >= CAMERA_MIN_MS) {
        lastCameraAt = now;
        routeMap.apply((svc) =>
          svc.centerOn({ lat: progress.snapPoint[1], lng: progress.snapPoint[0] }),
        );
      }
      // The drawn line becomes the not-yet-travelled part of the provider's
      // geometry. The route data itself is never mutated; the full line comes
      // back on exit through routeMap.refresh().
      if (now - lastLineAt >= LINE_MIN_MS) {
        const line = remainingGeometry(snap.route ? snap.route.geometry : null, progress);
        if (line) {
          const start = line[0];
          const movedMeters = lastLineStart
            ? haversineMeters(lastLineStart[1], lastLineStart[0], start[1], start[0])
            : Infinity;
          if (movedMeters == null || movedMeters >= LINE_HYSTERESIS_M) {
            lastLineAt = now;
            lastLineStart = start;
            routeMap.apply((svc) => svc.setRoutes([{ coordinates: line, selected: true }]));
          }
        }
      }
    }
  }

  function onSnapshot(snap) {
    if (destroyed || snap.state === NAV_STATE.IDLE) return;
    scheduleRender(snap);
    updateMap(snap);
  }

  routeMap.mountOverlay(root);

  return {
    root,
    onSnapshot,
    subscribe() {
      if (unsub) unsub();
      unsub = session.subscribe(onSnapshot);
      const snap = session.getState();
      if (snap && snap.state !== NAV_STATE.IDLE) onSnapshot(snap);
    },
    destroy() {
      destroyed = true;
      if (unsub) {
        unsub();
        unsub = null;
      }
      if (coalesceTimer) {
        clearTimeout(coalesceTimer);
        coalesceTimer = null;
      }
      routeMap.clearOverlay();
    },
  };
}