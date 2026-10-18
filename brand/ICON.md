# Homeroom Maps app icon

One mark: a white map pin on an indigo tile.

- **Source artwork:** `public/icon.svg` (512 by 512 viewBox, full bleed).
- **Registered app icon:** `brand/icon.png`, 512 by 512 opaque PNG. This is the
  file Homeroom reads from `dapp.json`; it is not served by the app.
- **Served rasters:** `public/icon-512.png` and `public/icon-192.png`, the same
  artwork at browser icon sizes.
- **Background:** diagonal gradient from `#6366f1` (top left) to `#4f46e5`
  (bottom right), square corners, every pixel covered.
- **Glyph:** the `pin` path from `public/js/components/icons.js`, in white with
  a 2px round stroke on a 24-unit grid, scaled 12 times into the middle 288px
  (112px margin on each side).
- **Shadow:** soft drop shadow behind the glyph, 10px down and 12px blur,
  `#1e1b4b` at 35 percent.
- **Text:** none. The app name beside the icon is "Homeroom Maps".
