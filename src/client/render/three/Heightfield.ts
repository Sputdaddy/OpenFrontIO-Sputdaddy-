/**
 * Terrain heights for the Three.js map, derived from the per-tile terrain
 * bytes (layout in GameMapImpl: bit 7 land, bit 6 shoreline, bits 0-4
 * magnitude). Land magnitude is elevation; water magnitude is distance to
 * land, used here as depth.
 *
 * Most land is kept low and gently rolling. Mountains (magnitude 20+) rise
 * into clusters of peaks, and scattered hills, placed by a fixed hash so
 * every load looks the same, break up the lowlands.
 *
 * World space is tile space: tile (x, y) covers x..x+1 on the X axis and
 * y..y+1 on the Z axis, with Y up and sea level at 0.
 */

import { BufferAttribute, BufferGeometry } from "three";

const LAND_BIT = 0x80;
const MAGNITUDE_MASK = 0x1f;
const IMPASSABLE_MAGNITUDE = 31;
// Most vertices the terrain mesh is allowed to have; bigger maps get a
// coarser grid (the per-tile relief normal map carries the fine detail).
const MAX_GRID_VERTICES = 1_000_000;

// Land height per magnitude step: plains barely rise, highlands a little
// more, and only mountains climb.
const LAND_BASE = 0.5;
const PLAINS_RISE = 0.04;
const HIGHLAND_START = 10;
const HIGHLAND_RISE = 0.06;
const MOUNTAIN_START = 19;
const MOUNTAIN_RISE = 0.55;
// Impassable terrain reads as high ground rather than the tallest peaks.
const IMPASSABLE_AS = 22;

// Scattered hills: at most one per HILL_CELL x HILL_CELL tiles.
const HILL_CELL = 48;
const HILL_CHANCE = 0.3;
const HILL_RADIUS = [7, 18] as const;
const HILL_HEIGHT = [1.2, 3.6] as const;
// Now and then a hill is a lone mountain instead.
const BIG_HILL_CHANCE = 0.15;
const BIG_HILL_HEIGHT = [5, 8.5] as const;

/** Height a tile gets from its magnitude below the mountain line. */
function baseHeight(terrainByte: number): number {
  const magnitude = terrainByte & MAGNITUDE_MASK;
  if (terrainByte & LAND_BIT) {
    const m = landMagnitude(terrainByte);
    return (
      LAND_BASE +
      m * PLAINS_RISE +
      Math.max(0, m - HIGHLAND_START) * HIGHLAND_RISE
    );
  }
  return -1 - Math.min(magnitude, 30) * 0.3;
}

/** Height a tile gets from being a mountain, before peaks are shaped. */
function mountainHeight(terrainByte: number): number {
  if (!(terrainByte & LAND_BIT)) return 0;
  return (
    Math.max(0, landMagnitude(terrainByte) - MOUNTAIN_START) * MOUNTAIN_RISE
  );
}

function landMagnitude(terrainByte: number): number {
  const magnitude = terrainByte & MAGNITUDE_MASK;
  return magnitude >= IMPASSABLE_MAGNITUDE ? IMPASSABLE_AS : magnitude;
}

/** Raw height of one tile in world units (without peaks and hills). */
export function tileHeight(terrainByte: number): number {
  return baseHeight(terrainByte) + mountainHeight(terrainByte);
}

/** Tiles between grid vertices for a map of this size. */
export function gridStep(mapW: number, mapH: number): number {
  return Math.max(2, Math.ceil(Math.sqrt((mapW * mapH) / MAX_GRID_VERTICES)));
}

/**
 * The terrain mesh: a regular grid every `gridStep` tiles, each vertex at the
 * smoothed average height of the tiles around it. Coastlines stay on the right
 * side of sea level so land never sinks under the water plane.
 */
