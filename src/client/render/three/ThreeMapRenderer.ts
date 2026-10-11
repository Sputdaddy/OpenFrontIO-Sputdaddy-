/**
 * ThreeMapRenderer — experimental Three.js map renderer.
 *
 * A drop-in replacement for MapRenderer (it implements the same MapView
 * surface), selected by the "3D map" user setting. It draws the map as a lit
 * 3D heightfield: terrain height comes from each tile's magnitude, the sea
 * floor deepens with distance to land, and territory fill and borders are
 * composited onto the terrain in the fragment shader from the live tile
 * state, the same way TerritoryPass does it.
 *
 * The camera is orthographic, tilted TILT_DEGREES from straight down and fed
 * by the same (centerX, centerY, zoom) state as the WebGL2 Camera. Its
 * frustum is squashed so sea level lands exactly where the flat camera puts
 * it; raised ground is drawn further up the screen, and TransformHandler
 * corrects for that through `elevation` (see Elevation.ts).
 *
 * Cities, missile silos and warships are drawn as 3D models (UnitModels).
 * Not drawn yet: other units and structures, names, trails, railroads and
 * the other effect passes. Their setters are accepted and ignored so the
 * client can push data to this renderer exactly as it does to MapRenderer.
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
  buildTerrainRGBA,
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
import { type SurfaceElevation, TILT_DEGREES, TILT_SHIFT } from "./Elevation";
import {
  buildHeightGrid,
  buildReliefNormals,
  SurfaceHeights,
} from "./Heightfield";
import { UnitModels } from "./UnitModels";

const PALETTE_SIZE = getPaletteSize();
const TILT = (TILT_DEGREES * Math.PI) / 180;
// Camera distance from the point it looks at, beyond what the view needs.
const CAMERA_MARGIN = 200;
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

  // Tile state mirrored into an RGBA8 texture: R = low byte, G = high byte of
  // the 16-bit tile state (owner in bits 0-11, fallout bit 13).
  private readonly ownerData: Uint8Array;
  private readonly ownerTex: THREE.DataTexture;
  private readonly rowDirty: Uint8Array;
  private readonly paletteData: Float32Array;
  private readonly paletteTex: THREE.DataTexture;
  private readonly terrainTex: THREE.DataTexture;
  private readonly terrainMat: THREE.MeshStandardMaterial;
  private readonly sun = new THREE.DirectionalLight(0xfff2de, 2.4);
  private readonly surface: SurfaceHeights;
  private readonly units: UnitModels;
  /** How the tilted camera draws raised ground; TransformHandler uses it. */
  readonly elevation: SurfaceElevation;
  private readonly uniforms = {
    uOwner: { value: null as THREE.Texture | null },
    uPalette: { value: null as THREE.Texture | null },
    uMapSize: { value: new THREE.Vector2() },
    uHighlight: { value: 0 },
  };

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
    this.terrainTex = this.dataTexture(
      buildTerrainRGBA(
        terrainBytes,
        this.mapW,
        this.mapH,
        this.terrainColors(),
      ),
      this.mapW,
      this.mapH,
    );
    this.terrainTex.colorSpace = THREE.SRGBColorSpace;
    // Crisp tile edges up close, like the WebGL2 renderer.
    this.terrainTex.magFilter = THREE.NearestFilter;
    this.terrainTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.terrainTex.generateMipmaps = true;
    this.terrainTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();

    const normalTex = this.dataTexture(
      buildReliefNormals(terrainBytes, this.mapW, this.mapH),
      this.mapW,
      this.mapH,
    );
    normalTex.magFilter = THREE.LinearFilter;
    normalTex.minFilter = THREE.LinearMipmapLinearFilter;
    normalTex.generateMipmaps = true;

    this.uniforms.uOwner.value = this.ownerTex;
    this.uniforms.uPalette.value = this.paletteTex;
    this.uniforms.uMapSize.value.set(this.mapW, this.mapH);

    this.terrainMat = new THREE.MeshStandardMaterial({
      map: this.terrainTex,
      normalMap: normalTex,
      normalScale: new THREE.Vector2(0.8, 0.8),
      roughness: 0.92,
      metalness: 0,
    });
    this.terrainMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          varying float vHeight;`,
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          vHeight = transformed.y;`,
        );
      shader.fragmentShader = shader.fragmentShader
        // The seabed takes no shadows: seen through the water they land far
        // from what casts them, and ships look like they're floating.
        .replace(
          "#include <lights_fragment_begin>",
          THREE.ShaderChunk.lights_fragment_begin
            .split("receiveShadow")
            .join("(receiveShadow && vHeight > -0.05)"),
        )
        .replace(
          "#include <common>",
          `#include <common>
          varying float vHeight;
          uniform sampler2D uOwner;
          uniform sampler2D uPalette;
          uniform vec2 uMapSize;
          uniform float uHighlight;
          uvec2 tileAt(ivec2 t) {
            t = clamp(t, ivec2(0), ivec2(uMapSize) - 1);
            vec4 o = texelFetch(uOwner, t, 0);
            uint lo = uint(o.r * 255.0 + 0.5);
            uint hi = uint(o.g * 255.0 + 0.5);
            return uvec2(lo | ((hi & 15u) << 8), hi);
          }`,
        )
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
          {
            ivec2 t = ivec2(floor(vMapUv * uMapSize));
            uvec2 s = tileAt(t);
            uint own = s.x;
            if ((s.y & 32u) != 0u) {
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.09, 0.13, 0.03), 0.6);
            }
            if (own != 0u) {
              bool border =
                tileAt(t + ivec2(1, 0)).x != own || tileAt(t - ivec2(1, 0)).x != own ||
                tileAt(t + ivec2(0, 1)).x != own || tileAt(t - ivec2(0, 1)).x != own;
              vec4 fill = texelFetch(uPalette, ivec2(int(own), 0), 0);
              vec4 edge = texelFetch(uPalette, ivec2(int(own), 1), 0);
              float hl = float(own) == uHighlight ? 1.0 : 0.0;
              if (border) {
                diffuseColor.rgb = pow(edge.rgb, vec3(2.2));
              } else {
                float a = clamp(fill.a + hl * 0.2, 0.0, 1.0);
                diffuseColor.rgb = mix(diffuseColor.rgb, pow(fill.rgb, vec3(2.2)), a);
              }
            }
          }`,
        );
    };

    const terrainGeometry = buildHeightGrid(terrainBytes, this.mapW, this.mapH);
    this.surface = new SurfaceHeights(terrainGeometry, this.mapW, this.mapH);
    const surface = this.surface;
    this.elevation = {
      shift: TILT_SHIFT,
      maxHeight: surface.maxHeight,
      heightAt: (x, y) => surface.at(x, y),
    };
    const terrain = new THREE.Mesh(terrainGeometry, this.terrainMat);
    terrain.castShadow = true;
    terrain.receiveShadow = true;
    this.scene.add(terrain);

    const ocean = hexToRgb(settings.terrain.oceanColor) ?? [71, 133, 181];
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(this.mapW, this.mapH),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(`rgb(${ocean[0]},${ocean[1]},${ocean[2]})`),
        roughness: 0.2,
        metalness: 0.1,
        transparent: true,
        opacity: 0.55,
      }),
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
      config.msPerTick(),
      (ownerID, out) => this.ownerColor(ownerID, out),
    );

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
    const halfW = this.canvas.width / (2 * this.camZoom);
    const halfH = this.canvas.height / (2 * this.camZoom);
    // Tilted toward the north. Squashing the frustum's height by cos(tilt)
    // undoes the foreshortening, so sea level maps to the screen exactly as
    // with a straight-down camera.
    const cos = Math.cos(TILT);
    const sin = Math.sin(TILT);
    const dist = halfH * sin + this.surface.maxHeight + CAMERA_MARGIN;
    const cam = this.camera;
    cam.left = -halfW;
    cam.right = halfW;
    cam.top = halfH * cos;
    cam.bottom = -halfH * cos;
    cam.near = 1;
    cam.far = dist * 2 + halfH;
    cam.position.set(this.camX, dist * cos, this.camY + dist * sin);
    cam.up.set(0, sin, -cos);
    cam.lookAt(this.camX, 0, this.camY);
    cam.updateProjectionMatrix();
    this.fitSunToView(Math.max(halfW, halfH));
    this.units.draw(this.elevation.heightAt);
    this.renderer.render(this.scene, cam);
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

  setCameraState(x: number, y: number, z: number): void {
    this.camX = x;
    this.camY = y;
    this.camZoom = z;
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
  }

  addPlayers(
    _players: PlayerStatic[],
    paletteData: Float32Array,
    _patternMeta: Float32Array,
    _patternData: Uint8Array,
  ): void {
    this.updatePalette(paletteData);
  }

  updatePlayerCosmetics(
    _players: PlayerStatic[],
    paletteData: Float32Array,
    _patternMeta: Float32Array,
    _patternData: Uint8Array,
  ): void {
    this.updatePalette(paletteData);
  }

  setHighlightOwner(ownerID: number): void {
    this.uniforms.uHighlight.value = ownerID;
  }

  // ---- MapView: terrain ----

  applyTerrainRects(_rects: readonly TerrainRect[], _bytes: Uint8Array): void {
    // Water nukes change terrain bytes; re-bake colors from the source.
    this.rebuildTerrain();
  }

  rebuildTerrain(): void {
    const img = this.terrainTex.image as { data: Uint8Array };
    img.data.set(
      buildTerrainRGBA(
        this.terrainSource(),
        this.mapW,
        this.mapH,
        this.terrainColors(),
      ),
    );
    this.terrainTex.needsUpdate = true;
  }

  getSettings(): RenderSettings {
    return this.settings;
  }

  // ---- MapView: units ----

  updateUnits(units: Map<number, UnitState>, _gameTick: number): void {
    this.units.update(units);
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
  uploadRailroadState(_data: Uint8Array): void {}
  updateNames(
    _names: Map<string, NameEntry>,
    _players: Map<number, PlayerState>,
    _snap: boolean,
    _statusData?: Map<number, PlayerStatusData>,
  ): void {}
  refreshNames(_displayNames: Map<string, string>): void {}
  updateRelations(_data: Uint8Array, _size: number): void {}
  updateStructures(_units: Map<number, UnitState>): void {}
  applyDeadUnits(_deadUnits: DeadUnitFx[]): void {}
  applyConquestEvents(_events: ConquestFx[]): void {}
  setAttackTroopLabels(_labels: AttackTroopLabel[]): void {}
  applyBonusEvents(_events: BonusEvent[]): void {}
  triggerBlockedFlash(_tileX: number, _tileY: number): void {}
  applyRailroadDust(_tileRefs: number[]): void {}
  updateAttackRings(_rings: AttackRingInput[]): void {}
  updateGhostPreview(_data: GhostPreviewData | null): void {}
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
  setLocalPlayerID(_id: number): void {}
  setLocalRailColor(_r: number, _g: number, _b: number): void {}
  setAltView(_active: boolean): void {}
  setGridView(_active: boolean): void {}
  setMouseWorldPos(_x: number, _y: number): void {}
  setHighlightStructureTypes(_unitTypes: string[] | null): void {}

  // ---- Lifecycle ----

  dispose(): void {
    this.disposed = true;
    if (this.animId !== null) this.caf(this.animId);
    this.animId = null;
    this.resizeObs?.disconnect();
    this.resizeObs = null;
    this.onContextRestored = null;
    this.units.dispose();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
    this.ownerTex.dispose();
    this.paletteTex.dispose();
    this.terrainTex.dispose();
    this.terrainMat.normalMap?.dispose();
    this.renderer.dispose();
  }
}
