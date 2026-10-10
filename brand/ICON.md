# Homeroom Maps logo and app icon

`brand/logo.png` is the Homeroom Maps logo as supplied (1536 × 1024): a globe
with a gold "H", an orbit with a map pin, and the "HOMEROOM MAPS" wordmark on
black. Every other logo and icon file is cut from it; nothing is redrawn.

- **App tile** (`brand/icon.jpg`): declared in `dapp.json` as
  `{ "icon": { "image": "brand/icon.jpg", "emoji": "🗺️" } }`. The platform
  reads it at deploy time and serves it on the tile, so it stays out of
  `public/`. It is the emblem (globe, H, orbit and pin, source pixels
  x 305 to 1265, y 45 to 663, without the wordmark) centred on black in a
  512 × 512 square. JPEG because the PNG of this artwork is over the
  platform's 256 KB limit. If the image ever fails validation, the platform
  falls back to the declared emoji (`🗺️`).
- **Served by the app** (`public/icons/`): the same emblem square at
  16, 32 and 48 px (favicons), 180 px (`apple-touch-icon.png`) and 96 px
  (`logo-mark-96.png`, the top bar mark shown at 32 px).

To regenerate after replacing `brand/logo.png`, crop the same emblem box,
centre it on black in a square, and scale to each size above.
