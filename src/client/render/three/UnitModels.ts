/**
 * 3D models for units and structures on the Three.js map.
 *
 * Loads the .glb files built by scripts/models/build_models.py and draws
 * every unit as one instance per model part. Parts whose material name
 * starts with "Team" are multiplied by the owner's colour. Moving units
 * glide between their last and current tile over each tick and turn to face
 * where they're heading; ports turn to face the sea. Models are drawn bigger
 * on bigger maps and smaller on smaller ones (mapScale).
 */

import { assetUrl } from "@openfront/shared/AssetUrls";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { UnitState } from "../types";
import {
  TrainType,
  UT_ATOM_BOMB,
  UT_CITY,
  UT_DEFENSE_POST,
  UT_FACTORY,
  UT_HYDROGEN_BOMB,
  UT_MIRV,
  UT_MIRV_WARHEAD,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
  UT_SAM_MISSILE,
  UT_SHELL,
  UT_TRADE_SHIP,
  UT_TRAIN,
  UT_TRANSPORT,
  UT_WARSHIP,
} from "../types";

/**
 * How a model stands on the map: structures on the highest ground under
 * them, ships at sea level, trains on the ground under them, and missiles
 * and shells in the air.
 */
type ModelKind = "structure" | "ship" | "train" | "air";

interface ModelSpec {
  file: string;
  /** Structure footprint, or length of anything that moves, in tiles. */
  size: number;
  kind: ModelKind;
  /** Height above sea level of things in the air. */
  altitude?: number;
}

/**
 * Every model, by key. Sizes match MAP_SIZES in build_models.py; each map
 * scales them (mapScale, modelSize).
 */
export const UNIT_MODELS: Readonly<Record<string, ModelSpec>> = {
  city: { file: "models/city.glb", size: 9, kind: "structure" },
  missile_silo: { file: "models/missile_silo.glb", size: 9, kind: "structure" },
  port: { file: "models/port.glb", size: 9, kind: "structure" },
  factory: { file: "models/factory.glb", size: 9, kind: "structure" },
  defense_post: { file: "models/defense_post.glb", size: 7, kind: "structure" },
  sam_launcher: { file: "models/sam_launcher.glb", size: 9, kind: "structure" },
  warship: { file: "models/warship.glb", size: 11, kind: "ship" },
  transport: { file: "models/transport.glb", size: 6, kind: "ship" },
  trade_ship: { file: "models/trade_ship.glb", size: 10, kind: "ship" },
  train_engine: { file: "models/train_engine.glb", size: 2, kind: "train" },
  train_car: { file: "models/train_car.glb", size: 2, kind: "train" },
  train_car_loaded: {
    file: "models/train_car_loaded.glb",
    size: 2,
    kind: "train",
  },
  atom_bomb: {
    file: "models/atom_bomb.glb",
    size: 6,
    kind: "air",
    altitude: 16,
  },
  hydrogen_bomb: {
    file: "models/hydrogen_bomb.glb",
    size: 8,
    kind: "air",
    altitude: 18,
  },
  mirv: { file: "models/mirv.glb", size: 11, kind: "air", altitude: 20 },
  mirv_warhead: {
    file: "models/mirv_warhead.glb",
    size: 2.5,
    kind: "air",
    altitude: 14,
  },
  sam_missile: {
    file: "models/sam_missile.glb",
    size: 3,
    kind: "air",
    altitude: 12,
  },
  shell: { file: "models/shell.glb", size: 1.2, kind: "air", altitude: 1.5 },
};

const MODEL_BY_TYPE: Readonly<Record<string, string>> = {
  [UT_CITY]: "city",
  [UT_MISSILE_SILO]: "missile_silo",
  [UT_PORT]: "port",
  [UT_FACTORY]: "factory",
  [UT_DEFENSE_POST]: "defense_post",
  [UT_SAM_LAUNCHER]: "sam_launcher",
  [UT_WARSHIP]: "warship",
  [UT_TRANSPORT]: "transport",
  [UT_TRADE_SHIP]: "trade_ship",
  [UT_ATOM_BOMB]: "atom_bomb",
  [UT_HYDROGEN_BOMB]: "hydrogen_bomb",
  [UT_MIRV]: "mirv",
  [UT_MIRV_WARHEAD]: "mirv_warhead",
  [UT_SAM_MISSILE]: "sam_missile",
  [UT_SHELL]: "shell",
};

