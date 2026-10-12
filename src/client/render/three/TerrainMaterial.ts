/**
 * The 3D map's ground: a lit standard material whose fragment shader paints
 * the terrain from the per-tile textures and the live tile state.
 *
 * - Surface detail. The per-tile colours set each area's tone; on top, noise
 *   in tile space adds grass with dry patches and woods, scrub and bare earth
 *   on highlands, ridged rock on mountains and steep slopes, snow on high
 *   ground and wet sand at the waterline, each with matching bumps for the
 *   lighting. Detail finer than a couple of pixels fades out, so it adds
 *   sharpness up close without shimmering zoomed out.
 * - Coast. Land and water colours meet where the smoothed land mask crosses
 *   one half (smoothMask), and the seabed gets caustics in the shallows.
 * - Territory. A translucent fill so the ground shows through, and a solid
 *   border band, both following the same smoothed curves as the coast.
 * - Railroads, drawn from the per-tile rail type.
 */

import * as THREE from "three";
import { DEPTH_SCALE } from "./CoastTextures";
import { NOISE_GLSL, SMOOTH_MASK_GLSL, WATER_GLSL } from "./ShaderLib";

/** Territory fill opacity over the 3D terrain; borders stay solid. */
export const TERRITORY_FILL_ALPHA = 0.3;
/** Extra fill opacity on the territory under the cursor. */
const HIGHLIGHT_FILL_BOOST = 0.15;
/** Height (world units) above which high ground is snow-capped. */
const SNOW_LINE = 4.6;

export interface TerrainTextures {
  /** Tile state: R low byte, G high byte (owner in bits 0-11, fallout 13). */
  readonly owner: THREE.Texture;
  /** Territory fill (row 0) and border (row 1) colour per owner. */
  readonly palette: THREE.Texture;
  /** Land colours (see CoastTextures), sRGB. */
  readonly land: THREE.Texture;
  /** Water colours, sRGB. */
  readonly water: THREE.Texture;
  /** Land mask, one byte per tile. */
  readonly landMask: THREE.Texture;
  /** Kind of ground per tile (see CoastTextures.kind). */
  readonly kind: THREE.Texture;
  /** Water depth per tile (see CoastTextures.depth). */
  readonly depth: THREE.Texture;
  /** Rail type per tile. */
  readonly rail: THREE.Texture;
  /** Per-tile relief normals. */
  readonly relief: THREE.Texture;
}

export type TerrainUniforms = ReturnType<typeof terrainUniforms>;

function terrainUniforms(
  t: TerrainTextures,
  mapW: number,
  mapH: number,
  time: { value: number },
  oceanColor: THREE.Color,
) {
  return {
    uOwner: { value: t.owner },
    uPalette: { value: t.palette },
    uMapSize: { value: new THREE.Vector2(mapW, mapH) },
    uHighlight: { value: 0 },
    uWater: { value: t.water },
    uLand: { value: t.landMask },
    uKind: { value: t.kind },
    uDepth: { value: t.depth },
    uRail: { value: t.rail },
    uFillAlpha: { value: TERRITORY_FILL_ALPHA },
    uOceanColor: { value: oceanColor },
    uTime: time,
  };
}

