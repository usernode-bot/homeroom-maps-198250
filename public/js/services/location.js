// One-shot device location, through the platform's permission flow.
//
// Follows the same rules as the Home map's "my location" control: ask at the
// moment of need (a tap), tell a decline apart from an ordinary failure, and
// never tell someone to check a permission they were never asked for.
// Resolves { ok: true, lat, lng, accuracy } or { ok: false, message, pending? }
// and never rejects. `pending: true` means access was just granted and the
// platform is about to reopen the app to apply it.

let lastPosition = null;

// The last position this session found, or null.
export function lastKnownPosition() {
  return lastPosition;
}

export async function locateOnce() {
  const usernode = window.usernode;
  if (!usernode || typeof usernode.requestPermission !== 'function') {
    return { ok: false, message: 'Open Homeroom Maps inside Homeroom to use your location.' };
  }
  let result;
  try {
    result = await usernode.requestPermission('geolocation');
  } catch {
    return { ok: false, message: 'We could not ask for your location. Please try again.' };
  }
  if (!result || result.state !== 'granted') {
    return {
      ok: false,
      message:
        result && result.reason === 'declined'
          ? 'Location access was declined.'
          : 'Your location is not available to the app.',
    };
  }
  if (result.active === false) {
    return { ok: false, pending: true, message: 'Location enabled. Homeroom Maps will reopen to finish.' };
  }
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { ok: false, message: 'This device cannot provide a location.' };
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        lastPosition = { lat: latitude, lng: longitude, accuracy };
        resolve({ ok: true, ...lastPosition });
      },
      (err) => {
        const denied = err && err.code === err.PERMISSION_DENIED;
        const documentHolds =
          typeof window.usernode?.hasCapability === 'function' &&
          window.usernode.hasCapability('geolocation');
        resolve({
          ok: false,
          message:
            denied && documentHolds
              ? 'Location access was denied.'
              : 'We could not determine your location right now. Please try again.',
        });
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  });
}
