// Attribution, built from configuration.
//
// Attribution is a licence term, not decoration: every candidate tile source
// requires it, and the string is different for each. Keeping the string in the
// public map config means a source switch switches the string with it, so it
// stays correct without a code change.
//
// The links are fixed, well-known project pages (not tile endpoints), so they
// are safe to keep here as constants: they point at the data's copyright
// notice and at the renderer's project, both of which are the same whoever
// hosts the tiles.
const OSM_COPYRIGHT = 'https://www.openstreetmap.org/copyright';
const MAPLIBRE_SITE = 'https://maplibre.org/';

// Split a config attribution string into linkable tokens. The default names
// the data providers in order ("OpenFreeMap, OpenMapTiles, OpenStreetMap");
// each known name links to its reference page, unknown names render as plain
// text. Returns [{ label, href }] with href null for plain text.
const LINK_TARGETS = {
  openstreetmap: OSM_COPYRIGHT,
  'open map tiles': OSM_COPYRIGHT,
  openmaptiles: 'https://openmaptiles.org/',
  openfreemap: 'https://openfreemap.org/',
  maplibre: MAPLIBRE_SITE,
};

export function attributionParts(text) {
  if (!text) return [];
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((label) => {
      const href = LINK_TARGETS[label.toLowerCase()] || null;
      return { label, href };
    });
}

export function rendererLink() {
  return MAPLIBRE_SITE;
}