/** The model that draws a unit, or null if it has none. */
export function modelFor(
  unit: Pick<UnitState, "unitType" | "trainType" | "loaded">,
): string | null {
  if (unit.unitType === UT_TRAIN) {
    if (unit.trainType !== TrainType.Carriage) return "train_engine";
    return unit.loaded ? "train_car_loaded" : "train_car";
  }
  return MODEL_BY_TYPE[unit.unitType] ?? null;
}

/**
 * Models are drawn this fraction of their size in UNIT_MODELS on the World
 * map (2000x1000). Other maps scale that by their size relative to World,
 * so models take up about as much of the screen when the whole map is in
 * view, within these bounds.
 */
const MODEL_SCALE = 0.7;
const REFERENCE_MAP_SIZE = Math.sqrt(2000 * 1000);
const MIN_MAP_SCALE = 0.6;
const MAX_MAP_SCALE = 1.6;
/** Cities grow a little with each level, up to this factor. */
const MAX_LEVEL_SCALE = 1.4;
const LEVEL_SCALE_STEP = 0.08;
/** Structures being built are drawn this fraction of their full height. */
const CONSTRUCTION_HEIGHT = 0.35;
/** How fast ships turn toward their heading, per second. */
const TURN_RATE = 6;
const INITIAL_CAPACITY = 64;
/** Structure foundations, in model units (the footprint is 1 wide). */
const BASE_HEIGHT = 0.01;
const FOUNDATION_INSET = 0.995;
const FOUNDATION_DEPTH = 3;
const FOUNDATION_COLOR = 0x6b675f;
/** Footprint corners sampled for ground height, as a fraction of size. */
const FOOTPRINT_REACH = 0.45;
/** Trains crossing water run on a bridge this high. */
const BRIDGE_DECK = 0.5;
/** Ports look for the sea this many ways round, this far out (in sizes). */
const SEA_DIRECTIONS = 16;
const SEA_REACH = [0.6, 1, 1.5];
/**
 * Where higher ground hides part of a model, that part is drawn as a flat
 * see-through silhouette in the owner's colour, so hills never hide a
 * player's units. Ghosts draw after the terrain and before the models, and
 * only where they're behind what's already drawn.
 */
const GHOST_OPACITY = 0.45;
const BLACK = new THREE.Color(0, 0, 0);
const GHOST_ORDER = 1;
const MODEL_ORDER = 2;

/** How big models are on this map, relative to their UNIT_MODELS size. */
export function mapScale(width: number, height: number): number {
  const scale = Math.sqrt(width * height) / REFERENCE_MAP_SIZE;
  return MODEL_SCALE * Math.min(MAX_MAP_SCALE, Math.max(MIN_MAP_SCALE, scale));
}

/**
 * A model's size in tiles on a map with this scale. Structures can stand
 * structureSpacing tiles apart in any direction, so they scale up only as
 * far as two neighbours turned any way still can't overlap; cities then
 * grow with their level. Trains keep their size, to fit the rails and the
 * gap between cars.
 */
export function modelSize(
  key: string,
  level: number,
  scale: number,
  structureSpacing: number,
): number {
  const spec = UNIT_MODELS[key];
  if (spec.kind === "train") return spec.size;
  let size = spec.size * scale;
  if (spec.kind === "structure") {
    size = Math.min(size, structureSpacing / Math.SQRT2);
  }
  if (key === "city") {
    size *= Math.min(MAX_LEVEL_SCALE, 1 + (level - 1) * LEVEL_SCALE_STEP);
  }
  return size;
}

/** Heading (radians about +Y) that points a model's bow along (dx, dy). */
export function headingFor(dx: number, dy: number): number {
  return Math.atan2(dx, dy);
}

