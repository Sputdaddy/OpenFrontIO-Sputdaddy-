/**
 * Names and labels on the 3D map: player names with their troop counts,
 * flags, emojis and status icons; attack troop counts, gold popups and the
 * build cost under the cursor; structure levels; and health, progress and
 * veterancy bars.
 *
 * They are the 2D map's own passes (NamePass, WorldTextPass,
 * StructureLevelPass, BarPass), drawn on the three.js renderer's WebGL2
 * context after the 3D scene, on top of it. They draw with the flat 2D
 * camera, so labels face the screen and keep their 2D size at every zoom.
 * What changes is where each one is anchored: at the spot on the screen
 * where the tilted camera draws the ground (or the top of the model) it
 * belongs to. The passes keep their anchors from tick to tick, so they're
 * placed again whenever the camera moves in a way that shifts them.
 */

import type { Config } from "@openfront/engine-lib/configuration/Config";
import { BarPass } from "../gl/passes/BarPass";
import { NamePass } from "../gl/passes/name-pass";
import { StructureLevelPass } from "../gl/passes/StructureLevelPass";
import {
  type AttackTroopLabel,
  WorldTextPass,
} from "../gl/passes/WorldTextPass";
import type { RenderSettings } from "../gl/RenderSettings";
import type {
  BonusEvent,
  ConquestFx,
  GhostPreviewData,
  NameEntry,
  PlayerState,
  PlayerStatic,
  PlayerStatusData,
  RendererConfig,
  UnitState,
} from "../types";

type HeightAt = (x: number, y: number) => number;

/** Where the labels over a unit go, in world units above sea level. */
export interface UnitAnchors {
  /** The ground its model stands on: bars go here. */
  groundOf(unit: UnitState, heightAt: HeightAt): number;
  /** The top of its model: a structure's level goes here. */
  topOf(unit: UnitState, heightAt: HeightAt): number;
  /** Changes when the heights above can change (as models load). */
  readonly loadedModels: number;
}

/**
 * How the 3D camera draws the map this frame. Across the screen it matches
 * the flat 2D camera centred on (camX, camY) at `zoom` pixels per tile. Down
 * the screen, map point (x, y) at height h is drawn where the flat camera
 * draws row `camY + (y - camY) * rowScale - h * raise`.
 */
export interface LabelView {
  camX: number;
  camY: number;
  zoom: number;
  /** Canvas size in pixels. */
  width: number;
  height: number;
  rowScale: number;
  raise: number;
}

/**
 * A name stands over the average height of the ground it covers, sampled
 * this far out from its centre (in name sizes), so a single hill under it
 * doesn't throw it off.
 */
const NAME_SAMPLE_REACH = 0.5;

/** Height of the ground under a name, in world units. */
export function nameGround(entry: NameEntry, heightAt: HeightAt): number {
  const r = entry.size * NAME_SAMPLE_REACH;
  const { x, y } = entry;
  return (
    (heightAt(x, y) +
      heightAt(x - r, y) +
      heightAt(x + r, y) +
      heightAt(x, y - r) +
      heightAt(x, y + r)) /
    5
  );
}

/**
 * Rows up the screen a label anchored at row y, at height h, has to move to
 * sit where the camera draws that spot.
 */
export function labelLift(v: LabelView, y: number, h: number): number {
  return y - (v.camY + (y - v.camY) * v.rowScale - h * v.raise);
}

export class LabelLayer {
  private readonly names: NamePass;
  private readonly worldText: WorldTextPass;
  private readonly levels: StructureLevelPass;
  private readonly bars: BarPass;
  private readonly mapW: number;
  /** World → clip for the flat 2D camera (column-major mat3). */
  private readonly camera = new Float32Array(9);
  /** The view this frame; labels are placed for it. */
  private view: LabelView = {
    camX: 0,
    camY: 0,
    zoom: 1,
    width: 1,
    height: 1,
    rowScale: 1,
    raise: 0,
  };

