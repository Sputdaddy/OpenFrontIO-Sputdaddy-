import { describe, expect, it } from "vitest";
import {
  buildHeightGrid,
  buildReliefNormals,
  gridStep,
  tileHeight,
} from "../src/client/render/three/Heightfield";

const LAND = 0x80;
const land = (magnitude: number) => LAND | magnitude;
const water = (distance: number) => distance;

describe("Three.js heightfield", () => {
  it("raises land with magnitude and sinks water with distance to shore", () => {
    expect(tileHeight(land(0))).toBeGreaterThan(0);
    expect(tileHeight(land(25))).toBeGreaterThan(tileHeight(land(5)));
    expect(tileHeight(water(1))).toBeLessThan(0);
    expect(tileHeight(water(20))).toBeLessThan(tileHeight(water(2)));
  });

  it("keeps the mesh under a million vertices on big maps", () => {
    expect(gridStep(100, 100)).toBe(2);
    const w = 4000;
    const h = 2000;
    const step = gridStep(w, h);
    expect((Math.ceil(w / step) + 1) * (Math.ceil(h / step) + 1)).toBeLessThan(
      1_100_000,
    );
  });

  it("covers the whole map, land above sea level and water below", () => {
    const w = 20;
    const h = 10;
    // Left half land, right half water.
    const terrain = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        terrain[y * w + x] = x < w / 2 ? land(10) : water(5);
      }
    }
    const geo = buildHeightGrid(terrain, w, h);
    const pos = geo.getAttribute("position");
    let maxX = 0;
    let maxZ = 0;
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      maxX = Math.max(maxX, x);
      maxZ = Math.max(maxZ, pos.getZ(v));
      const tx = Math.min(w - 1, Math.floor(x));
      if (tx < w / 2) expect(pos.getY(v)).toBeGreaterThan(0);
      else expect(pos.getY(v)).toBeLessThan(0);
    }
    expect(maxX).toBe(w);
    expect(maxZ).toBe(h);

    // Every triangle faces up.
    geo.computeVertexNormals();
    const normals = geo.getAttribute("normal");
    for (let v = 0; v < normals.count; v++) {
      expect(normals.getY(v)).toBeGreaterThan(0);
    }
  });

  it("tilts relief normals away from rising ground", () => {
    const w = 5;
    const h = 5;
    // Height rises to the east.
    const terrain = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) terrain[y * w + x] = land(x * 4);
    }
    const n = buildReliefNormals(terrain, w, h);
    const centre = (2 * w + 2) * 4;
    expect(n[centre]).toBeLessThan(128); // normal x points west
    expect(Math.abs(n[centre + 1] - 128)).toBeLessThanOrEqual(1); // flat north-south
    expect(n[centre + 2]).toBeGreaterThan(128); // still facing up
  });
});