/** Shortest signed turn from angle a to angle b, in (-PI, PI]. */
export function turnBetween(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * The highest ground under a structure's footprint. Structures stand on it,
 * their foundation filling the gap on lower sides, so no part of one is
 * buried in a slope (which would show as a silhouette).
 */
export function footprintTop(
  heightAt: (x: number, y: number) => number,
  x: number,
  y: number,
  size: number,
): number {
  const r = size * FOOTPRINT_REACH;
  let top = -Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      top = Math.max(top, heightAt(x + dx * r, y + dy * r));
    }
  }
  return top;
}

/**
 * A fixed quarter turn per structure, so neighbours don't all look
 * identical.
 */
function quarterTurn(id: number): number {
  return (id % 4) * (Math.PI / 2);
}

/**
 * The heading that turns a port's quay toward the sea: the average of the
 * directions, of SEA_DIRECTIONS round it, that reach water a little way
 * out, counting each water sample. Null if there's no water there.
 */
export function seaFacing(
  isWater: (x: number, y: number) => boolean,
  x: number,
  y: number,
  size: number,
): number | null {
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < SEA_DIRECTIONS; k++) {
    const a = (k / SEA_DIRECTIONS) * Math.PI * 2;
    const dx = Math.sin(a);
    const dy = Math.cos(a);
    for (const reach of SEA_REACH) {
      if (isWater(x + dx * size * reach, y + dy * size * reach)) {
        sx += dx;
        sy += dy;
      }
    }
  }
  if (Math.hypot(sx, sy) < 1e-6) return null;
  return headingFor(sx, sy);
}

interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  team: boolean;
  /** Drawn as a silhouette when hidden. The buried foundation isn't. */
  ghost: boolean;
  /** Glowing parts (exhaust flames, tracers) cast no shadow. */
  castShadow: boolean;
}

/** One model drawn many times: an InstancedMesh per part. */
class ModelInstances {
  private meshes: {
    mesh: THREE.InstancedMesh;
    ghost: THREE.InstancedMesh | null;
  }[] = [];
  private colors = new THREE.InstancedBufferAttribute(new Float32Array(0), 3);
  private capacity = 0;

  constructor(
    private readonly parts: Part[],
    private readonly ghostMaterial: THREE.Material,
    private readonly parent: THREE.Object3D,
  ) {
    this.grow(INITIAL_CAPACITY);
  }

