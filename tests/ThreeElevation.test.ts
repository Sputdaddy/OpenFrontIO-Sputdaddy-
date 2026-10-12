import { describe, expect, it } from "vitest";
import {
  cameraTilt,
  clampTilt,
  drawnGroundY,
  MAX_TILT_DEGREES,
  maxRaise,
  seaLevelY,
  type SurfaceElevation,
  surfaceUnderGroundPoint,
} from "../src/client/render/three/Elevation";
import {
  footprintTop,
  headingFor,
  turnBetween,
} from "../src/client/render/three/UnitModels";

const flat: SurfaceElevation = {
  maxHeight: 0,
  heightAt: () => 0,
};

// Ground 10 high for 20 <= y < 40, sea level elsewhere.
const plateau: SurfaceElevation = {
  maxHeight: 10,
  heightAt: (_x, y) => (y >= 20 && y < 40 ? 10 : 0),
};

// Ground rising 0.2 per tile to the south.
const slope: SurfaceElevation = {
  maxHeight: 20,
  heightAt: (_x, y) => Math.min(20, Math.max(0, y * 0.2)),
};

const straightDown = cameraTilt(0, 30);
const tilt45 = cameraTilt(45, 30);

describe("3D map elevation", () => {
  it("looks like the flat map when the camera points straight down", () => {
    expect(surfaceUnderGroundPoint(plateau, straightDown, 12.5, 25)).toEqual({
      x: 12.5,
      y: 25,
    });
    expect(drawnGroundY(plateau, straightDown, 3, 25)).toBe(25);
  });

  it("foreshortens sea level about the middle of the view", () => {
    // 10 rows south of the centre are drawn 10 * cos(45°) rows south of it.
    expect(drawnGroundY(flat, tilt45, 3, 40)).toBeCloseTo(
      30 + 10 * Math.SQRT1_2,
    );
    expect(drawnGroundY(flat, tilt45, 3, 30)).toBe(30);
    expect(seaLevelY(tilt45, 30 - 10 * Math.SQRT1_2)).toBeCloseTo(20);
    const hit = surfaceUnderGroundPoint(flat, tilt45, 12.5, 30 + 5);
    expect(hit.x).toBe(12.5);
    expect(hit.y).toBeCloseTo(30 + 5 * Math.SQRT2);
  });

  it("draws raised ground further up the screen", () => {
    // The plateau at y = 30 (the centre) is drawn 10 * sin(45°) rows up.
    expect(drawnGroundY(plateau, tilt45, 5, 30)).toBeCloseTo(
      30 - 10 * Math.SQRT1_2,
    );
    expect(maxRaise(plateau, tilt45)).toBeCloseTo(10);
  });

  it("picks the raised tile drawn under the cursor", () => {
    // Seen at 45°, the plateau's top (y 20 to 40) is drawn from ground row
    // 30 + (20 - 30 - 10) * cos to 30 + (40 - 30 - 10) * cos.
    const top = 30 - 20 * Math.SQRT1_2;
    const hit = surfaceUnderGroundPoint(plateau, tilt45, 5, top + 1);
    expect(hit.x).toBe(5);
    expect(hit.y).toBeCloseTo(20 + Math.SQRT2, 1);
    // Just north of the drawn top it's sea level.
    expect(surfaceUnderGroundPoint(plateau, tilt45, 5, top - 1).y).toBeCloseTo(
      seaLevelY(tilt45, top - 1),
      5,
    );
  });

  it("round-trips across a slope at every tilt", () => {
    for (const degrees of [0, 20, 35, 55, MAX_TILT_DEGREES]) {
      const t = cameraTilt(degrees, 40);
      for (const y of [5, 17.3, 42, 80]) {
        const back = surfaceUnderGroundPoint(
          slope,
          t,
          7,
          drawnGroundY(slope, t, 7, y),
        );
        expect(back.y).toBeCloseTo(y, 1);
      }
    }
  });

  it("keeps the tilt between straight down and the lowest angle", () => {
    expect(clampTilt(-5)).toBe(0);
    expect(clampTilt(40)).toBe(40);
    expect(clampTilt(120)).toBe(MAX_TILT_DEGREES);
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
