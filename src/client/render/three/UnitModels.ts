/**
 * 3D models for units and structures on the Three.js map.
 *
 * Loads the .glb files built by scripts/models/build_models.py and draws
 * every unit of a modelled type as one instance per model part. Parts whose
 * material name starts with "Team" are multiplied by the owner's colour.
 * Ships glide between their last and current tile over each tick and turn
 * to face where they're heading.
 */

import { assetUrl } from "@openfront/shared/AssetUrls";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { UnitState } from "../types";
import { UT_CITY, UT_MISSILE_SILO, UT_WARSHIP } from "../types";

interface ModelSpec {
  file: string;
  /** Structure footprint, or ship length, in tiles. */
  size: number;
  /** Ships float at sea level and turn to face their heading. */
  ship: boolean;
}

/** Unit types drawn as 3D models. Other types aren't drawn on this map yet. */
export const UNIT_MODELS: Readonly<Record<string, ModelSpec>> = {
  [UT_CITY]: { file: "models/city.glb", size: 9, ship: false },
  [UT_MISSILE_SILO]: { file: "models/missile_silo.glb", size: 9, ship: false },
  [UT_WARSHIP]: { file: "models/warship.glb", size: 11, ship: true },
};

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
/**
 * Where higher ground hides part of a model, that part is drawn as a flat
 * see-through silhouette in the owner's colour, so hills never hide a
 * player's units. Ghosts draw after the terrain and before the models, and
 * only where they're behind what's already drawn.
 */
const GHOST_OPACITY = 0.45;
const GHOST_ORDER = 1;
const MODEL_ORDER = 2;

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

interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  team: boolean;
  /** Drawn as a silhouette when hidden. The buried foundation isn't. */
  ghost: boolean;
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
      mesh.castShadow = true;
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
      if (ghost) ghost.count = count;
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
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  heading: number;
  targetHeading: number;
}

export class UnitModels {
  private readonly group = new THREE.Group();
  private readonly models = new Map<string, ModelInstances>();
  private readonly tracked = new Map<string, Map<number, Tracked>>();
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
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    private readonly mapW: number,
    private readonly msPerTick: number,
    private readonly ownerColor: (ownerID: number, out: THREE.Color) => void,
  ) {
    scene.add(this.group);
    for (const type of Object.keys(UNIT_MODELS)) {
      this.tracked.set(type, new Map());
    }
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
      Object.entries(UNIT_MODELS).map(async ([type, spec]) => {
        try {
          const gltf = await loader.loadAsync(assetUrl(spec.file));
          if (this.disposed) return;
          this.models.set(
            type,
            new ModelInstances(
              this.partsOf(gltf.scene, spec.ship),
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

  private partsOf(root: THREE.Object3D, ship: boolean): Part[] {
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
      });
    });
    if (!ship) parts.push(this.foundation(parts));
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
    return { geometry, material, team: false, ghost: false };
  }

  /** Take this tick's units. */
  update(units: ReadonlyMap<number, UnitState>): void {
    this.lastUpdateMs = performance.now();
    const seen = new Set<number>();
    for (const unit of units.values()) {
      const byId = this.tracked.get(unit.unitType);
      if (byId === undefined || !unit.isActive) continue;
      seen.add(unit.id);
      const toX = unit.pos % this.mapW;
      const toY = (unit.pos - toX) / this.mapW;
      const fromX = unit.lastPos % this.mapW;
      const fromY = (unit.lastPos - fromX) / this.mapW;
      const moved = toX !== fromX || toY !== fromY;
      const prev = byId.get(unit.id);
      const target = moved
        ? headingFor(toX - fromX, toY - fromY)
        : (prev?.targetHeading ?? 0);
      byId.set(unit.id, {
        unit,
        fromX,
        fromY,
        toX,
        toY,
        heading: prev?.heading ?? target,
        targetHeading: target,
      });
    }
    for (const byId of this.tracked.values()) {
      for (const id of byId.keys()) {
        if (!seen.has(id)) byId.delete(id);
      }
    }
  }

  /** Position every instance for this frame. */
  draw(heightAt: (x: number, y: number) => number): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastDrawMs) / 1000, 0.1);
    this.lastDrawMs = now;
    const t = Math.min(1, (now - this.lastUpdateMs) / this.msPerTick);
    const turn = Math.min(1, dt * TURN_RATE);

    for (const [type, model] of this.models) {
      const spec = UNIT_MODELS[type];
      const byId = this.tracked.get(type)!;
      model.reserve(byId.size);
      let i = 0;
      for (const s of byId.values()) {
        const x = s.fromX + (s.toX - s.fromX) * t + 0.5;
        const y = s.fromY + (s.toY - s.fromY) * t + 0.5;
        let size = spec.size;
        let angle: number;
        let ground: number;
        if (spec.ship) {
          s.heading += turnBetween(s.heading, s.targetHeading) * turn;
          angle = s.heading;
          ground = 0;
        } else {
          // A fixed quarter turn per structure, so neighbours don't all
          // look identical.
          angle = (s.unit.id % 4) * (Math.PI / 2);
          if (type === UT_CITY) {
            size *= Math.min(
              MAX_LEVEL_SCALE,
              1 + (s.unit.level - 1) * LEVEL_SCALE_STEP,
            );
          }
          ground = footprintTop(heightAt, x, y, size);
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
