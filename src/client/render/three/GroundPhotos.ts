/**
 * Photo textures for the 3D map's ground (see TerrainMaterial): one set of
 * CC0 photos per kind of ground, listed in ground-photos.json and downloaded
 * into resources/textures/terrain/ by scripts/textures/fetch_ground_photos.mjs.
 *
 * Each set is a colour photo with matching normal, roughness and height
 * maps. They are resized to PHOTO_SIZE and packed into two texture arrays
 * with one layer per kind of ground:
 * - colour: RGB colour (sRGB), A roughness
 * - normal: RGB normal (OpenGL convention), A height
 *
 * The photos are optional. Until they load, or if they were never
 * downloaded, the terrain keeps its procedural detail.
 */

import { assetUrl } from "@openfront/shared/AssetUrls";
import * as THREE from "three";
import config from "./ground-photos.json";

export interface GroundLayer {
  /** Kind of ground; its files are listed under this key in index.json. */
  readonly key: string;
  /** Poly Haven asset the photos come from. */
  readonly polyhaven: string;
  /** How many tiles one copy of the photo spans. */
  readonly tiles: number;
  /**
   * How far the photo is tinted towards each tile's own colour, 0-1: at 1
   * only its light and shade (and a little of its colour) are kept.
   */
  readonly tint: number;
}

/** The layers, in texture array order. */
export const GROUND_LAYERS: readonly GroundLayer[] = config.layers;

/** Width and height each photo is resized to. */
export const PHOTO_SIZE = 2048;

/** Folder (under resources/) holding the photos and their index.json. */
const PHOTO_DIR = "textures/terrain";
/** Roughness where a set has no roughness map. */
const DEFAULT_ROUGHNESS = 230;
/** Height where a set has no height map. */
const DEFAULT_HEIGHT = 128;

export type PhotoMap = "color" | "normal" | "rough" | "height";

/** One layer's decoded maps, RGBA, PHOTO_SIZE square; null where missing. */
export type LayerPixels = Record<PhotoMap, Uint8ClampedArray | null>;

export interface GroundPhotos {
  /** RGB colour (sRGB), A roughness; one layer per GROUND_LAYERS entry. */
  readonly color: THREE.DataArrayTexture;
  /** RGB normal (OpenGL convention), A height. */
  readonly normal: THREE.DataArrayTexture;
  /** 1 for each layer whose photos loaded, else 0. */
  readonly present: number[];
  /** Each layer's average colour, linear. */
  readonly mean: THREE.Vector3[];
}

/**
 * Packs one layer's maps into the two array buffers at `layer`, and says
 * whether it is usable: it needs at least a colour photo and a normal map.
 * An unusable layer is filled with flat grey so it never shows.
 */
export function packGroundLayer(
  pixels: number,
  layer: number,
  maps: LayerPixels,
  outColor: Uint8Array,
  outNormal: Uint8Array,
): boolean {
  const base = layer * pixels * 4;
  const { color, normal, rough, height } = maps;
  if (color === null || normal === null) {
    for (let i = 0; i < pixels; i++) {
      const o = base + i * 4;
      outColor.set([128, 128, 128, DEFAULT_ROUGHNESS], o);
      outNormal.set([128, 128, 255, DEFAULT_HEIGHT], o);
    }
    return false;
  }
  for (let i = 0; i < pixels; i++) {
    const s = i * 4;
    const o = base + s;
    outColor[o] = color[s];
    outColor[o + 1] = color[s + 1];
    outColor[o + 2] = color[s + 2];
    outColor[o + 3] = rough === null ? DEFAULT_ROUGHNESS : rough[s];
    outNormal[o] = normal[s];
    outNormal[o + 1] = normal[s + 1];
    outNormal[o + 2] = normal[s + 2];
    outNormal[o + 3] = height === null ? DEFAULT_HEIGHT : height[s];
  }
  return true;
}

/** Average colour of an RGBA sRGB image, in linear values. */
export function meanLinearColor(rgba: Uint8ClampedArray): THREE.Vector3 {
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const c = v / 255;
    lut[v] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  let r = 0;
  let g = 0;
  let b = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    r += lut[rgba[i]];
    g += lut[rgba[i + 1]];
    b += lut[rgba[i + 2]];
  }
  return new THREE.Vector3(r / n, g / n, b / n);
}

/**
 * Loads every layer's photos. Resolves to null when no layer has photos
 * (they were never downloaded), and never rejects.
 */
export async function loadGroundPhotos(
  anisotropy: number,
): Promise<GroundPhotos | null> {
  const index = await fetchIndex();
  if (index === null) return null;
  const pixels = PHOTO_SIZE * PHOTO_SIZE;
  const layers = GROUND_LAYERS.length;
  const color = new Uint8Array(pixels * 4 * layers);
  const normal = new Uint8Array(pixels * 4 * layers);
  const present = GROUND_LAYERS.map(() => 0);
  const mean = GROUND_LAYERS.map(() => new THREE.Vector3(0.5, 0.5, 0.5));
  await Promise.all(
    GROUND_LAYERS.map(async (layer, i) => {
      const files = index[layer.key] ?? {};
      const read = (map: PhotoMap) => {
        const file = files[map];
        return file === undefined ? Promise.resolve(null) : readPixels(file);
      };
      const [c, n, r, h] = await Promise.all([
        read("color"),
        read("normal"),
        read("rough"),
        read("height"),
      ]);
      const maps = { color: c, normal: n, rough: r, height: h };
      if (packGroundLayer(pixels, i, maps, color, normal) && c !== null) {
        present[i] = 1;
        mean[i] = meanLinearColor(c);
      }
    }),
  );
  if (!present.includes(1)) return null;
  return {
    color: arrayTexture(color, layers, anisotropy, true),
    normal: arrayTexture(normal, layers, anisotropy, false),
    present,
    mean,
  };
}

/** A one-texel stand-in for the arrays until the photos load. */
export function emptyPhotoArray(): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(
    new Uint8Array([128, 128, 255, 128]),
    1,
    1,
    1,
  );
  tex.needsUpdate = true;
  return tex;
}

async function fetchIndex(): Promise<Record<
  string,
  Partial<Record<PhotoMap, string>>
> | null> {
  try {
    const res = await fetch(assetUrl(`${PHOTO_DIR}/index.json`));
    if (!res.ok) return null;
    const json = (await res.json()) as {
      layers?: Record<string, Partial<Record<PhotoMap, string>>>;
    };
    return json.layers ?? null;
  } catch {
    // Missing (the dev server answers with the page instead) or unreadable.
    return null;
  }
}

/** Decodes an image file, resized to PHOTO_SIZE square, as RGBA bytes. */
async function readPixels(file: string): Promise<Uint8ClampedArray | null> {
  try {
    const res = await fetch(assetUrl(`${PHOTO_DIR}/${file}`));
    if (!res.ok) return null;
    // No colour management: normal and height maps hold data, not colour.
    const bitmap = await createImageBitmap(await res.blob(), {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
    const canvas = new OffscreenCanvas(PHOTO_SIZE, PHOTO_SIZE);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) return null;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    bitmap.close();
    return ctx.getImageData(0, 0, PHOTO_SIZE, PHOTO_SIZE).data;
  } catch {
    return null;
  }
}

function arrayTexture(
  data: Uint8Array,
  layers: number,
  anisotropy: number,
  srgb: boolean,
): THREE.DataArrayTexture {
  const tex = new THREE.DataArrayTexture(data, PHOTO_SIZE, PHOTO_SIZE, layers);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}