  // Last data pushed in, kept so labels can be placed again.
  private lastNames: ReadonlyMap<string, NameEntry> = new Map();
  private lastPlayers: Map<number, PlayerState> = new Map();
  private lastStatus: Map<number, PlayerStatusData> | undefined;
  /** The names as drawn: lifted copies of lastNames' entries. */
  private readonly liftedNames = new Map<string, NameEntry>();
  private lastUnits: Map<number, UnitState> = new Map();
  private lastStructures: Map<number, UnitState> = new Map();
  private lastTick = 0;
  /** The view and models the per-tick labels were last placed for. */
  private placed: LabelView = { ...this.view };
  private placedModels: number;

  private localPlayerID = 0;
  private altView = false;

  constructor(
    gl: WebGL2RenderingContext,
    header: RendererConfig,
    paletteData: Float32Array,
    config: Config,
    private readonly settings: RenderSettings,
    private readonly heightAt: HeightAt,
    private readonly anchors: UnitAnchors,
  ) {
    this.mapW = header.mapWidth;
    this.names = new NamePass(gl, header, paletteData, settings, config);
    this.worldText = new WorldTextPass(gl, settings, config);
    this.worldText.setMapWidth(header.mapWidth);
    this.levels = new StructureLevelPass(gl, header, settings);
    this.bars = new BarPass(gl, header, settings, config);
    this.placedModels = anchors.loadedModels;

    this.worldText.setAnchorLift((x, y) =>
      labelLift(this.view, y, heightAt(x, y)),
    );
    this.bars.setAnchorLift((unit) =>
      labelLift(this.view, this.rowOf(unit), anchors.groundOf(unit, heightAt)),
    );
    this.levels.setAnchorLift((unit) =>
      labelLift(this.view, this.rowOf(unit), anchors.topOf(unit, heightAt)),
    );
  }

  /** The row through the middle of a unit's tile. */
  private rowOf(unit: UnitState): number {
    return Math.floor(unit.pos / this.mapW) + 0.5;
  }

  // ---- Players ----

  addPlayers(players: PlayerStatic[], paletteData: Float32Array): void {
    this.names.addPlayers(players, paletteData);
  }

  refreshPlayerColors(paletteData: Float32Array): void {
    this.names.refreshPlayerColors(paletteData);
  }

  updatePlayerCosmetics(players: PlayerStatic[]): void {
    this.names.updatePlayerCosmetics(players);
  }

  refreshNames(displayNames: Map<string, string>): void {
    this.names.refreshNames(displayNames);
  }

  updateNames(
    names: ReadonlyMap<string, NameEntry>,
    players: Map<number, PlayerState>,
    snap: boolean,
    statusData?: Map<number, PlayerStatusData>,
  ): void {
    this.lastNames = names;
    this.lastPlayers = players;
    this.lastStatus = statusData;
    this.names.updateNames(this.liftNames(), players, snap, statusData);
  }

  /** Copies of the last names, each moved to where its ground is drawn. */
  private liftNames(): Map<string, NameEntry> {
    const lifted = this.liftedNames;
    for (const [id, entry] of this.lastNames) {
      let l = lifted.get(id);
      if (l === undefined) {
        l = { playerID: id, x: 0, y: 0, size: 0 };
        lifted.set(id, l);
      }
      l.x = entry.x;
      l.size = entry.size;
      l.y =
        entry.y -
        labelLift(this.view, entry.y, nameGround(entry, this.heightAt));
    }
    if (lifted.size !== this.lastNames.size) {
      for (const id of lifted.keys()) {
        if (!this.lastNames.has(id)) lifted.delete(id);
      }
    }
    return lifted;
  }

  // ---- Units ----

  updateUnits(units: Map<number, UnitState>, gameTick: number): void {
    this.lastUnits = units;
    this.lastTick = gameTick;
    this.bars.updateBars(units, this.lastStructures, gameTick);
  }

