import { readFileSync } from "node:fs";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { UnitType } from "../packages/engine-api/src/game/GameTypes";
import type { Config } from "../packages/engine-lib/src/configuration/Config";
import { BarPass } from "../src/client/render/gl/passes/BarPass";
import { preloadAtlasData } from "../src/client/render/gl/passes/name-pass/AtlasData";
import { StructureLevelPass } from "../src/client/render/gl/passes/StructureLevelPass";
import { WorldTextPass } from "../src/client/render/gl/passes/WorldTextPass";
import { createRenderSettings } from "../src/client/render/gl/RenderSettings";
import {
  LabelLayer,
  labelLift,
  type LabelView,
  nameGround,
  type UnitAnchors,
} from "../src/client/render/three/LabelLayer";
import type { RendererConfig, UnitState } from "../src/client/render/types";

const MAP_W = 100;

/**
 * A WebGL2 stand-in that accepts every call and records instance uploads
 * (bufferSubData), so tests can read where labels were placed.
 */
function fakeGL(uploads: Float32Array[]): WebGL2RenderingContext {
  const target = {
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    isContextLost: () => false,
    getParameter: () => 4096,
    getExtension: () => null,
    bufferSubData: (
      _target: number,
      _offset: number,
      data: Float32Array,
      srcOffset = 0,
      length?: number,
    ) => {
      uploads.push(
        data.slice(
          srcOffset,
          length === undefined ? undefined : srcOffset + length,
        ),
      );
    },
  };
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in t) return t[prop as keyof typeof t];
      if (/^[A-Z0-9_]+$/.test(prop)) return 0;
      if (prop.startsWith("create") || prop === "getUniformLocation") {
        return () => ({});
      }
      return () => undefined;
    },
  }) as unknown as WebGL2RenderingContext;
}

/** Loads every image at once, so passes waiting on an atlas can draw. */
class InstantImage {
  crossOrigin = "";
  onload: (() => void) | null = null;
  set src(_url: string) {
    this.onload?.();
  }
}

const config = {
  unitInfo: () => ({ maxHealth: 1000, constructionDuration: 50 }),
  warshipVeterancyHealthBonus: () => 0,
  msPerTick: () => 100,
  allianceExtensionPromptOffset: () => 0,
  deletionMarkDuration: () => 50,
  SAMCooldown: () => 50,
  SiloCooldown: () => 50,
} as unknown as Config;

const header: RendererConfig = {
  mapWidth: MAP_W,
  mapHeight: MAP_W,
  unitTypes: Object.values(UnitType),
  players: [],
  maxPlayers: 4,
};

function unit(
  id: number,
  type: UnitType,
  x: number,
  y: number,
  extra: Partial<UnitState> = {},
): UnitState {
  return {
    id,
    unitType: type,
    ownerID: 1,
    pos: y * MAP_W + x,
    lastPos: y * MAP_W + x,
    isActive: true,
    level: 1,
    health: null,
    veterancy: 0,
    underConstruction: false,
    constructionStartTick: null,
    markedForDeletion: false,
    missileTimerQueue: [],
    trainType: null,
    loaded: null,
    ...extra,
  } as UnitState;
}

// The text passes need the font atlas's metrics.
beforeAll(async () => {
  const json = readFileSync("resources/atlases/msdf-atlas.json", "utf8");
  vi.stubGlobal("fetch", async () => new Response(json, { status: 200 }));
  await preloadAtlasData();
  vi.unstubAllGlobals();
});

/** The y of the bar drawn for each instance in the last upload. */
function barYs(uploads: Float32Array[]): number[] {
  const data = uploads[uploads.length - 1];
  const ys: number[] = [];
  for (let i = 1; i < data.length; i += 3) ys.push(data[i]);
  return ys;
}

const view = (v: Partial<LabelView> = {}): LabelView => ({
  camX: 50,
  camY: 50,
  zoom: 1,
  width: 800,
  height: 600,
  rowScale: 1,
  raise: 0.5,
  ...v,
});

describe("3D map label placement", () => {
  it("raises a label by the height it sits at", () => {
    expect(labelLift(view(), 30, 2)).toBeCloseTo(1);
    expect(labelLift(view({ raise: 0 }), 30, 2)).toBe(0);
    expect(labelLift(view(), 30, 0)).toBe(0);
  });

  it("follows a foreshortened map toward the middle of the view", () => {
    // Rows are drawn half as far from the centre row (50).
    const v = view({ rowScale: 0.5, raise: 0 });
    expect(30 - labelLift(v, 30, 0)).toBe(40);
    expect(70 - labelLift(v, 70, 0)).toBe(60);
    expect(labelLift(v, 50, 0)).toBe(0);
  });

  it("averages the ground under a name, so one hill doesn't throw it", () => {
    const entry = { playerID: "a", x: 40, y: 40, size: 20 };
    expect(nameGround(entry, () => 2)).toBe(2);
    const hill = (x: number, y: number) =>
      Math.hypot(x - 40, y - 40) < 2 ? 6 : 1;
    expect(nameGround(entry, hill)).toBeCloseTo((6 + 4) / 5);
  });
});

