// Offline search — the minimal MVT reader (Phase 12B).
//
// A downloaded region stores Mapbox Vector Tiles. Offline search needs only
// ONE thing out of them: the name and position of each `place` feature, so a
// typed query can be matched against the places the device already holds.
//
// No vector-tile parser is servable to the browser in this app (MapLibre is
// vendored but does not export its parser; `@mapbox/vector-tile` and `pbf`
// are transitive dependencies of it, not assets this app may serve), so this
// module implements exactly the slice of the MVT/protobuf wire format that
// reading the `place` layer requires:
//
//   - the tile -> layer -> feature -> value message nesting,
//   - varint and zig-zag decoding,
//   - the geometry command integers (MoveTo / LineTo / ClosePath), enough to
//     yield one representative point per feature,
//   - tags mapped through the layer's key/value tables.
//
// It is deliberately strict: malformed bytes THROW (a typed error the caller
// turns into the honest failed state), a feature with no name is skipped, and
// only the `place` layer is read. Nothing here guesses a coordinate or invents
// a name; a partial tile either decodes or fails.

export class MvtDecodeError extends Error {
  constructor(message = 'The offline tile could not be read.') {
    super(message);
    this.name = 'MvtDecodeError';
    this.code = 'mvt_decode_error';
  }
}

// The layers offline search reads. The non-goal on POI extraction beyond place
// names is enforced here: any other layer in the tile is skipped untouched.
export const PLACE_LAYER = 'place';

// MVT geometry command ids.
const CMD_MOVE_TO = 1;
const CMD_LINE_TO = 2;
const CMD_CLOSE_PATH = 7;

// A protobuf reader over a Uint8Array. Offsets are absolute; every read is
// bounds-checked so a truncated or corrupt tile throws instead of looping or
// reading undefined.
class Reader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
  }

  get done() {
    return this.pos >= this.end;
  }

  ensure(n) {
    if (this.pos + n > this.end) throw new MvtDecodeError('Tile data is truncated.');
  }

  readVarint() {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 10; i += 1) {
      this.ensure(1);
      const byte = this.bytes[this.pos];
      this.pos += 1;
      result += (byte & 0x7f) * Math.pow(2, shift);
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
    throw new MvtDecodeError('Tile data contains an oversized integer.');
  }

  readTag() {
    const tag = this.readVarint();
    return { field: tag >>> 3, wire: tag & 0x7 };
  }

  // Read a length-delimited field's bytes as a sub-reader.
  readByteView() {
    const length = this.readVarint();
    this.ensure(length);
    const view = { start: this.pos, end: this.pos + length };
    this.pos += length;
    return new Reader(this.bytes, view.start, view.end);
  }

  readString() {
    const sub = this.readByteView();
    return utf8Decode(this.bytes, sub.pos, sub.end);
  }

  // Skip a field of any wire type this reader might meet.
  skip(wire) {
    if (wire === 0) this.readVarint();
    else if (wire === 2) this.readByteView();
    else if (wire === 5) this.ensure(4), (this.pos += 4);
    else if (wire === 1) this.ensure(8), (this.pos += 8);
    else throw new MvtDecodeError('Tile data uses an unsupported field type.');
  }
}

// UTF-8 decode without depending on TextDecoder being present in Node (it is,
// but this keeps the reader dependency-free and explicit about malformed
// sequences).
function utf8Decode(bytes, start, end) {
  let out = '';
  let i = start;
  while (i < end) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if (b0 >= 0xc0 && b0 < 0xe0) {
      if (i + 1 >= end) throw new MvtDecodeError('Tile text is malformed.');
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      if (i + 2 >= end) throw new MvtDecodeError('Tile text is malformed.');
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f),
      );
      i += 3;
    } else if (b0 >= 0xf0) {
      if (i + 3 >= end) throw new MvtDecodeError('Tile text is malformed.');
      const code =
        ((b0 & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const adjusted = code - 0x10000;
      out += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
      i += 4;
    } else {
      throw new MvtDecodeError('Tile text is malformed.');
    }
  }
  return out;
}

// Protobuf zig-zag decode (geometry parameters and command integers that are
// signed are stored this way).
function zigzag(value) {
  return (value >>> 1) ^ -(value & 1);
}

// One Feature message: id, tags, type and geometry command integers.
function readFeature(reader) {
  const feature = { id: null, tags: [], type: null, commands: [] };
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 0) {
      feature.id = reader.readVarint();
    } else if (field === 2 && wire === 2) {
      const packed = reader.readByteView();
      while (!packed.done) feature.tags.push(packed.readVarint());
    } else if (field === 3 && wire === 0) {
      feature.type = reader.readVarint();
    } else if (field === 4 && wire === 2) {
      const geom = reader.readByteView();
      while (!geom.done) {
        const command = geom.readVarint();
        const id = command & 0x7;
        const count = command >>> 3;
        const params = [];
        for (let i = 0; i < count; i += 1) {
          if (id === CMD_MOVE_TO || id === CMD_LINE_TO) {
            params.push({ dx: zigzag(geom.readVarint()), dy: zigzag(geom.readVarint()) });
          } else {
            // ClosePath carries no parameters; any other command is unknown.
            params.push(null);
          }
        }
        feature.commands.push({ id, count, params });
      }
    } else {
      reader.skip(wire);
    }
  }
  return feature;
}