export function buildHeightGrid(
  terrain: Uint8Array,
  mapW: number,
  mapH: number,
): BufferGeometry {
  const step = gridStep(mapW, mapH);
  const gw = Math.ceil(mapW / step) + 1;
  const gh = Math.ceil(mapH / step) + 1;

  // Average tile heights (and how much of it is land) into the nearest
  // vertex.
  const base = new Float32Array(gw * gh);
  const mountain = new Float32Array(gw * gh);
  const landShare = new Float32Array(gw * gh);
  const count = new Uint16Array(gw * gh);
  for (let y = 0; y < mapH; y++) {
    const gy = Math.round((y + 0.5) / step);
    for (let x = 0; x < mapW; x++) {
      const g = gy * gw + Math.round((x + 0.5) / step);
      const t = terrain[y * mapW + x];
      base[g] += baseHeight(t);
      mountain[g] += mountainHeight(t);
      if (t & LAND_BIT) landShare[g]++;
      count[g]++;
    }
  }
  for (let g = 0; g < count.length; g++) {
    if (count[g] === 0) continue;
    base[g] /= count[g];
    mountain[g] /= count[g];
    landShare[g] /= count[g];
  }
  const smooth = (a: Float32Array) => blur3(blur3(a, gw, gh), gw, gh);
  const baseS = smooth(base);
  const mountainS = smooth(mountain);
  // Fades hills out toward the coast.
  const inland = smooth(smooth(landShare));
  const heights = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const g = j * gw + i;
      const wx = i * step;
      const wy = j * step;
      const hills = smoothstep(0.55, 1, inland[g]);
      heights[g] =
        baseS[g] +
        (mountainS[g] > 0 ? mountainS[g] * peaks(wx, wy) : 0) +
        (hills > 0 ? hills * hillsAt(wx, wy) : 0);
    }
  }

  const positions = new Float32Array(gw * gh * 3);
  const uvs = new Float32Array(gw * gh * 2);
  for (let j = 0; j < gh; j++) {
    const wy = Math.min(j * step, mapH);
    const ty = Math.min(mapH - 1, Math.floor(wy));
    for (let i = 0; i < gw; i++) {
      const wx = Math.min(i * step, mapW);
      const tx = Math.min(mapW - 1, Math.floor(wx));
      const g = j * gw + i;
      const land = (terrain[ty * mapW + tx] & LAND_BIT) !== 0;
      const h = land ? Math.max(heights[g], 0.4) : Math.min(heights[g], -0.3);
      positions[g * 3] = wx;
      positions[g * 3 + 1] = h;
      positions[g * 3 + 2] = wy;
      uvs[g * 2] = wx / mapW;
      uvs[g * 2 + 1] = wy / mapH;
    }
  }

  // Two triangles per cell, wound so their normals face +Y.
  const index = new Uint32Array((gw - 1) * (gh - 1) * 6);
  let k = 0;
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const a = j * gw + i;
      const b = a + 1;
      const c = a + gw;
      const d = c + 1;
      index[k++] = a;
      index[k++] = c;
      index[k++] = b;
      index[k++] = b;
      index[k++] = c;
      index[k++] = d;
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("uv", new BufferAttribute(uvs, 2));
  geo.setIndex(new BufferAttribute(index, 1));
  geo.computeVertexNormals();
  return geo;
}

/**
 * Shapes mountain ground into separate peaks: a multiplier around 0.7 that
 * varies over a few tiles.
 */
function peaks(x: number, y: number): number {
  const n =
    0.65 * valueNoise(x / 16, y / 16, 1) + 0.35 * valueNoise(x / 6, y / 6, 2);
  return 0.3 + 1.1 * n * n;
}

/** Height of the scattered hills at a point in tile space. */
export function hillsAt(x: number, y: number): number {
  const cx = Math.floor(x / HILL_CELL);
  const cy = Math.floor(y / HILL_CELL);
  let total = 0;
  // Hills are smaller than a cell, so only the neighbouring cells reach.
  for (let gy = cy - 1; gy <= cy + 1; gy++) {
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      if (hash(gx, gy, 11) >= HILL_CHANCE) continue;
      const dx = x - (gx + hash(gx, gy, 12)) * HILL_CELL;
      const dy = y - (gy + hash(gx, gy, 13)) * HILL_CELL;
      // An ellipse at a random angle, so hills aren't all round.
      const r = lerp(HILL_RADIUS[0], HILL_RADIUS[1], hash(gx, gy, 14));
      const angle = hash(gx, gy, 15) * Math.PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const u = (dx * cos + dy * sin) / r;
      const v = (dy * cos - dx * sin) / (r * (0.5 + 0.5 * hash(gx, gy, 16)));
      const d2 = u * u + v * v;
      if (d2 >= 1) continue;
      const [lo, hi] =
        hash(gx, gy, 17) < BIG_HILL_CHANCE ? BIG_HILL_HEIGHT : HILL_HEIGHT;
      const height = lerp(lo, hi, hash(gx, gy, 18));
      total += height * (1 - d2) * (1 - d2);
    }
  }
  if (total === 0) return 0;
  // Rough up the slopes a little.
  return total * (0.75 + 0.5 * valueNoise(x / 5, y / 5, 19));
}