describe("label anchors on the 2D passes", () => {
  let uploads: Float32Array[];
  beforeEach(() => {
    uploads = [];
    vi.stubGlobal("Image", InstantImage);
  });
  afterEach(() => vi.unstubAllGlobals());

  const warship = () =>
    unit(1, UnitType.Warship, 10, 20, { health: 500 }) as UnitState;

  it("leaves bars on the unit's tile when there is no lift (2D map)", () => {
    const bars = new BarPass(
      fakeGL(uploads),
      header,
      createRenderSettings(),
      config,
    );
    const units = new Map([[1, warship()]]);
    bars.updateBars(units, new Map(), 0);
    bars.draw(new Float32Array(9));
    expect(barYs(uploads)).toEqual([20]);
  });

  it("raises bars by the lift", () => {
    const bars = new BarPass(
      fakeGL(uploads),
      header,
      createRenderSettings(),
      config,
    );
    bars.setAnchorLift(() => 3);
    bars.updateBars(new Map([[1, warship()]]), new Map(), 0);
    bars.draw(new Float32Array(9));
    expect(barYs(uploads)).toEqual([17]);
  });

  it("raises structure levels by the lift", () => {
    const levels = new StructureLevelPass(
      fakeGL(uploads),
      header,
      createRenderSettings(),
    );
    const city = unit(2, UnitType.City, 30, 40, { level: 3 });
    levels.updateStructures(new Map([[2, city]]));
    expect(uploads[uploads.length - 1][1]).toBe(40);
    levels.setAnchorLift(() => 2.5);
    levels.updateStructures(new Map([[2, city]]));
    expect(uploads[uploads.length - 1][1]).toBe(37.5);
  });

  it("raises world text by the lift at its tile", () => {
    const text = new WorldTextPass(
      fakeGL(uploads),
      createRenderSettings(),
      config,
    );
    const label = { x: 12, y: 30, text: "5K", colorR: 1, colorG: 1, colorB: 1 };
    text.setAttackTroopLabels([label]);
    text.tick(1);
    text.draw(new Float32Array(9), 1);
    expect(uploads[uploads.length - 1][1]).toBe(30);

    const lifts: [number, number][] = [];
    text.setAnchorLift((x, y) => {
      lifts.push([x, y]);
      return 4;
    });
    text.tick(1);
    text.draw(new Float32Array(9), 1);
    expect(uploads[uploads.length - 1][1]).toBe(26);
    expect(lifts[0]).toEqual([12.5, 30.5]);
  });
});

describe("3D map label layer", () => {
  let uploads: Float32Array[];
  beforeEach(() => {
    uploads = [];
    vi.stubGlobal("Image", InstantImage);
  });
  afterEach(() => vi.unstubAllGlobals());

  const anchors: UnitAnchors = {
    groundOf: (_u, heightAt) => heightAt(0, 0),
    topOf: (_u, heightAt) => heightAt(0, 0) + 2,
    loadedModels: 0,
  };
  const layer = (gl: WebGL2RenderingContext) =>
    new LabelLayer(
      gl,
      header,
      new Float32Array(4096),
      config,
      createRenderSettings(),
      () => 4,
      anchors,
    );
  const ship = () => unit(1, UnitType.Warship, 10, 20, { health: 500 });
  const lastBarY = (uploads: Float32Array[]) =>
    barYs(uploads.filter((u) => u.length === 3));

  it("moves bars when the camera tilt changes", () => {
    const gl = fakeGL(uploads);
    const labels = layer(gl);
    labels.updateUnits(new Map([[1, ship()]]), 0);
    // Ground at height 4, half a tile up the screen per unit of height.
    labels.draw(gl, view());
    expect(lastBarY(uploads)).toEqual([18]);
    labels.draw(gl, view({ raise: 1 }));
    expect(lastBarY(uploads)).toEqual([16]);
  });

  it("moves bars as a foreshortened map pans north and south", () => {
    const gl = fakeGL(uploads);
    const labels = layer(gl);
    labels.updateUnits(new Map([[1, ship()]]), 0);
    // The bar's row (tile centre 20.5) is drawn half as far from the view's
    // centre row; the shader adds the half tile back.
    labels.draw(gl, view({ rowScale: 0.5, raise: 0, camY: 40 }));
    expect(lastBarY(uploads)).toEqual([29.75]);
    labels.draw(gl, view({ rowScale: 0.5, raise: 0, camY: 20.5 }));
    expect(lastBarY(uploads)).toEqual([20]);
  });

  it("leaves bars alone while a flat map pans", () => {
    const gl = fakeGL(uploads);
    const labels = layer(gl);
    labels.updateUnits(new Map([[1, ship()]]), 0);
    labels.draw(gl, view());
    const uploadsBefore = uploads.length;
    labels.draw(gl, view({ camY: 10 }));
    // Same bar data, drawn again without being placed again.
    expect(lastBarY(uploads)).toEqual([18]);
    expect(uploads.length).toBe(uploadsBefore + 1);
  });
});
