/**
 * Terrain colours for the Three.js map, split so the coastline can be drawn
 * smooth instead of following tile edges.
 *
 * The shader filters the colour textures linearly and the land mask with a
 * smoothing cubic. Where the mask reads above one half it draws the land
 * colours, below it the water colours, so the coast follows the mask's
 * contour, which rounds off tile corners. Filtering never mixes land and
 * water colours across the coast: in the land colours every water tile is
 * sand, and in the water colours every land tile is shore water.
 *
 * Two more textures feed the shaders' surface detail: which kind of ground
 * each tile is, and how deep the water is.
 */

import {
  buildTerrainRGBA,
  encodeTerrainTile,
  type TerrainColorOverrides,
} from "../gl/utils/ColorUtils";

const LAND_BIT = 0x80;
const SHORELINE_BIT = 0x40;
const MAGNITUDE_MASK = 0x1f;
const IMPASSABLE_MAGNITUDE = 31;
/** Depth texture units per tile of distance to land. */
export const DEPTH_SCALE = 8;

export interface CoastTextures {
  /** RGBA, the colour of every land tile; water tiles are sand. */
  readonly land: Uint8Array;
  /** RGBA, the colour of every water tile; land tiles are shore water. */
  readonly water: Uint8Array;
  /** One byte per tile: 255 for land, 0 for water. */
  readonly mask: Uint8Array;
  /**
   * RGBA, which ground each tile is, for the terrain detail: plains, highland,
   * mountain and sand (beaches; water tiles count as sand, like the land
   * colours) are 255 in R, G, B and A respectively.
   */
  readonly kind: Uint8Array;
  /** One byte per tile: water depth (distance to land) x DEPTH_SCALE. */
  readonly depth: Uint8Array;
}

export function buildCoastTextures(
  terrain: Uint8Array,
  w: number,
  h: number,
  colors?: TerrainColorOverrides,
): CoastTextures {
  const land = buildTerrainRGBA(terrain, w, h, colors);
  const water = land.slice();
  const mask = new Uint8Array(w * h);
  const kind = new Uint8Array(w * h * 4);
  const depth = new Uint8Array(w * h);
  const sand = new Uint8Array(4);
  encodeTerrainTile(LAND_BIT | SHORELINE_BIT, sand, 0, colors);
  const shore = new Uint8Array(4);
  encodeTerrainTile(SHORELINE_BIT, shore, 0, colors);
  for (let i = 0; i < w * h; i++) {
    const t = terrain[i];
    const magnitude = t & MAGNITUDE_MASK;
    if (t & LAND_BIT) {
      mask[i] = 255;
      water.set(shore, i * 4);
      kind[i * 4 + groundKind(t)] = 255;
    } else {
      land.set(sand, i * 4);
      kind[i * 4 + 3] = 255;
      depth[i] = Math.min(255, (magnitude + 1) * DEPTH_SCALE);
    }
  }
  return { land, water, mask, kind, depth };
}

/** Channel of a land tile in the kind texture, by the 2D map's colour bands. */
function groundKind(terrainByte: number): number {
  const magnitude = terrainByte & MAGNITUDE_MASK;
  if (magnitude === IMPASSABLE_MAGNITUDE) return 2;
  if (terrainByte & SHORELINE_BIT) return 3;
  if (magnitude < 10) return 0;
  if (magnitude < 20) return 1;
  return 2;
}