export function createTerrainMaterial(
  textures: TerrainTextures,
  mapW: number,
  mapH: number,
  time: { value: number },
  oceanColor: THREE.Color,
): { material: THREE.MeshStandardMaterial; uniforms: TerrainUniforms } {
  const uniforms = terrainUniforms(textures, mapW, mapH, time, oceanColor);
  const material = new THREE.MeshStandardMaterial({
    map: textures.land,
    normalMap: textures.relief,
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughness: 0.92,
    metalness: 0,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
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
      .replace("#include <common>", `#include <common>\n${FRAGMENT_COMMON}`)
      .replace("#include <map_fragment>", MAP_FRAGMENT)
      .replace(
        "#include <roughnessmap_fragment>",
        "float roughnessFactor = detailRough;",
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        normal = normalize(normal
          + (viewMatrix * vec4(-detailGrad.x, 0.0, -detailGrad.y, 0.0)).xyz);`,
      )
      // The seabed takes no shadows: seen through the water they land far
      // from what casts them, and ships look like they're floating.
      .replace(
        "#include <lights_fragment_begin>",
        THREE.ShaderChunk.lights_fragment_begin
          .split("receiveShadow")
          .join("(receiveShadow && (vHeight > -0.05 || landMix > 0.5))"),
      );
  };
  return { material, uniforms };
}

const FRAGMENT_COMMON = /* glsl */ `
varying float vHeight;
uniform sampler2D uOwner;
uniform sampler2D uPalette;
uniform vec2 uMapSize;
uniform float uHighlight;
uniform sampler2D uWater;
uniform sampler2D uLand;
uniform sampler2D uKind;
uniform sampler2D uDepth;
uniform sampler2D uRail;
uniform float uFillAlpha;
uniform vec3 uOceanColor;
uniform float uTime;
${NOISE_GLSL}
${SMOOTH_MASK_GLSL}
${WATER_GLSL}

float segmentDistance(vec2 p, vec2 a, vec2 b, out float along) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  along = dot(a + ab * t, abs(normalize(ab)));
  return length(p - a - ab * t);
}

// Distance from p (in the tile) to a rail's centreline: straight across
// (1 vertical, 2 horizontal) or a corner joining the top or bottom edge to
// the left or right one (3-6). along runs along the track, for the sleepers.
float railDistance(uint rail, vec2 p, out float along) {
  if (rail == 1u) return segmentDistance(p, vec2(0.5, 0.0), vec2(0.5, 1.0), along);
  if (rail == 2u) return segmentDistance(p, vec2(0.0, 0.5), vec2(1.0, 0.5), along);
  vec2 c = vec2(0.5);
  vec2 e1 = vec2(0.5, (rail == 3u || rail == 4u) ? 0.0 : 1.0);
  vec2 e2 = vec2((rail == 3u || rail == 5u) ? 0.0 : 1.0, 0.5);
  float a1;
  float a2;
  float d1 = segmentDistance(p, c, e1, a1);
  float d2 = segmentDistance(p, c, e2, a2);
  along = d1 < d2 ? a1 : a2;
  return min(d1, d2);
}

uvec2 tileAt(ivec2 t) {
  t = clamp(t, ivec2(0), ivec2(uMapSize) - 1);
  vec4 o = texelFetch(uOwner, t, 0);
  uint lo = uint(o.r * 255.0 + 0.5);
  uint hi = uint(o.g * 255.0 + 0.5);
  return uvec2(lo | ((hi & 15u) << 8), hi);
}

/** Cubic B-spline weights of the four texels around fraction f. */
vec4 bsplineWeights(float f) {
  float f2 = f * f;
  float f3 = f2 * f;
  return vec4(
    1.0 - 3.0 * f + 3.0 * f2 - f3,
    4.0 - 6.0 * f2 + 3.0 * f3,
    1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3,
    f3) / 6.0;
}

/** Light rippling over the shallow seabed: bright lines where two moving
 * wave patterns cancel out. */
float caustics(vec2 p, float t, float px) {
  float fade = octaveFade(1.4, px);
  if (fade <= 0.0) return 0.0;
  vec2 q = p * 1.4;
  float a = gradNoise(q + vec2(0.3, 0.2) * t, 91u).x;
  float b = gradNoise(q * 1.3 + vec2(-0.25, 0.31) * t, 92u).x;
  float c = clamp(1.0 - abs(a + b) * 2.2, 0.0, 1.0);
  return fade * c * c * c * c;
}
`;

const MAP_FRAGMENT = /* glsl */ `
vec2 detailGrad = vec2(0.0);
float detailRough = roughness;
float landMix = 0.0;
{
  vec2 tp = vMapUv * uMapSize;
  float px = tilesPerPixel(tp);
  vec2 uvDx = dFdx(vMapUv);
  vec2 uvDy = dFdy(vMapUv);
  float slope = 1.0 - inverseTransformDirection(normalize(vNormal), viewMatrix).y;

  // Coast: land colours inside the smoothed land mask's half contour,
  // water colours outside it, antialiased across the line.
  float landCov = smoothMask(uLand, tp, uMapSize, uvDx, uvDy);
  float aa = max(fwidth(landCov), 1e-3);
  landMix = smoothstep(0.5 - aa, 0.5 + aa, landCov);

  // Shared noise: patches tens of tiles across, a few tiles, and grain
  // within a tile.
  vec3 nBig = fbm(tp, 0.04, 3, px, 11u);
  vec3 nMid = fbm(tp, 0.35, 3, px, 12u);
  vec3 nFine = fbm(tp, 2.4, 4, px, 13u);

  // Ground colours are looked up a tile or two off, so the edges between
  // kinds of ground wander instead of following the tile grid.
  vec2 warp =
    0.9 * vec2(gradNoise(tp * 0.3, 21u).x, gradNoise(tp * 0.3, 22u).x)
    + 1.6 * vec2(gradNoise(tp * 0.08, 23u).x, gradNoise(tp * 0.08, 24u).x);
  vec2 wuv = (tp + warp) / uMapSize;
  vec3 base = textureGrad(map, wuv, uvDx, uvDy).rgb;
  vec4 kind = textureGrad(uKind, wuv, uvDx, uvDy);
  kind /= max(dot(kind, vec4(1.0)), 1e-3);

  // Plains: grass with dry patches, and woods of round tree crowns.
  vec3 grass = base * (1.0 + 0.3 * nBig.x + 0.2 * nMid.x + 0.22 * nFine.x);
  float dry = smoothstep(0.0, 0.3, fbm(tp, 0.1, 2, px, 31u).x);
  grass *= mix(vec3(1.0), vec3(1.12, 1.02, 0.72), dry * 0.7);
  float woods = smoothstep(0.12, 0.26, fbm(tp, 0.045, 3, px, 32u).x + 0.12 * nMid.x);
  float treeFade = octaveFade(3.0, px);
  vec3 trees = bumps(tp, 3.0, 0.55, 0.85, 33u);
  vec3 forest = base * vec3(0.5, 0.64, 0.45)
    * (0.8 + treeFade * (0.6 * trees.x - 0.25) + 0.15 * nFine.x);
  grass = mix(grass, forest, woods);
  vec2 grassGrad = 0.08 * nMid.yz + 0.05 * nFine.yz
    + woods * treeFade * 0.08 * trees.yz;

  // Highlands: bare earth, and clumps of scrub.
  vec3 high = base * (1.0 + 0.28 * nBig.x + 0.2 * nMid.x + 0.26 * nFine.x);
  float dirt = smoothstep(-0.05, 0.3, fbm(tp, 0.15, 3, px, 34u).x);
  high *= mix(vec3(1.0), vec3(0.9, 0.78, 0.64), dirt * 0.6);
  float scrubFade = octaveFade(2.2, px);
  float scrubPatch = smoothstep(-0.1, 0.25, fbm(tp, 0.2, 2, px, 37u).x);
  vec3 scrub = bumps(tp, 2.2, 0.42, 0.7 * scrubPatch, 35u);
  // Squared, so each bush fades out softly at its rim.
  float bush = scrub.x * scrub.x * scrubFade;
  high = mix(high, base * vec3(0.62, 0.66, 0.48), bush * 0.55);
  vec2 highGrad = 0.14 * nMid.yz + 0.08 * nFine.yz
    + scrubFade * 0.06 * scrub.x * scrub.yz;

  // Mountains: ridged rock with dark cracks.
  vec3 crag = ridged(tp, 0.3, 6, px, 36u);
  vec3 rock = mix(vec3(0.24, 0.23, 0.21), base * 0.55, 0.45)
    * (0.7 + 0.6 * crag.x) * (1.0 + 0.2 * nFine.x);
  vec2 rockGrad = 0.22 * crag.yz + 0.1 * nFine.yz;

  // Beaches: fine sand.
  vec3 sand = base * (1.0 + 0.08 * nMid.x + 0.12 * nFine.x);
  vec2 sandGrad = 0.03 * nFine.yz;

  vec3 ground = grass * kind.r + high * kind.g + rock * kind.b + sand * kind.a;
  vec2 grad = grassGrad * kind.r + highGrad * kind.g + rockGrad * kind.b
    + sandGrad * kind.a;
  float rough = 0.96 * kind.r + 0.94 * kind.g + 0.86 * kind.b + 0.9 * kind.a;

  // Steep slopes are bare rock; high ground is snow-capped.
  float cliff = smoothstep(0.35, 0.6, slope + 0.1 * nMid.x) * (1.0 - kind.a);
  ground = mix(ground, rock, cliff);
  grad = mix(grad, rockGrad, cliff);
  // Snow lies on mountains only (lone hills stay bare), thins on steep
  // slopes, and is shaped by the rock below.
  float snow = smoothstep(${SNOW_LINE.toFixed(2)} - 1.2,
      ${SNOW_LINE.toFixed(2)} + 0.6, vHeight + 1.2 * nBig.x + 0.4 * nMid.x)
    * smoothstep(0.3, 0.7, kind.b)
    * (1.0 - smoothstep(0.35, 0.55, slope));
  vec3 snowColor = vec3(0.84, 0.88, 0.93)
    * (0.95 + 0.08 * nMid.x + 0.04 * nFine.x);
  ground = mix(ground, snowColor, snow);
  grad = mix(grad, 0.45 * rockGrad + 0.03 * nFine.yz, snow);
  rough = mix(rough, 0.55, snow);

  // Wet sand along the waterline.
  float wet = (1.0 - smoothstep(0.5, 0.64, landCov)) * octaveFade(2.0, px);
  ground *= 1.0 - 0.3 * wet;
  rough = mix(rough, 0.35, wet);

  // Seabed: the water colours with some grain, and caustics in the
  // shallows. Where the coarse mesh lifts seabed above sea level, shade it
  // as if the water plane covered it.
  vec3 bed = textureGrad(uWater, vMapUv, uvDx, uvDy).rgb
    * (1.0 + 0.12 * nMid.x + 0.1 * nFine.x);
  float depthTiles =
    textureGrad(uDepth, vMapUv, uvDx, uvDy).r * 255.0 / ${DEPTH_SCALE.toFixed(1)};
  bed += vec3(0.11, 0.14, 0.14) * caustics(tp, uTime, px)
    * (1.0 - smoothstep(0.5, 4.0, depthTiles));
  float exposed = smoothstep(-0.05, 0.05, vHeight);
  bed = mix(bed, uOceanColor, waterOpacity(depthTiles) * exposed);

  diffuseColor.rgb = mix(bed, ground, landMix);
  detailGrad = grad * landMix;
  detailRough = mix(0.6, rough, landMix);

  uvec2 s = tileAt(ivec2(floor(tp)));
  if ((s.y & 32u) != 0u) {
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.09, 0.13, 0.03), 0.6);
  }

  // Territory: the owner covering most of this point, weighing the 4x4
  // tiles around it with the coast's cubic, so borders curve the way
  // coastlines do and meet them exactly. Like the coast, it stays within a
  // quarter of the plain bilinear weight so single tiles still show.
  vec2 st = tp - 0.5;
  ivec2 t0 = ivec2(floor(st));
  vec2 f = st - floor(st);
  vec4 wx = bsplineWeights(f.x);
  vec4 wy = bsplineWeights(f.y);
  uint ids[16];
  for (int j = 0; j < 4; j++) {
    for (int i = 0; i < 4; i++) {
      ids[j * 4 + i] = tileAt(t0 + ivec2(i - 1, j - 1)).x;
    }
  }
  uint near[4] = uint[4](ids[5], ids[6], ids[9], ids[10]);
  vec4 bw = vec4(
    (1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y),
    (1.0 - f.x) * f.y, f.x * f.y);
  uint own = near[0];
  float cov = -1.0;
  for (int k = 0; k < 4; k++) {
    uint c = near[k];
    float spline = 0.0;
    for (int n = 0; n < 16; n++) {
      spline += ids[n] == c ? wx[n % 4] * wy[n / 4] : 0.0;
    }
    float bilinear = 0.0;
    for (int m = 0; m < 4; m++) bilinear += near[m] == c ? bw[m] : 0.0;
    float v = clamp(spline, bilinear - 0.25, bilinear + 0.25);
    if (v > cov) {
      cov = v;
      own = c;
    }
  }
  if (own != 0u) {
    vec4 fill = texelFetch(uPalette, ivec2(int(own), 0), 0);
    vec4 edge = texelFetch(uPalette, ivec2(int(own), 1), 0);
    float hl = float(own) == uHighlight ? 1.0 : 0.0;
    float a = clamp(uFillAlpha + hl * ${HIGHLIGHT_FILL_BOOST.toFixed(2)}, 0.0, 1.0);
    vec3 filled = mix(diffuseColor.rgb, pow(fill.rgb, vec3(2.2)), a);
    // Border band: at least a couple of pixels when zoomed out.
    float band = clamp(2.0 * px, 0.25, 0.45);
    float soft = max(fwidth(cov), 1e-3);
    float border = 1.0 - smoothstep(0.5 + band - soft, 0.5 + band + soft, cov);
    diffuseColor.rgb = mix(filled, pow(edge.rgb, vec3(2.2)), border);
    detailGrad *= 1.0 - border;
  }

  // Railroads: ballast, sleepers and two steel rails up close; a plain dark
  // line once a tile is only a few pixels across.
  ivec2 rt = ivec2(floor(tp));
  uint rail = uint(texelFetch(uRail, rt, 0).r * 255.0 + 0.5);
  if (rail != 0u && rail <= 6u) {
    float along;
    float d = railDistance(rail, tp - vec2(rt), along);
    float detail = 1.0 - smoothstep(0.1, 0.25, px);
    vec3 c = diffuseColor.rgb;
    float ballast = 1.0 - smoothstep(0.3 - px, 0.3 + px, d);
    c = mix(c, vec3(0.25, 0.23, 0.2), ballast * detail);
    float ties = step(fract(along * 4.0), 0.4)
      * (1.0 - smoothstep(0.24 - px, 0.24 + px, d));
    c = mix(c, vec3(0.07, 0.05, 0.04), ties * detail);
    float steel = 1.0 - smoothstep(0.025, 0.025 + px, abs(d - 0.13));
    c = mix(c, vec3(0.33, 0.35, 0.38), steel * detail);
    float line = 1.0 - smoothstep(0.2 - px, 0.2 + px, d);
    diffuseColor.rgb = mix(c, vec3(0.04), line * (1.0 - detail));
    detailGrad *= 1.0 - max(ballast * detail, line);
  }
}
`;
