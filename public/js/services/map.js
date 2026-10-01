// Map service — INTERFACE ONLY, and emphatically not configured. No map
// provider, SDK, tile URL or key exists in this app yet, and none is invented
// here. `/api/config` reports `mapProvider: null`; any screen that would show a
// map must read that flag and render a placeholder until a provider is chosen
// in a later stage.
export const provider = null;

export function isConfigured() {
  return provider !== null;
}

export async function mount(_container, _options) {
  throw new Error('No map provider is connected yet.');
}

export async function centerOn(_latlng, _zoom) {
  throw new Error('No map provider is connected yet.');
}
