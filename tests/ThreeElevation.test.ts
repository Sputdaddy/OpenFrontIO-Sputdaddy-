import { describe, expect, it } from "vitest";
import {
  drawnGroundPoint,
  type SurfaceElevation,
  surfaceUnderGroundPoint,
} from "../src/client/render/three/Elevation";
import {
  footprintTop,
  headingFor,
  turnBetween,
} from "../src/client/render/three/UnitModels";

const flat: SurfaceElevation = {
  shift: 0.7,
  maxHeight: 0,
  heightAt: () => 0,
};

// Ground 10 high for 20 <= y < 40, sea level elsewhere.
const plateau: SurfaceElevation = {
  shift: 0.7,
  maxHeight: 10,
  heightAt: (_x, y) => (y >= 20 && y < 40 ? 10 : 0),
};

// Ground rising 0.2 per tile to the south.
const slope: SurfaceElevation = {
  shift: 0.7,
  maxHeight: 20,
  heightAt: (_x, y) => Math.min(20, Math.max(0, y * 0.2)),
};

describe("3D map elevation", () => {
  it("leaves sea level where the flat camera puts it", () => {
    expect(surfaceUnderGroundPoint(flat, 12.5, 30.25)).toEqual({
      x: 12.5,
      y: 30.25,
    });
    expect(drawnGroundPoint(flat, 3, 4)).toEqual({ x: 3, y: 4 });
  });

  it("draws raised ground further up the screen", () => {
    expect(drawnGroundPoint(plateau, 5, 30)).toEqual({ x: 5, y: 23 });
  });

  it("picks the raised tile drawn under the cursor", () => {
    // The plateau's top is drawn from y = 13 to 33.
    const hit = surfaceUnderGroundPoint(plateau, 5, 15);
    expect(hit.x).toBe(5);
    expect(hit.y).toBeCloseTo(22, 1);
    // North of the drawn top it's sea level.
    expect(surfaceUnderGroundPoint(plateau, 5, 10).y).toBeCloseTo(10, 5);
  });

  it("round-trips across a slope", () => {
    for (const y of [5, 17.3, 42, 80]) {
      const drawn = drawnGroundPoint(slope, 7, y);
      const back = surfaceUnderGroundPoint(slope, drawn.x, drawn.y);
      expect(back.y).toBeCloseTo(y, 1);
    }
  });
});

describe("3D unit headings", () => {
  it("points the bow (+Z) along the direction of travel", () => {
    expect(headingFor(0, 1)).toBeCloseTo(0);
    expect(headingFor(1, 0)).toBeCloseTo(Math.PI / 2);
    expect(headingFor(-1, 0)).toBeCloseTo(-Math.PI / 2);
  });

  it("turns the short way round", () => {
    expect(turnBetween(0.1, -0.1)).toBeCloseTo(-0.2);
    expect(turnBetween(3, -3)).toBeCloseTo(2 * Math.PI - 6);
    expect(turnBetween(-3, 3)).toBeCloseTo(6 - 2 * Math.PI);
  });
});

describe("3D structure placement", () => {
  it("stands on the highest ground under the footprint", () => {
    // A structure 10 wide centred at y = 18 reaches onto the plateau.
    expect(footprintTop(plateau.heightAt, 50, 18, 10)).toBe(10);
    // One centred well below the plateau doesn't.
    expect(footprintTop(plateau.heightAt, 50, 10, 10)).toBe(0);
  });
});