/** Smooth noise in 0..1 with features about one unit apart. */
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const top = lerp(hash(x0, y0, seed), hash(x0 + 1, y0, seed), sx);
  const bottom = lerp(hash(x0, y0 + 1, seed), hash(x0 + 1, y0 + 1, seed), sx);
  return lerp(top, bottom, sy);
}

/** A fixed pseudo-random number in [0, 1) for an integer point and seed. */
function hash(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x | 0, 374761393) ^
    Math.imul(y | 0, 668265263) ^
    Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(lo: number, hi: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * Per-tile relief as a tangent-space normal map (RGBA8, row 0 = tile row 0),
 * from a Sobel gradient of the raw tile heights. Water is flat: the water
 * plane above it carries its own shading.
 */
export function buildReliefNormals(
  terrain: Uint8Array,
  mapW: number,
  mapH: number,
): Uint8Array {
  const out = new Uint8Array(mapW * mapH * 4);
  const h = (x: number, y: number): number => {
    const cx = x < 0 ? 0 : x >= mapW ? mapW - 1 : x;
    const cy = y < 0 ? 0 : y >= mapH ? mapH - 1 : y;
    return tileHeight(terrain[cy * mapW + cx]);
  };
  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const i = y * mapW + x;
      let nx = 0;
      let ny = 0;
      if (terrain[i] & LAND_BIT) {
        // dh/dx and dh/dy (tile y = +Z = +v), 3x3 Sobel / 8.
        const dx =
          (h(x + 1, y - 1) +
            2 * h(x + 1, y) +
            h(x + 1, y + 1) -
            h(x - 1, y - 1) -
            2 * h(x - 1, y) -
            h(x - 1, y + 1)) /
          8;
        const dy =
          (h(x - 1, y + 1) +
            2 * h(x, y + 1) +
            h(x + 1, y + 1) -
            h(x - 1, y - 1) -
            2 * h(x, y - 1) -
            h(x + 1, y - 1)) /
          8;
        nx = -dx;
        ny = -dy;
      }
      const len = Math.hypot(nx, ny, 1);
      out[i * 4] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      out[i * 4 + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      out[i * 4 + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

/** 3x3 box blur over a w×h grid, clamped at the edges. */
function blur3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += src[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

/**
 * Heights of the drawn surface, read back from a mesh built by
 * buildHeightGrid: the terrain where it is above sea level, else the water
 * plane at 0. Bilinear between grid vertices, so it matches the mesh.
 */
export class SurfaceHeights {
  readonly maxHeight: number;
  private readonly step: number;
  private readonly gw: number;
  private readonly gh: number;
  private readonly heights: Float32Array;

  constructor(geometry: BufferGeometry, mapW: number, mapH: number) {
    this.step = gridStep(mapW, mapH);
    this.gw = Math.ceil(mapW / this.step) + 1;
    this.gh = Math.ceil(mapH / this.step) + 1;
    const pos = geometry.getAttribute("position");
    this.heights = new Float32Array(this.gw * this.gh);
    let max = 0;
    for (let g = 0; g < this.heights.length; g++) {
      const h = Math.max(0, pos.getY(g));
      this.heights[g] = h;
      max = Math.max(max, h);
    }
    this.maxHeight = max;
  }

  /** Surface height at a point in tile space (x east, y south). */
  at(x: number, y: number): number {
    const gx = clamp(x / this.step, 0, this.gw - 1);
    const gy = clamp(y / this.step, 0, this.gh - 1);
    const i = Math.min(Math.floor(gx), this.gw - 2);
    const j = Math.min(Math.floor(gy), this.gh - 2);
    const fx = gx - i;
    const fy = gy - j;
    const h = this.heights;
    const a = j * this.gw + i;
    const top = h[a] + (h[a + 1] - h[a]) * fx;
    const bottom = h[a + this.gw] + (h[a + this.gw + 1] - h[a + this.gw]) * fx;
    return top + (bottom - top) * fy;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
