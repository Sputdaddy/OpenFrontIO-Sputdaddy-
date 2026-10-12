/**
 * The 3D map's sea surface: a translucent plane at sea level with drifting
 * waves that catch the sun, clear shallows that darken out to sea, and surf
 * along the coast. It is invisible on the land side of the drawn coastline,
 * so low-lying coast never ends up under a film of water.
 */

import * as THREE from "three";
import { DEPTH_SCALE } from "./CoastTextures";
import { NOISE_GLSL, SMOOTH_MASK_GLSL, WATER_GLSL } from "./ShaderLib";

export interface WaterTextures {
  /** Land mask, one byte per tile. */
  readonly landMask: THREE.Texture;
  /** Water depth per tile (see CoastTextures.depth). */
  readonly depth: THREE.Texture;
}

export function createWaterMaterial(
  color: THREE.Color,
  textures: WaterTextures,
  mapW: number,
  mapH: number,
  time: { value: number },
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.16,
    metalness: 0.05,
    transparent: true,
    depthWrite: false,
  });
  const uniforms = {
    uLand: { value: textures.landMask },
    uDepth: { value: textures.depth },
    uMapSize: { value: new THREE.Vector2(mapW, mapH) },
    uTime: time,
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec2 vTile;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vTile = (modelMatrix * vec4(transformed, 1.0)).xz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAGMENT_COMMON}`)
      .replace("#include <map_fragment>", MAP_FRAGMENT)
      .replace(
        "#include <roughnessmap_fragment>",
        "float roughnessFactor = waveRough;",
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        normal = normalize(normal
          + (viewMatrix * vec4(-waveGrad.x, 0.0, -waveGrad.y, 0.0)).xyz);`,
      );
  };
  return material;
}

const FRAGMENT_COMMON = /* glsl */ `
varying vec2 vTile;
uniform sampler2D uLand;
uniform sampler2D uDepth;
uniform vec2 uMapSize;
uniform float uTime;
${NOISE_GLSL}
${SMOOTH_MASK_GLSL}
${WATER_GLSL}
`;

const MAP_FRAGMENT = /* glsl */ `
vec2 waveGrad = vec2(0.0);
float waveRough = roughness;
{
  vec2 tp = vTile;
  float px = tilesPerPixel(tp);
  vec2 uv = tp / uMapSize;
  vec2 gx = dFdx(uv);
  vec2 gy = dFdy(uv);
  float landCov = smoothMask(uLand, tp, uMapSize, gx, gy);
  float depthTiles =
    textureGrad(uDepth, uv, gx, gy).r * 255.0 / ${DEPTH_SCALE.toFixed(1)};
  float t = uTime;

  // Two wave patterns drifting different ways; calmer in the shallows.
  vec3 swell = fbm(tp + t * vec2(0.5, 0.2), 0.22, 5, px, 61u);
  vec3 chop = fbm(tp + t * vec2(-0.35, 0.45), 0.7, 4, px, 62u);
  float calm = mix(0.45, 1.0, smoothstep(0.5, 4.0, depthTiles));
  waveGrad = (0.3 * swell.yz + 0.18 * chop.yz) * calm;

  // Surf: bands of foam rolling in toward the coast, broken up by noise,
  // and a thin line of foam right at the waterline.
  float shore = smoothstep(0.12, 0.46, landCov);
  float bands = 0.5 + 0.5 * sin(landCov * 20.0 - t * 1.3 + swell.x * 5.0);
  float breakup = fbm(tp + t * vec2(0.12, -0.08), 1.5, 3, px, 63u).x;
  float foam = shore * smoothstep(0.6, 0.95, bands + breakup * 0.8 + shore * 0.25);
  foam = max(foam, smoothstep(0.36, 0.47, landCov));
  foam *= octaveFade(0.6, px) * 0.85;

  // Lighter over the shallows, deeper blue out at sea.
  vec3 sea = diffuseColor.rgb
    * mix(vec3(1.05, 1.18, 1.12), vec3(0.78, 0.84, 0.92),
      smoothstep(1.0, 12.0, depthTiles));
  diffuseColor.rgb = mix(sea, vec3(0.92, 0.95, 0.97), foam);

  // Nothing on the land side of the coastline.
  float aa = max(fwidth(landCov), 1e-3);
  float water = 1.0 - smoothstep(0.5 - aa, 0.5 + aa, landCov);
  diffuseColor.a = water * mix(waterOpacity(depthTiles), 0.95, foam);
  waveGrad *= 1.0 - foam;
  waveRough = mix(roughness, 0.85, foam);
}
`;
