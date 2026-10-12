/**
 * ThreeMapRenderer — experimental Three.js map renderer.
 *
 * A drop-in replacement for MapRenderer (it implements the same MapView
 * surface), selected by the "3D map" user setting. It draws the map as a lit
 * 3D heightfield: terrain height comes from each tile's magnitude, the sea
 * floor deepens with distance to land, and the ground's surface detail,
 * territory fill and borders are painted onto it in the fragment shader from
 * the live tile state (TerrainMaterial). A translucent sea surface with
 * waves and surf covers the water (WaterMaterial).
 *
 * The camera is orthographic, looks north and is fed by the same (centerX,
 * centerY, zoom) state as the WebGL2 Camera, plus a tilt away from straight
 * down that the player controls. Across the screen it matches the flat
 * camera; down the screen the map is foreshortened and raised ground drawn
 * further up, which TransformHandler follows through `elevation` (see
 * Elevation.ts).
 *
 * Units and structures are drawn as 3D models (UnitModels), and railroads
 * are drawn into the terrain. Names, troop counts, popups, structure levels
 * and bars are the 2D map's own passes, drawn over the scene (LabelLayer).
 * Not drawn yet: trails, explosions and the other effect passes. Their
 * setters are accepted and ignored so the client can push data to this
 * renderer exactly as it does to MapRenderer.
 */

import type { MapLayer } from "@openfront/engine-api/game/MapFiles";
import type { Config } from "@openfront/engine-lib/configuration/Config";
import * as THREE from "three";
import type { SpiralRibbon } from "../frame/SpiralTrails";
import { GLUnavailableError, initGL } from "../gl/initGL";
import type { MapView } from "../gl/MapView";
import type { SpawnCenter } from "../gl/passes/SpawnOverlayPass";
import type { AttackTroopLabel } from "../gl/passes/WorldTextPass";
import type { RenderSettings } from "../gl/RenderSettings";
import {
  getPaletteSize,
  hexToRgb,
  type TerrainColorOverrides,
} from "../gl/utils/ColorUtils";
import { renderDpr } from "../gl/utils/Dpr";
import type {
  AttackRingInput,
  BonusEvent,
  ConquestFx,
  DeadUnitFx,
  GhostPreviewData,
  NameEntry,
  NukeTelegraphData,
  NukeTrajectoryData,
  PlayerState,
  PlayerStatic,
  PlayerStatusData,
  RendererConfig,
  TerrainRect,
  UnitState,
} from "../types";
import { buildCoastTextures } from "./CoastTextures";
import { DEFAULT_TILT_DEGREES, type SurfaceElevation } from "./Elevation";
import {
  buildHeightGrid,
  buildReliefNormals,
  SurfaceHeights,
} from "./Heightfield";
import { LabelLayer } from "./LabelLayer";
import { createTerrainMaterial, type TerrainUniforms } from "./TerrainMaterial";
import { UnitModels } from "./UnitModels";
import { createWaterMaterial } from "./WaterMaterial";

const PALETTE_SIZE = getPaletteSize();
// Camera distance from the point it looks at, beyond what the view needs.
const CAMERA_MARGIN = 200;
/** Terrain byte bit set on land tiles. */
const LAND_BIT = 0x80;
// Direction the sunlight comes from (normalized below): low from the
// north-west, so relief reads the way a printed relief map does.
const SUN_DIR = new THREE.Vector3(-0.55, 0.65, -0.4).normalize();
const SHADOW_MAP_SIZE = 2048;

export class ThreeMapRenderer implements MapView {
  onContextRestored: (() => void) | null = null;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera();
  private readonly mapW: number;
  private readonly mapH: number;

  // Camera state pushed in each frame (same contract as gl/Camera).
  private camX: number;
  private camY: number;
  private camZoom = 1;
  private camTilt = DEFAULT_TILT_DEGREES;

