import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GROUND_LAYERS,
  meanLinearColor,
  packGroundLayer,
  type PhotoMap,
} from "../src/client/render/three/GroundPhotos";

/** A w-pixel RGBA image filled with one value per channel. */
function solid(pixels: number, rgba: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) out.set(rgba, i * 4);
  return out;
}

describe("Three.js ground photos", () => {
  it("has a photo for every kind of ground the terrain shader paints", () => {
    expect(GROUND_LAYERS.map((l) => l.key).sort()).toEqual(
      ["dry", "forest", "grass", "rock", "sand", "snow"].sort(),
    );
    for (const layer of GROUND_LAYERS) {
      expect(layer.tiles).toBeGreaterThan(0);
      expect(layer.tint).toBeGreaterThanOrEqual(0);
      expect(layer.tint).toBeLessThanOrEqual(1);
      expect(layer.polyhaven).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("has the photos for every layer downloaded", () => {
    const dir = path.join(__dirname, "../resources/textures/terrain");
    const index = JSON.parse(
      fs.readFileSync(path.join(dir, "index.json"), "utf8"),
    ) as { layers: Record<string, Partial<Record<PhotoMap, string>>> };
    for (const layer of GROUND_LAYERS) {
      const files = index.layers[layer.key];
      expect(files?.color, layer.key).toBeDefined();
      expect(files?.normal, layer.key).toBeDefined();
      for (const file of Object.values(files)) {
        expect(fs.existsSync(path.join(dir, file)), file).toBe(true);
      }
    }
  });

  it("packs colour with roughness, and normal with height, into a layer", () => {
    const pixels = 2;
    const color = new Uint8Array(pixels * 4 * 2);
    const normal = new Uint8Array(pixels * 4 * 2);
    const ok = packGroundLayer(
      pixels,
      1,
      {
        color: solid(pixels, [10, 20, 30, 255]),
        normal: solid(pixels, [120, 140, 250, 255]),
        rough: solid(pixels, [200, 200, 200, 255]),
        height: solid(pixels, [60, 60, 60, 255]),
      },
      color,
      normal,
    );
    expect(ok).toBe(true);
    expect([...color.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...color.slice(8)]).toEqual([10, 20, 30, 200, 10, 20, 30, 200]);
    expect([...normal.slice(8, 12)]).toEqual([120, 140, 250, 60]);
  });

  it("uses default roughness and height when a set has none", () => {
    const color = new Uint8Array(4);
    const normal = new Uint8Array(4);
    packGroundLayer(
      1,
      0,
      {
        color: solid(1, [1, 2, 3, 255]),
        normal: solid(1, [128, 128, 255, 255]),
        rough: null,
        height: null,
      },
      color,
      normal,
    );
    expect(color[3]).toBe(230);
    expect(normal[3]).toBe(128);
  });

  it("leaves a layer without a colour photo or normal map unused", () => {
    const color = new Uint8Array(4);
    const normal = new Uint8Array(4);
    const ok = packGroundLayer(
      1,
      0,
      {
        color: solid(1, [1, 2, 3, 255]),
        normal: null,
        rough: null,
        height: null,
      },
      color,
      normal,
    );
    expect(ok).toBe(false);
    expect([...color]).toEqual([128, 128, 128, 230]);
    expect([...normal]).toEqual([128, 128, 255, 128]);
  });

  it("averages a photo's colour in linear values", () => {
    const mean = meanLinearColor(
      new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 255]),
    );
    expect(mean.x).toBeCloseTo(0.5, 6);
    expect(mean.y).toBe(0);
    // sRGB 188 is about linear 0.5.
    const mid = meanLinearColor(solid(4, [188, 188, 188, 255]));
    expect(mid.x).toBeCloseTo(0.503, 2);
  });
});
