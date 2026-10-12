import { describe, expect, it } from "vitest";
import {
  buildTerrainRGBA,
  encodeTerrainTile,
} from "../src/client/render/gl/utils/ColorUtils";
import {
  buildCoastTextures,
  DEPTH_SCALE,
} from "../src/client/render/three/CoastTextures";

const LAND = 0x80;
const SHORE = 0x40;

function colorOf(byte: number): number[] {
  const out = new Uint8Array(4);
  encodeTerrainTile(byte, out, 0);
  return [...out];
}

describe("Three.js coast textures", () => {
  // One row: plains, shoreline sand, shoreline water, deep water.
  const terrain = new Uint8Array([LAND | 5, LAND | SHORE | 2, SHORE | 1, 8]);
  const { land, water, mask, depth } = buildCoastTextures(terrain, 4, 1);
  const tile = (rgba: Uint8Array, i: number) => [
    ...rgba.slice(i * 4, i * 4 + 4),
  ];
  const base = buildTerrainRGBA(terrain, 4, 1);

  it("marks land in the mask", () => {
    expect([...mask]).toEqual([255, 255, 0, 0]);
  });

  it("keeps land colours on land and fills water with sand", () => {
    expect(tile(land, 0)).toEqual(tile(base, 0));
    expect(tile(land, 1)).toEqual(tile(base, 1));
    expect(tile(land, 2)).toEqual(colorOf(LAND | SHORE));
    expect(tile(land, 3)).toEqual(colorOf(LAND | SHORE));
  });

  it("keeps water colours on water and fills land with shore water", () => {
    expect(tile(water, 2)).toEqual(tile(base, 2));
    expect(tile(water, 3)).toEqual(tile(base, 3));
    expect(tile(water, 0)).toEqual(colorOf(SHORE));
    expect(tile(water, 1)).toEqual(colorOf(SHORE));
  });

  it("records how deep the water is", () => {
    expect([...depth]).toEqual([0, 0, 2 * DEPTH_SCALE, 9 * DEPTH_SCALE]);
  });

  it("sorts tiles into plains, highland, mountain and sand", () => {
    const tiles = new Uint8Array([
      LAND | 3,
      LAND | 12,
      LAND | 25,
      LAND | 31,
      LAND | SHORE | 4,
      SHORE | 1,
    ]);
    const { kind } = buildCoastTextures(tiles, tiles.length, 1);
    const channel = (i: number) => kind.slice(i * 4, i * 4 + 4).indexOf(255);
    // R plains, G highland, B mountain (impassable too), A sand and water.
    expect(tiles.map((_, i) => channel(i))).toEqual(
      new Uint8Array([0, 1, 2, 2, 3, 3]),
    );
    for (let i = 0; i < tiles.length; i++) {
      expect(kind.slice(i * 4, i * 4 + 4).reduce((a, b) => a + b)).toBe(255);
    }
  });
});