  // Tile state mirrored into an RGBA8 texture: R = low byte, G = high byte of
  // the 16-bit tile state (owner in bits 0-11, fallout bit 13).
  private readonly ownerData: Uint8Array;
  private readonly ownerTex: THREE.DataTexture;
  private readonly rowDirty: Uint8Array;
  private readonly paletteData: Float32Array;
  private readonly paletteTex: THREE.DataTexture;
  // Land colours, water colours and the land mask (see CoastTextures).
  private readonly terrainTex: THREE.DataTexture;
  private readonly waterTex: THREE.DataTexture;
  private readonly landMaskTex: THREE.DataTexture;
  /** Kind of ground and water depth per tile (see CoastTextures). */
  private readonly kindTex: THREE.DataTexture;
  private readonly depthTex: THREE.DataTexture;
  /** Rail type per tile, 0 for none (as RailroadPass reads it). */
  private readonly railData: Uint8Array;
  private readonly railTex: THREE.DataTexture;
  private readonly terrainMat: THREE.MeshStandardMaterial;
  private readonly sun = new THREE.DirectionalLight(0xfff2de, 2.4);
  private readonly surface: SurfaceHeights;
  private readonly units: UnitModels;
  private readonly labels: LabelLayer;
  private readonly gl: WebGL2RenderingContext;
  /** How the tilted camera draws raised ground; TransformHandler uses it. */
  readonly elevation: SurfaceElevation;
  private readonly uniforms: TerrainUniforms;
  /** Seconds, for the shaders' moving water. */
  private readonly time = { value: 0 };

