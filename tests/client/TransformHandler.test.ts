import { Cell } from "@openfront/engine-api/game/GameTypes";
import { EventBus } from "@openfront/shared/EventBus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CameraTiltEvent,
  DragEvent,
  ZoomEvent,
} from "../../src/client/InputHandler";
import {
  DEFAULT_TILT_DEGREES,
  MAX_TILT_DEGREES,
  type SurfaceElevation,
} from "../../src/client/render/three/Elevation";
import {
  GOTO_INTERVAL_MS,
  GoToPositionEvent,
  TransformHandler,
} from "../../src/client/TransformHandler";
import { UserSettings } from "../../src/client/UserSettings";
import type { GameView } from "../../src/client/view";

function makeHandler() {
  const game = {
    width: () => 400,
    height: () => 400,
    myPlayer: () => null,
  } as unknown as GameView;
  const eventBus = new EventBus();
  const handler = new TransformHandler(
    game,
    eventBus,
    document.createElement("canvas"),
  );
  return { handler, eventBus };
}

describe("TransformHandler", () => {
  it("starts with the default camera and no pending changes", () => {
    const { handler } = makeHandler();
    expect(handler.scale).toBe(1.8);
    expect(handler.hasChanged()).toBe(false);
  });

  it("treats a goTo tick after the target was cleared as a programming error", () => {
    const { handler } = makeHandler();
    handler.override(); // clears any target
    expect(() => (handler as any).goTo()).toThrow("null target");
  });

  describe("go-to animation", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("pans toward the target each tick until manual control clears it", () => {
      const { handler, eventBus } = makeHandler();
      const startX = handler.offsetX;

      eventBus.emit(new GoToPositionEvent(500, 500));
      vi.advanceTimersByTime(GOTO_INTERVAL_MS);
      expect(handler.offsetX).not.toBe(startX);
      expect(handler.hasChanged()).toBe(true);

      // Taking manual control stops the pending go-to interval.
      handler.override(10, 20, 1);
      const [x, y] = [handler.offsetX, handler.offsetY];
      vi.advanceTimersByTime(GOTO_INTERVAL_MS * 5);
      expect(handler.offsetX).toBe(x);
      expect(handler.offsetY).toBe(y);
    });
  });
});

describe("TransformHandler on the tilted 3D map", () => {
  // A round hill 8 high in the middle of a 400 x 400 map, seen on an
  // 800 x 600 screen.
  const hill: SurfaceElevation = {
    maxHeight: 8,
    heightAt: (x, y) => Math.max(0, 8 - Math.hypot(x - 200, y - 220) / 5),
  };
  const flat: SurfaceElevation = { maxHeight: 0, heightAt: () => 0 };

  function makeTiltedHandler(elevation: SurfaceElevation | null) {
    const { handler, eventBus } = makeHandler();
    handler["_boundingRect"] = new DOMRect(0, 0, 800, 600);
    // Two pixels per tile, looking at the middle of the map.
    handler.override(-100, -50, 2);
    handler.setElevation(elevation);
    handler.resetChanged();
    return { handler, eventBus };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    new UserSettings().removeCached("settings.cameraTilt", false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores tilting on the flat map", () => {
    const { handler, eventBus } = makeTiltedHandler(null);
    eventBus.emit(new CameraTiltEvent(10));
    expect(handler.tilt()).toBe(0);
    expect(handler.hasChanged()).toBe(false);
  });

  it("tilts between straight down and the lowest angle, and remembers it", () => {
    const { handler, eventBus } = makeTiltedHandler(flat);
    expect(handler.tilt()).toBe(DEFAULT_TILT_DEGREES);

    eventBus.emit(new CameraTiltEvent(100));
    expect(handler.tilt()).toBe(MAX_TILT_DEGREES);
    expect(handler.hasChanged()).toBe(true);
    eventBus.emit(new CameraTiltEvent(-100));
    eventBus.emit(new CameraTiltEvent(12.5));
    expect(handler.tilt()).toBe(12.5);

    vi.advanceTimersByTime(1000);
    expect(makeTiltedHandler(flat).handler.tilt()).toBe(12.5);
  });

  it("lands clicks on the tile drawn under the cursor at any tilt", () => {
    const { handler, eventBus } = makeTiltedHandler(hill);
    for (const tilt of [0, 35, MAX_TILT_DEGREES]) {
      eventBus.emit(new CameraTiltEvent(tilt - handler.tilt()));
      for (const [sx, sy] of [
        [400, 300],
        [380, 250],
        [420, 330],
        [100, 500],
      ]) {
        const tile = handler.screenToWorldCoordinatesFloat(sx, sy);
        const back = handler.worldToScreenCoordinates(new Cell(tile.x, tile.y));
        expect(back.x).toBeCloseTo(sx, 1);
        expect(back.y).toBeCloseTo(sy, 1);
      }
    }
  });

  it("sees more of the map down the screen the lower the camera", () => {
    const { handler, eventBus } = makeTiltedHandler(flat);
    eventBus.emit(new CameraTiltEvent(60 - handler.tilt()));
    // Half the screen is 150 tiles tall seen straight down, 300 at 60°.
    expect(handler.screenToWorldCoordinatesFloat(400, 0).y).toBeCloseTo(-100);
    expect(handler.screenToWorldCoordinatesFloat(400, 600).y).toBeCloseTo(500);
    expect(handler.screenToWorldCoordinatesFloat(0, 300)).toEqual({
      x: 0,
      y: 200,
    });
    // Whole tiles, give or take float rounding.
    const [topLeft, bottomRight] = handler.screenBoundingRect();
    expect(Math.abs(topLeft.y + 100)).toBeLessThanOrEqual(1);
    expect(Math.abs(bottomRight.y - 500)).toBeLessThanOrEqual(1);
    expect(handler.screenCenter()).toEqual({ screenX: 200, screenY: 200 });
  });

  it("keeps the middle of the view in place while tilting", () => {
    const { handler, eventBus } = makeTiltedHandler(flat);
    const before = handler.screenToWorldCoordinatesFloat(400, 300);
    eventBus.emit(new CameraTiltEvent(20));
    expect(handler.screenToWorldCoordinatesFloat(400, 300)).toEqual(before);
  });

  it("keeps the ground under the cursor while dragging and zooming", () => {
    const { handler, eventBus } = makeTiltedHandler(flat);
    eventBus.emit(new CameraTiltEvent(60 - handler.tilt()));

    const grabbed = handler.screenToWorldCoordinatesFloat(500, 380);
    eventBus.emit(new DragEvent(-30, 40));
    const dragged = handler.screenToWorldCoordinatesFloat(470, 420);
    expect(dragged.x).toBeCloseTo(grabbed.x);
    expect(dragged.y).toBeCloseTo(grabbed.y);

    const underCursor = handler.screenToWorldCoordinatesFloat(500, 420);
    eventBus.emit(new ZoomEvent(500, 420, -60));
    expect(handler.scale).not.toBe(2);
    const zoomed = handler.screenToWorldCoordinatesFloat(500, 420);
    expect(zoomed.x).toBeCloseTo(underCursor.x);
    expect(zoomed.y).toBeCloseTo(underCursor.y);
  });
});
