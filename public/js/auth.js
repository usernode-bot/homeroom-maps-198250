// Auth. Inside the platform the shell injects a per-user RS256 token as
// `?token=…` on the iframe load; the server verifies it and everything the
// app sends afterwards forwards it back as `x-usernode-token`. There is no
// login flow to build and no token to mint here — only to carry.
const params = new URLSearchParams(window.location.search);
const TOKEN = params.get('token') || '';

export function getToken() {
  return TOKEN;
}

// Whether the shell gave this frame a token. Inside the platform it always
// does; standalone (local dev) and an offline load do not. Screens that need
// the signed-in identity check this first rather than making a request the
// server would (correctly) answer 401.
export function hasToken() {
  return Boolean(TOKEN);
}

// Headers to attach to every same-origin API request.
export function authHeaders() {
  return TOKEN ? { 'x-usernode-token': TOKEN } : {};
}