  private grow(capacity: number): void {
    this.removeMeshes();
    // Owner colours, shared by the team parts and every ghost.
    this.colors = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3),
      3,
    );
    this.meshes = this.parts.map((part) => {
      const mesh = new THREE.InstancedMesh(
        part.geometry,
        part.material,
        capacity,
      );
      mesh.castShadow = part.castShadow;
      mesh.receiveShadow = true;
      mesh.renderOrder = MODEL_ORDER;
      if (part.team) mesh.instanceColor = this.colors;
      let ghost: THREE.InstancedMesh | null = null;
      if (part.ghost) {
        ghost = new THREE.InstancedMesh(
          part.geometry,
          this.ghostMaterial,
          capacity,
        );
        ghost.instanceMatrix = mesh.instanceMatrix;
        ghost.instanceColor = this.colors;
        ghost.renderOrder = GHOST_ORDER;
      }
      for (const m of ghost ? [mesh, ghost] : [mesh]) {
        // Instances are spread over the map; the geometry's own bounds say
        // nothing about where they are.
        m.frustumCulled = false;
        m.count = 0;
        this.parent.add(m);
      }
      return { mesh, ghost };
    });
    this.capacity = capacity;
  }

  private removeMeshes(): void {
    for (const { mesh, ghost } of this.meshes) {
      this.parent.remove(mesh);
      mesh.dispose();
      if (ghost) {
        this.parent.remove(ghost);
        ghost.dispose();
      }
    }
    this.meshes = [];
  }

  reserve(count: number): void {
    if (count <= this.capacity) return;
    let capacity = this.capacity;
    while (capacity < count) capacity *= 2;
    this.grow(capacity);
  }

  set(i: number, matrix: THREE.Matrix4, color: THREE.Color): void {
    for (const { mesh } of this.meshes) mesh.setMatrixAt(i, matrix);
    color.toArray(this.colors.array, i * 3);
  }

  commit(count: number): void {
    for (const { mesh, ghost } of this.meshes) {
      mesh.count = count;
      mesh.visible = count > 0;
      if (ghost) {
        ghost.count = count;
        ghost.visible = count > 0;
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.colors.needsUpdate = true;
  }

  dispose(): void {
    this.removeMeshes();
    for (const part of this.parts) {
      part.geometry.dispose();
      part.material.dispose();
    }
  }
}

interface Tracked {
  unit: UnitState;
  model: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  heading: number;
  targetHeading: number;
  /** A port's turn toward the sea, worked out once it's first drawn. */
  facing: number | null;
}

export class UnitModels {
  private readonly group = new THREE.Group();
  private readonly models = new Map<string, ModelInstances>();
  private readonly tracked = new Map<number, Tracked>();
  /** This tick's units, by model. */
  private byModel = new Map<string, Tracked[]>();
  private readonly envMap: THREE.Texture;
  private readonly ghostMaterial = new THREE.MeshBasicMaterial({
    opacity: GHOST_OPACITY,
    depthFunc: THREE.GreaterDepth,
    depthWrite: false,
    // Custom blending keeps the ghosts in the opaque pass (so they draw
    // before the models) while still blending.
    blending: THREE.CustomBlending,
  });
  private lastUpdateMs = performance.now();
  private lastDrawMs = performance.now();
  private disposed = false;

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly mapScale: number;
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    private readonly mapW: number,
    mapH: number,
    private readonly structureSpacing: number,
    private readonly msPerTick: number,
    private readonly ownerColor: (ownerID: number, out: THREE.Color) => void,
    private readonly isWater: (x: number, y: number) => boolean,
  ) {
    this.mapScale = mapScale(mapW, mapH);
    scene.add(this.group);
    // A soft studio environment so the models' metal and glass have
    // something to reflect. Only the models use it, not the terrain.
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    void this.load();
  }

  private async load(): Promise<void> {
    const loader = new GLTFLoader();
    await Promise.all(
      Object.entries(UNIT_MODELS).map(async ([key, spec]) => {
        try {
          const gltf = await loader.loadAsync(assetUrl(spec.file));
          if (this.disposed) return;
          this.models.set(
            key,
            new ModelInstances(
              this.partsOf(gltf.scene, spec.kind === "structure"),
              this.ghostMaterial,
              this.group,
            ),
          );
        } catch (err) {
          console.warn(`3D map: could not load ${spec.file}`, err);
        }
      }),
    );
  }

  private partsOf(root: THREE.Object3D, structure: boolean): Part[] {
    root.updateMatrixWorld(true);
    const parts: Part[] = [];
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const material = obj.material as THREE.MeshStandardMaterial;
      material.envMap = this.envMap;
      material.envMapIntensity = 0.6;
      parts.push({
        geometry: obj.geometry.clone().applyMatrix4(obj.matrixWorld),
        material,
        team: material.name.startsWith("Team"),
        ghost: true,
        castShadow: material.emissive.equals(BLACK),
      });
    });
    if (structure) parts.push(this.foundation(parts));
    return parts;
  }

  /**
   * A concrete foundation under a structure's base, reaching down into the
   * ground, so a structure on a slope stands on solid ground instead of
   * hanging over it.
   */
  private foundation(parts: Part[]): Part {
    // The base is whatever touches the ground.
    const base = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const { geometry } of parts) {
      const pos = geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        if (v.y < BASE_HEIGHT) base.expandByPoint(v);
      }
    }
    const w = (base.max.x - base.min.x) * FOUNDATION_INSET;
    const d = (base.max.z - base.min.z) * FOUNDATION_INSET;
    const geometry = new THREE.BoxGeometry(w, FOUNDATION_DEPTH, d).translate(
      (base.min.x + base.max.x) / 2,
      -FOUNDATION_DEPTH / 2 - 0.002,
      (base.min.z + base.max.z) / 2,
    );
    const material = new THREE.MeshStandardMaterial({
      color: FOUNDATION_COLOR,
      roughness: 0.9,
      envMap: this.envMap,
      envMapIntensity: 0.6,
    });
    return {
      geometry,
      material,
      team: false,
      ghost: false,
      castShadow: true,
    };
  }

  /** Take this tick's units. */
  update(units: ReadonlyMap<number, UnitState>): void {
    this.lastUpdateMs = performance.now();
    const seen = new Set<number>();
    this.byModel = new Map();
    for (const unit of units.values()) {
      const model = modelFor(unit);
      if (model === null || !unit.isActive) continue;
      seen.add(unit.id);
      const toX = unit.pos % this.mapW;
      const toY = (unit.pos - toX) / this.mapW;
      const fromX = unit.lastPos % this.mapW;
      const fromY = (unit.lastPos - fromX) / this.mapW;
      const moved = toX !== fromX || toY !== fromY;
      const prev = this.tracked.get(unit.id);
      let target = prev?.targetHeading ?? 0;
      if (moved) {
        target = headingFor(toX - fromX, toY - fromY);
        // The tail engine runs backwards.
        if (unit.trainType === TrainType.TailEngine) target += Math.PI;
      }
      const s: Tracked = {
        unit,
        model,
        fromX,
        fromY,
        toX,
        toY,
        heading: prev?.heading ?? target,
        targetHeading: target,
        facing: prev?.facing ?? null,
      };
      this.tracked.set(unit.id, s);
      let list = this.byModel.get(model);
      if (list === undefined) this.byModel.set(model, (list = []));
      list.push(s);
    }
    for (const id of this.tracked.keys()) {
      if (!seen.has(id)) this.tracked.delete(id);
    }
  }

  /** Position every instance for this frame. */
  draw(heightAt: (x: number, y: number) => number): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastDrawMs) / 1000, 0.1);
    this.lastDrawMs = now;
    const t = Math.min(1, (now - this.lastUpdateMs) / this.msPerTick);
    const turn = Math.min(1, dt * TURN_RATE);

    for (const [key, model] of this.models) {
      const spec = UNIT_MODELS[key];
      const list = this.byModel.get(key) ?? [];
      model.reserve(list.length);
      let i = 0;
      for (const s of list) {
        const x = s.fromX + (s.toX - s.fromX) * t + 0.5;
        const y = s.fromY + (s.toY - s.fromY) * t + 0.5;
        const size = modelSize(
          key,
          s.unit.level,
          this.mapScale,
          this.structureSpacing,
        );
        let angle: number;
        let ground: number;
        if (spec.kind === "structure") {
          if (key === "port") {
            s.facing ??=
              seaFacing(this.isWater, x, y, size) ?? quarterTurn(s.unit.id);
            angle = s.facing;
          } else {
            angle = quarterTurn(s.unit.id);
          }
          ground = footprintTop(heightAt, x, y, size);
        } else {
          s.heading += turnBetween(s.heading, s.targetHeading) * turn;
          angle = s.heading;
          if (spec.kind === "ship") ground = 0;
          else if (spec.kind === "train")
            ground = Math.max(heightAt(x, y), BRIDGE_DECK);
          else ground = (spec.altitude ?? 0) * this.mapScale;
        }
        this.position.set(x, ground, y);
        this.rotation.setFromAxisAngle(UnitModels.UP, angle);
        const height = s.unit.underConstruction ? CONSTRUCTION_HEIGHT : 1;
        this.scale.set(size, size * height, size);
        this.matrix.compose(this.position, this.rotation, this.scale);
        this.ownerColor(s.unit.ownerID, this.color);
        model.set(i++, this.matrix, this.color);
      }
      model.commit(i);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const model of this.models.values()) model.dispose();
    this.models.clear();
    this.ghostMaterial.dispose();
    this.envMap.dispose();
    this.group.removeFromParent();
  }
}
