// Location service — the screen-facing wrapper around the device's current
// position, with the platform's permission flow.
//
// Directions uses this for the "My location" origin. The permission is asked
// at the moment of need (the tap), never at startup, exactly as the Home map
// control does. The failure reasons are exact and distinguishable — a denial
// is the person saying no, a timeout is a slow fix, `unavailable` is the
// device having nothing to give, and `reopening` means the grant was made
// and the shell is about to reload this frame to apply it — so the UI never
// tells someone to check a permission they were never asked for.
//
// Home keeps its own inline flow; this module exists so the later phases
// (Directions today, navigation later) share one implementation rather than
// growing a second one by copy-paste. TODO(map-phase): migrate Home's
// "My location" control onto this module so there is exactly one.

export const LOCATION_ERROR_COPY = {
  no_shell: 'Open Homeroom Maps inside Homeroom to use your location.',
  ask_failed: 'We could not ask for your location. Please try again.',
  declined: 'Location access was declined. Directions still works with a chosen place instead.',
  not_declared: 'Your location is not available to the app. Directions still works with a chosen place instead.',
  denied: 'Location access was denied. Directions still works with a chosen place instead.',
  no_geolocation: 'This device cannot provide a location.',
  timeout: 'Finding your location took too long. Please try again.',
  unavailable: 'We could not determine your location right now. Please try again.',
  reopening: 'Location enabled. Homeroom Maps will reopen to finish.',
};

export class LocationError extends Error {
  constructor(reason) {
    super(LOCATION_ERROR_COPY[reason] || LOCATION_ERROR_COPY.unavailable);
    this.name = 'LocationError';
    this.reason = reason;
  }
}

// Resolves { lat, lng, accuracy } for the device's current position, or
// rejects with a typed LocationError. A fix with a reported accuracy carries
// it, so the UI can be honest about how precise the point is.
export async function getCurrentLocation() {
  const usernode = typeof window !== 'undefined' ? window.usernode : null;

  if (!usernode || typeof usernode.requestPermission !== 'function') {
    // Standalone (no platform shell): a permission request would reject the
    // same way a denial does, so say the platform is needed instead of
    // pretending the user said no.
    throw new LocationError('no_shell');
  }

  let result;
  try {
    result = await usernode.requestPermission('geolocation');
  } catch {
    throw new LocationError('ask_failed');
  }

  if (!result || result.state !== 'granted') {
    // `declined` is the person saying no. `not_declared` would mean our
    // manifest is wrong (a bug), but the honest copy still fits.
    throw new LocationError(
      result && result.reason === 'declined' ? 'declined' : 'not_declared',
    );
  }

  if (result.active === false) {
    // Granted, and the shell is about to reload this frame to apply the
    // policy. Stop here: calling the geolocation API now would fail.
    throw new LocationError('reopening');
  }

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new LocationError('no_geolocation');
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        resolve({ lat: latitude, lng: longitude, accuracy });
      },
      (err) => {
        // A PERMISSION_DENIED here is ambiguous: it is also what an
        // undelegated capability carries, which looks identical to a person
        // tapping block. hasCapability reads this document's own policy, so
        // it separates "never asked / not delegated" from a genuine denial.
        const denied = err && err.code === err.PERMISSION_DENIED;
        const documentHolds =
          typeof usernode.hasCapability === 'function' &&
          usernode.hasCapability('geolocation');
        if (denied && documentHolds) reject(new LocationError('denied'));
        else if (err && err.code === err.TIMEOUT) reject(new LocationError('timeout'));
        else reject(new LocationError('unavailable'));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}
