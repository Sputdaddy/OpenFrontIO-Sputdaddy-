/**
 * Terrain colours for the Three.js map, split so the coastline can be drawn
 * smooth instead of following tile edges.
 *
 * The shader filters all three textures linearly. Where the land mask reads
 * above one half it draws the land colours, below it the water colours, so
 * the coast follows the mask's contour, which cuts tile corners diagonally.
 * Filtering never mixes land and water colours across the coast: in the land
 * colours every water tile is sand, and in the water colours every land tile
 * is shore water.
 */

import {
  buildTerrainRGBA,
  encodeTerrainTile,
  type TerrainColorOverrides,
} from "../gl/utils/ColorUtils";

const LAND_BIT = 0x80;
const SHORELINE_BIT = 0x40;

export interface CoastTextures {
  /** RGBA, the colour of every land tile; water tiles are sand. */
  readonly land: Uint8Array;
  /** RGBA, the colour of every water tile; land tiles are shore water. */
  readonly water: Uint8Array;
  /** One byte per tile: 255 for land, 0 for water. */
  readonly mask: Uint8Array;
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
  const sand = new Uint8Array(4);
  encodeTerrainTile(LAND_BIT | SHORELINE_BIT, sand, 0, colors);
  const shore = new Uint8Array(4);
  encodeTerrainTile(SHORELINE_BIT, shore, 0, colors);
  for (let i = 0; i < w * h; i++) {
    if (terrain[i] & LAND_BIT) {
      mask[i] = 255;
      water.set(shore, i * 4);
    } else {
      land.set(sand, i * 4);
    }
  }
  return { land, water, mask };
}
