// Typed map errors. Every failure inside the map layer is normalised into one
// of these kinds before it reaches a screen, so Home can pick the right state
// (a network failure, a provider rejection, an unsupported device) without
// ever matching on a raw renderer message or showing a stack trace.
//
// `message` is always safe, plain-language copy for a person. `detail` carries
// the underlying text for the console only.
export const MapErrorKind = {
  NOT_CONFIGURED: 'not_configured',
  UNSUPPORTED_DEVICE: 'unsupported_device',
  NETWORK: 'network',
  PROVIDER: 'provider',
  STYLE_ERROR: 'style_error',
};

export class MapError extends Error {
  constructor(kind, message, { detail = null, cause = null } = {}) {
    super(message);
    this.name = 'MapError';
    this.kind = kind;
    this.detail = detail;
    this.cause = cause;
  }
}

export function isMapError(value) {
  return value instanceof MapError;
}

// Any thrown value becomes a MapError, so a screen never has to guard against
// a bare string or a renderer's own error object.
export function toMapError(value, fallbackMessage = 'The map could not load.') {
  if (isMapError(value)) return value;
  const detail = value && value.message ? String(value.message) : String(value || '');
  return new MapError(MapErrorKind.STYLE_ERROR, fallbackMessage, { detail, cause: value });
}
