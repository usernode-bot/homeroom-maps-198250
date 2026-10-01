// Maneuver mapping — turns a normalized routing step ({ type, modifier,
// name, ref, exit } from routing/normalize.js) into an icon and an
// instruction for the navigation banner and the voice.
//
// Honesty contract, the same one routeLine() applies to distances: an
// instruction is composed ONLY from the fields the provider supplied. A road
// name is appended only when the step carried one; a roundabout exit number
// is spoken only when the provider supplied it; a maneuver type the active
// provider supplies that this mapping does not know is rendered as the
// provider's own word for it, never paraphrased into something plausible.
// A step with no maneuver type at all has no instruction — the banner shows
// "Instructions unavailable" instead.
'use strict';

import { t } from '../../i18n/index.js';

// Modifier -> icon name (components/icons.js). Icons are direction-agnostic
// artwork for merge/ramp/fork/roundabout; the instruction carries the side.
const MODIFIER_ICONS = {
  straight: 'straight',
  left: 'turn-left',
  right: 'turn-right',
  'slight left': 'slight-left',
  'slight right': 'slight-right',
  'sharp left': 'sharp-left',
  'sharp right': 'sharp-right',
  uturn: 'uturn',
};

// The turn family shares one verb table; "end of road" and "continue" reuse it.
const TURN_KEYS = {
  straight: 'navigation.maneuverStraight',
  left: 'navigation.maneuverTurnLeft',
  right: 'navigation.maneuverTurnRight',
  'slight left': 'navigation.maneuverSlightLeft',
  'slight right': 'navigation.maneuverSlightRight',
  'sharp left': 'navigation.maneuverSharpLeft',
  'sharp right': 'navigation.maneuverSharpRight',
  uturn: 'navigation.maneuverUturn',
};

// Types whose instructions append the road name when the step carried one.
const ROAD_TYPES = new Set(['turn', 'end of road', 'continue', 'merge', 'on ramp', 'off ramp', 'fork']);

function roadOf(step) {
  const name = typeof step.name === 'string' && step.name.trim() ? step.name.trim() : null;
  const ref = typeof step.ref === 'string' && step.ref.trim() ? step.ref.trim() : null;
  return name || ref;
}

// A type this mapping does not know: the provider's own word, generic icon.
function unmapped(type) {
  return { icon: 'straight', key: null, params: null, text: type };
}

export function describeManeuver(step) {
  const type =
    step && step.maneuver && typeof step.maneuver.type === 'string' && step.maneuver.type.trim()
      ? step.maneuver.type.trim()
      : null;
  const modifier =
    step && step.maneuver && typeof step.maneuver.modifier === 'string' && step.maneuver.modifier.trim()
      ? step.maneuver.modifier.trim()
      : null;
  const road = step ? roadOf(step) : null;
  if (!type) {
    // No maneuver data: no instruction exists to show.
    return { icon: 'straight', key: null, params: null, text: null };
  }

  switch (type) {
    case 'depart':
      return {
        icon: 'straight',
        key: road ? 'navigation.maneuverDepart' : 'navigation.maneuverDepartPlain',
        params: road ? { road } : null,
        text: null,
      };
    case 'arrive':
      return { icon: 'pin', key: 'navigation.maneuverArrive', params: null, text: null };
    case 'turn':
    case 'end of road':
    case 'continue': {
      if (modifier && TURN_KEYS[modifier]) {
        return {
          icon: MODIFIER_ICONS[modifier],
          key: TURN_KEYS[modifier],
          params: null,
          text: null,
          road,
        };
      }
      return unmapped(type);
    }
    case 'new name': {
      return {
        icon: MODIFIER_ICONS[modifier] || 'straight',
        key: road ? 'navigation.maneuverContinueRoad' : 'navigation.maneuverContinue',
        params: road ? { road } : null,
        text: null,
      };
    }
    case 'merge': {
      const key =
        modifier === 'left' ? 'navigation.maneuverMergeLeft'
        : modifier === 'right' ? 'navigation.maneuverMergeRight'
        : 'navigation.maneuverMerge';
      return { icon: 'merge', key, params: null, text: null, road };
    }
    case 'on ramp': {
      const key =
        modifier === 'left' ? 'navigation.maneuverRampLeft'
        : modifier === 'right' ? 'navigation.maneuverRampRight'
        : 'navigation.maneuverRamp';
      return { icon: 'ramp', key, params: null, text: null, road };
    }
    case 'off ramp': {
      const key =
        modifier === 'left' ? 'navigation.maneuverExitRampLeft'
        : modifier === 'right' ? 'navigation.maneuverExitRampRight'
        : 'navigation.maneuverExitRamp';
      return { icon: 'ramp', key, params: null, text: null, road };
    }
    case 'fork': {
      // "slight left" at a fork is a keep-left; only the side matters.
      const side = modifier && /left/.test(modifier) ? 'Left' : modifier && /right/.test(modifier) ? 'Right' : '';
      const key = side ? `navigation.maneuverFork${side}` : 'navigation.maneuverFork';
      return { icon: 'fork', key, params: null, text: null, road };
    }
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn': {
      const exit = Number.isFinite(step.exit) && step.exit > 0 ? Math.round(step.exit) : null;
      return {
        icon: 'roundabout',
        key: exit != null ? 'navigation.maneuverRoundaboutExit' : 'navigation.maneuverRoundabout',
        params: exit != null ? { exit } : null,
        text: null,
        road,
      };
    }
    case 'exit roundabout':
    case 'exit rotary':
      return { icon: 'roundabout', key: 'navigation.maneuverExitRoundabout', params: null, text: null, road };
    default:
      return unmapped(type);
  }
}

// The final human-readable instruction, or null when none can be composed
// without inventing anything. Road names append via the ontoRoad suffix for
// the turn family — the templates are written so "verb + ke {road}" reads
// naturally in both shipped locales.
export function maneuverInstruction(step) {
  const d = describeManeuver(step);
  if (!d) return null;
  if (d.text != null) return d.text;
  if (!d.key) return null;
  const base = t(d.key, d.params || undefined);
  if (!base || base === d.key) return null;
  if (d.road && ROAD_TYPES.has(step && step.maneuver && step.maneuver.type) && d.key !== 'navigation.maneuverUturn') {
    const suffix = t('navigation.ontoRoad', { road: d.road });
    if (suffix && suffix !== 'navigation.ontoRoad') return base + suffix;
  }
  return base;
}