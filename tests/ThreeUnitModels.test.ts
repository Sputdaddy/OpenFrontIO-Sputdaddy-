import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { UnitType } from "../packages/engine-api/src/game/GameTypes";
import {
  headingFor,
  mapScale,
  modelFor,
  modelSize,
  seaFacing,
  UNIT_MODELS,
} from "../src/client/render/three/UnitModels";
import { TrainType } from "../src/client/render/types";

describe("3D unit models", () => {
  it("has a model for every unit type", () => {
    for (const type of Object.values(UnitType)) {
      const model = modelFor({ unitType: type, trainType: null, loaded: null });
      expect(model, type).not.toBeNull();
      expect(UNIT_MODELS[model!], type).toBeDefined();
    }
  });

  it("ships every model with the buffers and textures it uses", () => {
    for (const spec of Object.values(UNIT_MODELS)) {
      const path = `resources/${spec.file}`;
      expect(existsSync(path), spec.file).toBe(true);
      const gltf = JSON.parse(readFileSync(path, "utf8")) as {
        buffers?: { uri: string }[];
        images?: { uri: string }[];
      };
      const uris = [...(gltf.buffers ?? []), ...(gltf.images ?? [])];
      expect(uris.length, spec.file).toBeGreaterThan(0);
      for (const { uri } of uris) {
        const file = join(dirname(path), decodeURIComponent(uri));
        expect(existsSync(file), `${spec.file}: ${uri}`).toBe(true);
      }
    }
  });

  it("draws train engines and cars, loaded or not", () => {
    const train = (trainType: TrainType, loaded: boolean | null) =>
      modelFor({ unitType: UnitType.Train, trainType, loaded });
    expect(train(TrainType.Engine, null)).toBe("train_engine");
    expect(train(TrainType.TailEngine, null)).toBe("train_engine");
    expect(train(TrainType.Carriage, false)).toBe("train_car");
    expect(train(TrainType.Carriage, true)).toBe("train_car_loaded");
  });
});

describe("3D port placement", () => {
  it("turns a port's quay toward the sea", () => {
    const facing = seaFacing((x) => x > 50, 48, 20, 9);
    expect(facing).toBeCloseTo(headingFor(1, 0));
  });

  it("finds the sea diagonally too", () => {
    const facing = seaFacing((x, y) => x > 50 && y > 50, 48, 48, 9);
    expect(facing).toBeCloseTo(headingFor(1, 1));
  });

  it("faces the open sea, not a narrow channel", () => {
    // A channel a few tiles wide to the west, open sea to the south.
    const water = (x: number, y: number) => (x > 40 && x < 44) || y > 52;
    const facing = seaFacing(water, 48, 48, 9)!;
    expect(Math.abs(facing - headingFor(0, 1))).toBeLessThan(Math.PI / 4);
  });

  it("leaves a port with no sea nearby to its default turn", () => {
    expect(seaFacing(() => false, 48, 20, 9)).toBeNull();
  });
});

describe("3D model sizes", () => {
  // Config.structureMinDist: the closest two structures can be.
  const SPACING = 15;

  it("scales models with the map's size", () => {
    const world = mapScale(2000, 1000);
    expect(mapScale(2400, 1200) / world).toBeCloseTo(1.2);
    expect(modelSize("warship", 1, world, SPACING)).toBeCloseTo(
      UNIT_MODELS.warship.size * world,
    );
  });

  it("draws models bigger on bigger maps and smaller on smaller ones", () => {
    const small = mapScale(1000, 1000);
    const big = mapScale(2500, 2500);
    expect(small).toBeLessThan(mapScale(2000, 1000));
    expect(big).toBeGreaterThan(mapScale(2000, 1000));
    expect(modelSize("warship", 1, small, SPACING)).toBeLessThan(
      modelSize("warship", 1, big, SPACING),
    );
  });

  it("stops scaling at the smallest and largest maps", () => {
    expect(mapScale(512, 512)).toBe(mapScale(256, 256));
    expect(mapScale(4744, 2628)).toBe(mapScale(8000, 8000));
  });

  it("never grows a structure into its neighbour", () => {
    const scale = mapScale(8000, 8000);
    for (const [key, spec] of Object.entries(UNIT_MODELS)) {
      if (spec.kind !== "structure") continue;
      // A square this wide, turned any way, fits in a circle SPACING across.
      const size = modelSize(key, 1, scale, SPACING);
      expect(size * Math.SQRT2, key).toBeLessThanOrEqual(SPACING + 1e-9);
    }
  });

  it("grows a city a bit with each level stacked on it", () => {
    const scale = mapScale(2000, 1000);
    const city = (level: number) => modelSize("city", level, scale, SPACING);
    for (let level = 2; level <= 20; level++) {
      expect(city(level), `level ${level}`).toBeGreaterThan(city(level - 1));
    }
    // Noticeably at first, then a little less each time.
    expect(city(2) / city(1)).toBeGreaterThan(1.1);
    expect(city(10) - city(9)).toBeLessThan(city(2) - city(1));
  });

  it("never grows a city into a neighbour beside it", () => {
    for (const scale of [mapScale(2000, 1000), mapScale(8000, 8000)]) {
      expect(modelSize("city", 100, scale, SPACING)).toBeLessThan(SPACING);
    }
  });

  it("grows only cities with their level", () => {
    const scale = mapScale(2000, 1000);
    expect(modelSize("port", 5, scale, SPACING)).toBe(
      modelSize("port", 1, scale, SPACING),
    );
  });

  it("keeps trains the size of the rails on every map", () => {
    for (const scale of [mapScale(512, 512), mapScale(8000, 8000)]) {
      expect(modelSize("train_car", 1, scale, SPACING)).toBe(
        UNIT_MODELS.train_car.size,
      );
    }
  });
});