  private resizeObs: ResizeObserver | null = null;
  private animId: number | null = null;
  private readonly raf: typeof requestAnimationFrame;
  private readonly caf: typeof cancelAnimationFrame;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    header: RendererConfig,
    private readonly terrainSource: () => Uint8Array,
    paletteData: Float32Array,
    config: Config,
    private readonly settings: RenderSettings,
    raf?: typeof requestAnimationFrame,
    caf?: typeof cancelAnimationFrame,
  ) {
    this.mapW = header.mapWidth;
    this.mapH = header.mapHeight;
    this.camX = this.mapW / 2;
    this.camY = this.mapH / 2;
    this.raf = raf ?? requestAnimationFrame.bind(window);
    this.caf = caf ?? cancelAnimationFrame.bind(window);

    // Same GPU gate as the WebGL2 renderer: refuse software contexts.
    const glResult = initGL(canvas, {
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    if (glResult.gl === null) {
      throw new GLUnavailableError(glResult.status, glResult.renderer);
    }
    this.gl = glResult.gl;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context: glResult.gl,
      antialias: true,
    });
    this.renderer.setPixelRatio(renderDpr());
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    const bg = hexToRgb(settings.terrain.backgroundColor) ?? [60, 60, 60];
    this.scene.background = new THREE.Color(`rgb(${bg[0]},${bg[1]},${bg[2]})`);

    const n = this.mapW * this.mapH;
    this.ownerData = new Uint8Array(n * 4);
    this.rowDirty = new Uint8Array(this.mapH);
    this.ownerTex = this.dataTexture(this.ownerData, this.mapW, this.mapH);

    this.paletteData = new Float32Array(PALETTE_SIZE * 2 * 4);
    this.paletteData.set(paletteData);
    this.paletteTex = new THREE.DataTexture(
      this.paletteData,
      PALETTE_SIZE,
      2,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    this.paletteTex.magFilter = THREE.NearestFilter;
    this.paletteTex.minFilter = THREE.NearestFilter;
    this.paletteTex.needsUpdate = true;

    const terrainBytes = terrainSource();
    const coast = buildCoastTextures(
      terrainBytes,
      this.mapW,
      this.mapH,
      this.terrainColors(),
    );
    // Filtered, so colours blend smoothly up close instead of showing tiles.
    const smooth = (tex: THREE.DataTexture) => {
      tex.magFilter = THREE.LinearFilter;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
      tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      return tex;
    };
    this.terrainTex = smooth(
      this.dataTexture(coast.land, this.mapW, this.mapH),
    );
    this.terrainTex.colorSpace = THREE.SRGBColorSpace;
    this.waterTex = smooth(this.dataTexture(coast.water, this.mapW, this.mapH));
    this.waterTex.colorSpace = THREE.SRGBColorSpace;
    this.landMaskTex = smooth(this.byteTexture(coast.mask));
    this.kindTex = smooth(this.dataTexture(coast.kind, this.mapW, this.mapH));
    this.depthTex = smooth(this.byteTexture(coast.depth));
    this.railData = new Uint8Array(n);
    this.railTex = this.byteTexture(this.railData);

    const normalTex = this.dataTexture(
      buildReliefNormals(terrainBytes, this.mapW, this.mapH),
      this.mapW,
      this.mapH,
    );
    normalTex.magFilter = THREE.LinearFilter;
    normalTex.minFilter = THREE.LinearMipmapLinearFilter;
    normalTex.generateMipmaps = true;

    const ocean = hexToRgb(settings.terrain.oceanColor) ?? [71, 133, 181];
    const oceanColor = new THREE.Color(
      `rgb(${ocean[0]},${ocean[1]},${ocean[2]})`,
    );
    const terrainMaterial = createTerrainMaterial(
      {
        owner: this.ownerTex,
        palette: this.paletteTex,
        land: this.terrainTex,
        water: this.waterTex,
        landMask: this.landMaskTex,
        kind: this.kindTex,
        depth: this.depthTex,
        rail: this.railTex,
        relief: normalTex,
      },
      this.mapW,
      this.mapH,
      this.time,
      oceanColor,
    );
    this.terrainMat = terrainMaterial.material;
    this.uniforms = terrainMaterial.uniforms;

    const terrainGeometry = buildHeightGrid(terrainBytes, this.mapW, this.mapH);
    this.surface = new SurfaceHeights(terrainGeometry, this.mapW, this.mapH);
    const surface = this.surface;
    this.elevation = {
      maxHeight: surface.maxHeight,
      heightAt: (x, y) => surface.at(x, y),
    };
    const terrain = new THREE.Mesh(terrainGeometry, this.terrainMat);
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    this.scene.add(terrain);

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(this.mapW, this.mapH),
      createWaterMaterial(
        oceanColor,
        { landMask: this.landMaskTex, depth: this.depthTex },
        this.mapW,
        this.mapH,
        this.time,
      ),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(this.mapW / 2, 0, this.mapH / 2);
    water.receiveShadow = true;
    this.scene.add(water);

    this.scene.add(new THREE.HemisphereLight(0xe4efff, 0x30352a, 1.1));
    // The shadow camera is refitted to the visible area every frame (see
    // fitSunToView), so shadows stay sharp at every zoom level.
    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.3;
    this.scene.add(sun, sun.target);

    this.units = new UnitModels(
      this.scene,
      this.renderer,
      this.mapW,
      this.mapH,
      config.structureMinDist(),
      config.msPerTick(),
      (ownerID, out) => this.ownerColor(ownerID, out),
      (x, y) => {
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        if (tx < 0 || ty < 0 || tx >= this.mapW || ty >= this.mapH) {
          return false;
        }
        return (terrainBytes[ty * this.mapW + tx] & LAND_BIT) === 0;
      },
    );

    this.labels = new LabelLayer(
      this.gl,
      header,
      this.paletteData,
      config,
      settings,
      this.elevation.heightAt,
      this.units,
    );
    // The label passes set GL state behind three.js's back.
    this.renderer.resetState();

    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0) this.resize(rect.width, rect.height);
    this.resizeObs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) this.resize(width, height);
      }
    });
    this.resizeObs.observe(canvas);

    this.animId = this.raf(this.renderLoop);
  }

  private dataTexture(
    data: Uint8Array,
    w: number,
    h: number,
  ): THREE.DataTexture {
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /** A one-byte-per-tile texture. */
  private byteTexture(data: Uint8Array): THREE.DataTexture {
    const tex = new THREE.DataTexture(
      data,
      this.mapW,
      this.mapH,
      THREE.RedFormat,
    );
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return tex;
  }

  private terrainColors(): TerrainColorOverrides {
    const t = this.settings.terrain;
    return {
      backgroundColor: hexToRgb(t.backgroundColor) ?? undefined,
      oceanColor: hexToRgb(t.oceanColor) ?? undefined,
      sandColor: hexToRgb(t.sandColor) ?? undefined,
      plainsColor: hexToRgb(t.plainsColor) ?? undefined,
      highlandColor: hexToRgb(t.highlandColor) ?? undefined,
      mountainColor: hexToRgb(t.mountainColor) ?? undefined,
    };
  }

  private renderLoop = (): void => {
    if (this.disposed) return;
    this.draw();
    this.animId = this.raf(this.renderLoop);
  };

  private draw(): void {
    this.flushOwnerRows();
    this.time.value = performance.now() / 1000;
    const halfW = this.canvas.width / (2 * this.camZoom);
    const halfH = this.canvas.height / (2 * this.camZoom);
    // Looking north from the south, tilted away from straight down.
    const tilt = (this.camTilt * Math.PI) / 180;
    const cos = Math.cos(tilt);
    const sin = Math.sin(tilt);
    // Far enough back that the nearest thing in view, the top of the highest
    // ground at the bottom edge, is still in front of the camera.
    const dist = (halfH * sin + this.surface.maxHeight) / cos + CAMERA_MARGIN;
    const cam = this.camera;
    cam.left = -halfW;
    cam.right = halfW;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.near = 1;
    cam.far = dist * 2;
    cam.position.set(this.camX, dist * cos, this.camY + dist * sin);
    cam.up.set(0, sin, -cos);
    cam.lookAt(this.camX, 0, this.camY);
    cam.updateProjectionMatrix();
    // The ground in view reaches halfH / cos north and south of the centre.
    this.fitSunToView(Math.max(halfW, halfH / cos));
    this.units.draw(this.elevation.heightAt);
    this.renderer.render(this.scene, cam);
    this.renderer.resetState();
    this.labels.draw(this.gl, {
      camX: this.camX,
      camY: this.camY,
      zoom: this.camZoom,
      width: this.canvas.width,
      height: this.canvas.height,
      rowScale: cos,
      raise: sin,
    });
    this.renderer.resetState();
  }

  /** A player's colour (the palette's territory colour) for their models. */
  private ownerColor(ownerID: number, out: THREE.Color): void {
    const d = this.paletteData;
    const i = ownerID * 4;
    out.setRGB(d[i], d[i + 1], d[i + 2], THREE.SRGBColorSpace);
  }

  /** Point the sun's shadow camera at the visible area, snapped to its texels. */
  private fitSunToView(halfExtent: number): void {
    const half = halfExtent * 1.1 + 8;
    const texel = (2 * half) / SHADOW_MAP_SIZE;
    // Snapping the centre to whole shadow texels stops shadows shimmering
    // while the camera pans.
    const cx = Math.round(this.camX / texel) * texel;
    const cy = Math.round(this.camY / texel) * texel;
    const dist = half * 2 + 200;
    const sun = this.sun;
    sun.target.position.set(cx, 0, cy);
    sun.position.set(
      cx + SUN_DIR.x * dist,
      SUN_DIR.y * dist,
      cy + SUN_DIR.z * dist,
    );
    const sc = sun.shadow.camera;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.near = 1;
    sc.far = dist * 2;
    sc.updateProjectionMatrix();
  }

  private resize(cssWidth: number, cssHeight: number): void {
    this.renderer.setPixelRatio(renderDpr());
    this.renderer.setSize(cssWidth, cssHeight, false);
  }

  // ---- MapView: properties ----

  get glLimited(): { renderer: string; maxTextureSize: number } | null {
    return null;
  }

  // ---- MapView: camera ----

  setCameraState(
    x: number,
    y: number,
    z: number,
    tiltDegrees = DEFAULT_TILT_DEGREES,
  ): void {
    this.camX = x;
    this.camY = y;
    this.camZoom = z;
    this.camTilt = tiltDegrees;
  }

  // ---- MapView: territory ----

  uploadTileAndTrailState(
    tileState: Uint16Array,
    _trailState: Uint16Array,
  ): void {
    const d = this.ownerData;
    for (let i = 0; i < tileState.length; i++) {
      const v = tileState[i];
      d[i * 4] = v & 0xff;
      d[i * 4 + 1] = v >> 8;
    }
    this.rowDirty.fill(0);
    this.ownerTex.clearUpdateRanges();
    this.ownerTex.needsUpdate = true;
  }

  uploadLiveDelta(
    tileState: Uint16Array,
    changedTiles: readonly number[],
  ): void {
    const d = this.ownerData;
    const w = this.mapW;
    for (const i of changedTiles) {
      const v = tileState[i];
      d[i * 4] = v & 0xff;
      d[i * 4 + 1] = v >> 8;
      this.rowDirty[(i / w) | 0] = 1;
    }
  }

  /** Queue one texture row upload per row that changed since the last frame. */
  private flushOwnerRows(): void {
    const rowBytes = this.mapW * 4;
    let any = false;
    for (let y = 0; y < this.mapH; y++) {
      if (this.rowDirty[y] === 0) continue;
      this.rowDirty[y] = 0;
      this.ownerTex.addUpdateRange(y * rowBytes, rowBytes);
      any = true;
    }
    if (any) this.ownerTex.needsUpdate = true;
  }

  updatePalette(paletteData: Float32Array): void {
    this.paletteData.set(paletteData);
    this.paletteTex.needsUpdate = true;
    this.labels.refreshPlayerColors(this.paletteData);
  }

  addPlayers(
    players: PlayerStatic[],
    paletteData: Float32Array,
    _patternMeta: Float32Array,
    _patternData: Uint8Array,
  ): void {
    this.updatePalette(paletteData);
    this.labels.addPlayers(players, this.paletteData);
  }

  updatePlayerCosmetics(
    players: PlayerStatic[],
    paletteData: Float32Array,
    _patternMeta: Float32Array,
    _patternData: Uint8Array,
  ): void {
    this.updatePalette(paletteData);
    this.labels.updatePlayerCosmetics(players);
  }

  setHighlightOwner(ownerID: number): void {
    this.uniforms.uHighlight.value = ownerID;
    this.labels.setHighlightOwner(ownerID);
  }

  // ---- MapView: terrain ----

  applyTerrainRects(_rects: readonly TerrainRect[], _bytes: Uint8Array): void {
    // Water nukes change terrain bytes; re-bake colors from the source.
    this.rebuildTerrain();
  }

  rebuildTerrain(): void {
    const coast = buildCoastTextures(
      this.terrainSource(),
      this.mapW,
      this.mapH,
      this.terrainColors(),
    );
    const textures: [THREE.DataTexture, Uint8Array][] = [
      [this.terrainTex, coast.land],
      [this.waterTex, coast.water],
      [this.landMaskTex, coast.mask],
      [this.kindTex, coast.kind],
      [this.depthTex, coast.depth],
    ];
    for (const [tex, data] of textures) {
      (tex.image as { data: Uint8Array }).data.set(data);
      tex.needsUpdate = true;
    }
  }

  getSettings(): RenderSettings {
    return this.settings;
  }

  // ---- MapView: units ----

  updateUnits(units: Map<number, UnitState>, gameTick: number): void {
    this.units.update(units);
    this.labels.updateUnits(units, gameTick);
  }

  updateStructures(units: Map<number, UnitState>): void {
    this.labels.updateStructures(units);
  }

  uploadRailroadState(data: Uint8Array): void {
    if (data.length !== this.railData.length) return;
    this.railData.set(data);
    this.railTex.needsUpdate = true;
  }

  // ---- MapView: names and labels ----

  updateNames(
    names: Map<string, NameEntry>,
    players: Map<number, PlayerState>,
    snap: boolean,
    statusData?: Map<number, PlayerStatusData>,
  ): void {
    this.labels.updateNames(names, players, snap, statusData);
  }

  refreshNames(displayNames: Map<string, string>): void {
    this.labels.refreshNames(displayNames);
  }

  applyConquestEvents(events: ConquestFx[]): void {
    this.labels.applyConquestEvents(events);
  }

  setAttackTroopLabels(labels: AttackTroopLabel[]): void {
    this.labels.setAttackTroopLabels(labels);
  }

  applyBonusEvents(events: BonusEvent[]): void {
    this.labels.applyBonusEvents(events);
  }

  updateGhostPreview(data: GhostPreviewData | null): void {
    this.labels.updateGhostPreview(data);
  }

  setLocalPlayerID(id: number): void {
    this.labels.setLocalPlayerID(id);
  }

  setAltView(active: boolean): void {
    this.labels.setAltView(active);
  }

  setMouseWorldPos(x: number, y: number): void {
    this.labels.setMouseWorldPos(x, y);
  }

  setHighlightStructureTypes(unitTypes: string[] | null): void {
    this.labels.setHighlightStructureTypes(unitTypes);
  }

  // ---- MapView: not drawn yet ----

  uploadLiveTrailDelta(
    _trailState: Uint16Array,
    _dirtyRowMin: number,
    _dirtyRowMax: number,
  ): void {}
  updateSpiralRibbons(_ribbons: readonly SpiralRibbon[]): void {}
  updateEffectPalette(_effectData: Float32Array): void {}
  setPlayerSkin(_smallID: number, _url: string | null): void {}
  initSkinAtlas(_urls: readonly string[]): void {}
  setPlayerSpawn(_smallID: number, _x: number, _y: number): void {}
  updateRelations(_data: Uint8Array, _size: number): void {}
  applyDeadUnits(_deadUnits: DeadUnitFx[]): void {}
  triggerBlockedFlash(_tileX: number, _tileY: number): void {}
  applyRailroadDust(_tileRefs: number[]): void {}
  updateAttackRings(_rings: AttackRingInput[]): void {}
  updateNukeTrajectory(_data: NukeTrajectoryData | null): void {}
  updateNukeTelegraphs(_data: NukeTelegraphData[]): void {}
  updateSpawnOverlay(_inSpawnPhase: boolean, _centers: SpawnCenter[]): void {}
  updateSmallPlayerGlow(_set: Uint8Array | null): void {}
  setMapLayers(_layers: MapLayer[], _images: Map<string, ImageBitmap>): void {}
  setLayerVisible(_layerId: string, _visible: boolean): void {}
  setLayerAlpha(_layerId: string, _alpha: number): void {}
  markLayerTilesDestroyed(_layerId: string, _tileIndices: number[]): void {}
  setLayerDestroyedMask(_layerId: string, _mask: Uint8Array): void {}
  setSelectedUnits(_unitIds: readonly number[]): void {}
  showMoveIndicator(_tileX: number, _tileY: number, _ownerID: number): void {}
  setSAMAllianceClusters(_clusters: Map<number, number>): void {}
  setLocalRailColor(_r: number, _g: number, _b: number): void {}
  setGridView(_active: boolean): void {}

  // ---- Lifecycle ----

  dispose(): void {
    this.disposed = true;
    if (this.animId !== null) this.caf(this.animId);
    this.animId = null;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.onContextRestored = null;
    this.units.dispose();
    this.labels.dispose();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.ownerTex.dispose();
    this.paletteTex.dispose();
    this.terrainTex.dispose();
    this.waterTex.dispose();
    this.landMaskTex.dispose();
    this.kindTex.dispose();
    this.depthTex.dispose();
    this.railTex.dispose();
    this.terrainMat.normalMap?.dispose();
    this.renderer.dispose();
  }
}
