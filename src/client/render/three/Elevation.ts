/**
 * Screen ↔ map math for the tilted 3D camera. No three.js here, so
 * TransformHandler can use it without loading the renderer.
 *
 * The 3D map is seen through a tilted orthographic camera whose frustum is
 * squashed so that sea level lands exactly where the flat 2D camera puts it:
 * the "ground coordinates" TransformHandler computes stay right for anything
 * at sea level. Something at height h is drawn `shift * h` tiles further up
 * the screen (north), so only raised ground needs correcting.
 */

/** Camera tilt away from straight down, in degrees. */
export const TILT_DEGREES = 35;

/** Tiles a point moves up the screen per world unit of height. */
export const TILT_SHIFT = Math.tan((TILT_DEGREES * Math.PI) / 180);

export interface SurfaceElevation {
  /** Tiles a point moves up the screen per world unit of height. */
  readonly shift: number;
  /** Highest point of the drawn surface, world units. */
  readonly maxHeight: number;
  /** Height of the drawn surface (sea level is 0) at a point in tile space. */
  heightAt(x: number, y: number): number;
}

/** Where the surface point at (x, y) is drawn, in sea-level ground tiles. */
export function drawnGroundPoint(
  e: SurfaceElevation,
  x: number,
  y: number,
): { x: number; y: number } {
  return { x, y: y - e.shift * e.heightAt(x, y) };
}

const MARCH_STEP = 0.25;
const REFINE_STEPS = 6;

/**
 * The map point whose drawn surface is under a sea-level ground point (what
 * the flat camera math gives for a screen position). Walks the view ray down
 * from the highest surface toward sea level and returns the first point
 * where it meets the ground, as the camera sees it.
 */
export function surfaceUnderGroundPoint(
  e: SurfaceElevation,
  gx: number,
  gy: number,
): { x: number; y: number } {
  // Points on the ray satisfy y - shift * height = gy.
  const below = (h: number) => h <= e.heightAt(gx, gy + e.shift * h);
  let above = e.maxHeight + MARCH_STEP;
  for (let h = e.maxHeight; h > 0; h -= MARCH_STEP) {
    if (below(h)) {
      // The ray crossed the surface between `above` and `h`.
      let lo = h;
      let hi = above;
      for (let i = 0; i < REFINE_STEPS; i++) {
        const mid = (lo + hi) / 2;
        if (below(mid)) lo = mid;
        else hi = mid;
      }
      return { x: gx, y: gy + e.shift * lo };
    }
    above = h;
  }
  return { x: gx, y: gy };
}
