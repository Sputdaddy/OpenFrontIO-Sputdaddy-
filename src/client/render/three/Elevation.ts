/**
 * Screen ↔ map math for the tilted 3D camera. No three.js here, so
 * TransformHandler can use it without loading the renderer.
 *
 * The 3D map is seen through an orthographic camera that looks north at the
 * middle of the view, tilted away from straight down by an angle the player
 * picks. Across the screen it draws the map exactly as the flat 2D camera
 * does. Down the screen, sea level is foreshortened by cos(tilt) around the
 * view centre, and something at height h is drawn h * sin(tilt) tiles further
 * up the screen (north).
 *
 * The functions below take and return "ground coordinates": the map point
 * the flat 2D camera would show at a screen position, which is what
 * TransformHandler's screen math computes.
 */

/** Camera tilt away from straight down a game starts with, in degrees. */
export const DEFAULT_TILT_DEGREES = 35;
/** Straight down, like the flat map. */
export const MIN_TILT_DEGREES = 0;
/** Lowest the camera goes. Past this the far side of the map stretches away. */
export const MAX_TILT_DEGREES = 70;

export function clampTilt(degrees: number): number {
  return Math.min(MAX_TILT_DEGREES, Math.max(MIN_TILT_DEGREES, degrees));
}

export interface SurfaceElevation {
  /** Highest point of the drawn surface, world units. */
  readonly maxHeight: number;
  /** Height of the drawn surface (sea level is 0) at a point in tile space. */
  heightAt(x: number, y: number): number;
}

/** How the tilted camera is looking at the map right now. */
export interface CameraTilt {
  readonly cos: number;
  readonly sin: number;
  /** Map row in the middle of the view (where the camera looks, at sea level). */
  readonly centerY: number;
}

export function cameraTilt(degrees: number, centerY: number): CameraTilt {
  const a = (degrees * Math.PI) / 180;
  return { cos: Math.cos(a), sin: Math.sin(a), centerY };
}

/** Ground row at which the surface point at (x, y) is drawn. */
export function drawnGroundY(
  e: SurfaceElevation,
  t: CameraTilt,
  x: number,
  y: number,
): number {
  return t.centerY + (y - t.centerY) * t.cos - e.heightAt(x, y) * t.sin;
}

/** Map row of the sea-level point drawn at ground row `gy`. */
export function seaLevelY(t: CameraTilt, gy: number): number {
  return t.centerY + (gy - t.centerY) / t.cos;
}

/** Map rows the highest ground can be drawn north of where sea level is. */
export function maxRaise(e: SurfaceElevation, t: CameraTilt): number {
  return (e.maxHeight * t.sin) / t.cos;
}

// Largest step along the view ray, in tiles north-south and world units of
// height alike.
const MARCH_STEP = 0.25;
const REFINE_STEPS = 6;

/**
 * The map point whose drawn surface is at ground point (gx, gy): what a
 * click there lands on. Walks the view ray down from the highest surface
 * toward sea level and returns the first point where it meets the ground,
 * as the camera sees it.
 */
export function surfaceUnderGroundPoint(
  e: SurfaceElevation,
  t: CameraTilt,
  gx: number,
  gy: number,
): { x: number; y: number } {
  const seaY = seaLevelY(t, gy);
  // Points on the ray climb `shift` rows south per unit of height.
  const shift = t.sin / t.cos;
  if (shift <= 0) return { x: gx, y: seaY };
  const below = (h: number) => h <= e.heightAt(gx, seaY + shift * h);
  const step = MARCH_STEP / Math.max(1, shift);
  let above = e.maxHeight + step;
  for (let h = e.maxHeight; h > 0; h -= step) {
    if (below(h)) {
      // The ray crossed the surface between `above` and `h`.
      let lo = h;
      let hi = above;
      for (let i = 0; i < REFINE_STEPS; i++) {
        const mid = (lo + hi) / 2;
        if (below(mid)) lo = mid;
        else hi = mid;
      }
      return { x: gx, y: seaY + shift * lo };
    }
    above = h;
  }
  return { x: gx, y: seaY };
}
