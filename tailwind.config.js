// Tailwind config for this app's precompiled stylesheet.
//
// npm run build (Docker or Paketo) runs the Tailwind CLI over the globs below
// and writes public/tailwind.css, which public/index.html links as
// /tailwind.css. Nothing is committed — every image build regenerates it.
//
// To build it locally (optional; the image build does this for you):
//   npm ci --include=dev
//   npm run build
module.exports = {
  // Every file that can contain a class name. Tailwind's extractor is a
  // regex over source text, so it finds class names written as whole
  // literals — including ones inside JS strings in these files.
  content: [
    './public/**/*.html',
    './public/**/*.js',
  ],

  // Classes this app builds dynamically (if it ever does) go here, since the
  // extractor cannot see them. Prefer whole literals in the markup instead.
  safelist: [],

  // Matches the <html class="dark"> in public/index.html: dark: variants key
  // off that class rather than the OS colour-scheme preference.
  darkMode: 'class',

  // Stops hover: styles sticking after a tap on touch screens. Required by
  // the usernode-native UI kit and harmless without it.
  future: { hoverOnlyWhenSupported: true },

  theme: {
    extend: {
      // Homeroom Maps semantic tokens (defined in styles/tailwind-input.css).
      // Utilities like `bg-surface`, `text-muted`, `border-line` and
      // `bg-brand` resolve through these, so a screen never hard-codes a hex
      // and light/dark switch in one place.
      colors: {
        bg: 'var(--hm-bg)',
        surface: {
          DEFAULT: 'var(--hm-surface)',
          raised: 'var(--hm-surface-raised)',
        },
        line: 'var(--hm-border)',
        ink: 'var(--hm-text)',
        muted: 'var(--hm-text-muted)',
        brand: {
          DEFAULT: 'var(--hm-brand)',
          contrast: 'var(--hm-brand-contrast)',
        },
        accent: {
          DEFAULT: 'var(--hm-accent)',
          soft: 'var(--hm-accent-soft)',
        },
        danger: 'var(--hm-danger)',
      },
      borderRadius: {
        card: 'var(--hm-radius-card)',
        pill: 'var(--hm-radius-pill)',
      },
    },
  },
  plugins: [],
};