  updateStructures(units: Map<number, UnitState>): void {
    this.lastStructures = units;
    this.levels.updateStructures(units);
  }

  // ---- World text ----

  applyConquestEvents(events: ConquestFx[]): void {
    if (events.length > 0) this.worldText.applyConquestEvents(events);
  }

  applyBonusEvents(events: BonusEvent[]): void {
    if (events.length === 0) return;
    // In a live game, only the local player's; in a replay, everyone's.
    const filtered =
      this.localPlayerID > 0
        ? events.filter((e) => e.smallID === this.localPlayerID)
        : events;
    if (filtered.length > 0) this.worldText.applyBonusEvents(filtered);
  }

  setAttackTroopLabels(labels: AttackTroopLabel[]): void {
    this.worldText.setAttackTroopLabels(labels);
  }

  updateGhostPreview(data: GhostPreviewData | null): void {
    this.worldText.setGhostPreview(data);
  }

  // ---- View state ----

  setLocalPlayerID(id: number): void {
    this.localPlayerID = id;
  }

  setAltView(active: boolean): void {
    this.altView = active;
  }

  setHighlightOwner(ownerID: number): void {
    this.names.setHighlightOwner(ownerID);
  }

  /**
   * The point of the map under the cursor. Names fade while the cursor is
   * over them, and they're placed where the camera draws them, so test
   * against where that point is drawn.
   */
  setMouseWorldPos(x: number, y: number): void {
    const lift = labelLift(this.view, y, this.heightAt(x, y));
    this.names.setMouseWorldPos(x, y - lift);
  }

  setHighlightStructureTypes(unitTypes: string[] | null): void {
    this.levels.setHighlightTypes(unitTypes);
  }

  // ---- Draw ----

  /**
   * Draw every label over what's on the canvas. Expects the GL state at its
   * defaults, and changes it: the caller resets three.js's view of it
   * afterwards.
   */
  draw(gl: WebGL2RenderingContext, view: LabelView): void {
    this.view = view;
    this.placeAgainIfMoved();

    const m = this.camera;
    const sx = (view.zoom * 2) / view.width;
    const sy = (view.zoom * -2) / view.height;
    m[0] = sx;
    m[4] = sy;
    m[6] = -view.camX * sx;
    m[7] = -view.camY * sy;
    m[8] = 1;

    gl.viewport(0, 0, view.width, view.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // Same order as the 2D map: structure levels and bars under the names,
    // world text (attack counts, popups) on top.
    const pe = this.settings.passEnabled;
    if (pe.structure) this.levels.draw(m, view.zoom);
    if (pe.bar) this.bars.draw(m);
    if (pe.name && !this.altView) {
      this.names.draw(m, this.settings.lighting.ambient);
    }
    this.worldText.tick(view.zoom);
    this.worldText.draw(m, view.zoom);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  /**
   * Names, bars and levels are placed once a tick. Place them again when
   * the camera's tilt changes, when it moves north or south while the map
   * is foreshortened, or when models load and change how tall they are.
   * World text is placed every frame and follows on its own.
   */
  private placeAgainIfMoved(): void {
    const v = this.view;
    const p = this.placed;
    const models = this.anchors.loadedModels;
    const moved =
      v.rowScale !== p.rowScale ||
      v.raise !== p.raise ||
      (v.rowScale !== 1 && v.camY !== p.camY);
    if (!moved && models === this.placedModels) return;
    this.placed = { ...v };
    this.placedModels = models;
    if (moved) {
      this.names.updateNames(
        this.liftNames(),
        this.lastPlayers,
        true,
        this.lastStatus,
      );
    }
    this.bars.updateBars(this.lastUnits, this.lastStructures, this.lastTick);
    this.levels.updateStructures(this.lastStructures);
  }

  dispose(): void {
    this.names.dispose();
    this.worldText.dispose();
    this.levels.dispose();
    this.bars.dispose();
  }
}