// One Layer message: name, version, extent, features and the key/value tables.
function readLayer(reader) {
  const layer = { name: null, version: 1, extent: 4096, features: [], keys: [], values: [] };
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) layer.name = reader.readString();
    else if (field === 2 && wire === 2) layer.features.push(readFeature(reader.readByteView()));
    else if (field === 3 && wire === 2) layer.keys.push(reader.readString());
    else if (field === 4 && wire === 2) layer.values.push(readValue(reader.readByteView()));
    else if (field === 5 && wire === 0) layer.extent = reader.readVarint();
    else if (field === 15 && wire === 0) layer.version = reader.readVarint();
    else reader.skip(wire);
  }
  return layer;
}

// One Value message. Only the string variant is meaningful to place search;
// every other protobuf variant decodes to null.
function readValue(reader) {
  let value = null;
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 1 && wire === 2) value = reader.readString();
    else reader.skip(wire);
  }
  return value;
}

// The first vertex of a feature's geometry, in the layer's tile units. The
// cursor is carried forward across commands exactly as the spec requires, and
// a MoveTo resets it. Returns null when the feature holds no readable point.
function firstVertex(commands) {
  let x = 0;
  let y = 0;
  let seen = false;
  for (const command of commands) {
    if (command.id !== CMD_MOVE_TO && command.id !== CMD_LINE_TO) continue;
    for (const param of command.params) {
      if (!param) continue;
      x += param.dx;
      y += param.dy;
      if (!seen) {
        seen = true;
        return { x, y };
      }
    }
  }
  return null;
}

// Web-mercator pixel coordinate inside a z/x/y tile -> longitude/latitude.
// The projection inverse is the standard one; it never throws (tile units are
// already integers).
export function tilePointToLonLat({ x, y }, { z, x: tileX, y: tileY }, extent = 4096) {
  const size = Math.pow(2, z);
  const worldX = (tileX + x / extent) / size;
  const worldY = (tileY + y / extent) / size;
  const lon = worldX * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY)));
  return { lon, lat: (latRad * 180) / Math.PI };
}

// Read a tile's `place` features.
//
// Returns an array of `{ id, name, latinName, klass, lon, lat }` — one entry
// per named place feature. `latinName` and `klass` are null when the feature
// does not carry them. Malformed bytes throw MvtDecodeError; an unknown or
// absent `place` layer yields an empty array (a tile with no places is a real
// answer, not a failure).
export function readPlaceFeatures(bytes, tileRef, { extent = null } = {}) {
  if (!(bytes instanceof Uint8Array)) {
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    else if (ArrayBuffer.isView(bytes)) bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    else throw new MvtDecodeError('Tile data is not a byte buffer.');
  }
  const reader = new Reader(bytes);
  const out = [];
  while (!reader.done) {
    const { field, wire } = reader.readTag();
    if (field === 3 && wire === 2) {
      const layer = readLayer(reader.readByteView());
      if (layer.name !== PLACE_LAYER) continue;
      const layerExtent = extent || layer.extent || 4096;
      for (const feature of layer.features) {
        const entry = placeFromFeature(feature, layer, layerExtent, tileRef);
        if (entry) out.push(entry);
      }
    } else {
      reader.skip(wire);
    }
  }
  return out;
}

// Map one decoded feature through the layer's tag tables. Returns null when
// the feature has no name (the only field offline search can honestly use) or
// no readable point.
function placeFromFeature(feature, layer, extent, tileRef) {
  const props = {};
  for (let i = 0; i + 1 < feature.tags.length; i += 2) {
    const key = layer.keys[feature.tags[i]];
    const value = layer.values[feature.tags[i + 1]];
    if (typeof key === 'string') props[key] = value;
  }
  const name = typeof props.name === 'string' ? props.name.trim() : '';
  if (!name) return null;
  const vertex = firstVertex(feature.commands);
  if (!vertex || !tileRef) return null;
  const { lon, lat } = tilePointToLonLat(vertex, tileRef, extent);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const latinRaw =
    (typeof props['name:latin'] === 'string' && props['name:latin']) ||
    (typeof props['name:en'] === 'string' && props['name:en']) ||
    null;
  const latinName = latinRaw && latinRaw.trim() && latinRaw.trim() !== name ? latinRaw.trim() : null;
  const klass = typeof props.class === 'string' && props.class.trim() ? props.class.trim() : null;
  return {
    id: feature.id != null ? String(feature.id) : null,
    name,
    latinName,
    klass,
    lon,
    lat,
  };
}
