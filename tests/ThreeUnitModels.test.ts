import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UnitType } from "../packages/engine-api/src/game/GameTypes";
import {
  headingFor,
  modelFor,
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

  it("ships a .glb for every model", () => {
    for (const spec of Object.values(UNIT_MODELS)) {
      expect(existsSync(`resources/${spec.file}`), spec.file).toBe(true);
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
