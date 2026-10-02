# Homeroom Maps app icon

The platform's app-tile icon. Declared in `dapp.json` as
`{ "icon": { "image": "brand/icon.png", "emoji": "🗺️" } }`; the platform
reads `brand/icon.png` at deploy time and serves it on the tile. The app
itself never serves these files — keep them out of `public/`.

- **Glyph:** [Lucide `map`](https://lucide.dev/icons/map) (folded map),
  ISC licence. White (`#fff`), 2px round strokes on Lucide's 24-unit grid,
  scaled ×12 into the middle 288 px (112 px margin on each side) over a
  soft drop shadow (`feDropShadow` kept on the outer, unscaled group).
- **Background:** diagonal two-stop gradient, top left to bottom right,
  in the platform palette's indigo pair — `#8577FF` → `#4432D1` (indigo
  matches the app's brand colour, `--hm-brand` in `styles/tailwind-input.css`).
  Faint white radial gloss (`0.22` → `0` opacity) at the top left.
- **Format:** 512 × 512 PNG, opaque, full bleed, square corners, ≤ 256 KB.
  SVG is not accepted by the platform; `icon.svg` is source artwork only.

To redraw or retint: edit `brand/icon.svg`, then re-render
`brand/icon.png` from it at 512 × 512 (e.g.
`rsvg-convert -w 512 -h 512 brand/icon.svg -o brand/icon.png`) and check
the size stays under 256 KB. If the image ever fails validation, the
platform falls back to the declared emoji (`🗺️`).
