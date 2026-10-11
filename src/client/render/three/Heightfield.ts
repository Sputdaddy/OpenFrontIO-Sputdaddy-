/**
 * Terrain heights for the Three.js map, derived from the per-tile terrain
 * bytes (layout in GameMapImpl: bit 7 land, bit 6 shoreline, bits 0-4
 * magnitude). Land magnitude is elevation; water magnitude is distance to
 * land, used here as depth.
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

/** Raw height of one tile in world units. */
export function tileHeight(terrainByte: number): number {
  const magnitude = terrainByte & MAGNITUDE_MASK;
  if (terrainByte & LAND_BIT) {
    // Impassable terrain reads as flat high ground rather than a spike.
    const m = magnitude >= IMPASSABLE_MAGNITUDE ? 12 : magnitude;
    return 1 + m * 1.1;
  }
  return -2 - Math.min(magnitude, 30) * 0.4;
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

  // Average tile heights into their nearest vertex.
  const sum = new Float32Array(gw * gh);
  const count = new Uint16Array(gw * gh);
  for (let y = 0; y < mapH; y++) {
    const gy = Math.round((y + 0.5) / step);
    for (let x = 0; x < mapW; x++) {
      const g = gy * gw + Math.round((x + 0.5) / step);
      sum[g] += tileHeight(terrain[y * mapW + x]);
      count[g]++;
    }
  }
  let heights: Float32Array = new Float32Array(gw * gh);
  for (let g = 0; g < heights.length; g++) {
    heights[g] = count[g] > 0 ? sum[g] / count[g] : 0;
  }
  heights = blur3(blur3(heights, gw, gh), gw, gh);

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
