/**
 * GLSL shared by the 3D map's terrain and water shaders. Everything works in
 * tile space (one unit per map tile), so detail sits at the same place on the
 * map at every zoom level.
 *
 * Octaves are faded out once their features get smaller than about two
 * pixels, so zoomed out the detail averages away instead of shimmering. The
 * caller passes `px`, the tiles one screen pixel covers (see tilesPerPixel).
 */
export const NOISE_GLSL = /* glsl */ `
uint pcgHash(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

uint cellHash(ivec2 c, uint seed) {
  return pcgHash(
    (uint(c.x) * 1597334677u) ^ (uint(c.y) * 3812015801u) ^ (seed * 2654435769u));
}

/** A fixed pseudo-random point in [0, 1)^2 for an integer cell. */
vec2 cellPoint(ivec2 c, uint seed) {
  uint h = cellHash(c, seed);
  return vec2(float(h & 65535u), float(h >> 16u)) / 65536.0;
}

/** Tiles covered by one screen pixel at tile point p. */
float tilesPerPixel(vec2 p) {
  return max(length(dFdx(p)), length(dFdy(p)));
}

/**
 * Gradient noise in about -0.7..0.7 with its derivatives:
 * (value, d/dx, d/dy).
 */
vec3 gradNoise(vec2 p, uint seed) {
  vec2 i = floor(p);
  vec2 f = p - i;
  ivec2 c = ivec2(i);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 ga = cellPoint(c, seed) * 2.0 - 1.0;
  vec2 gb = cellPoint(c + ivec2(1, 0), seed) * 2.0 - 1.0;
  vec2 gc = cellPoint(c + ivec2(0, 1), seed) * 2.0 - 1.0;
  vec2 gd = cellPoint(c + ivec2(1, 1), seed) * 2.0 - 1.0;
  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));
  float k = va - vb - vc + vd;
  float v = va + u.x * (vb - va) + u.y * (vc - va) + u.x * u.y * k;
  vec2 d = ga + u.x * (gb - ga) + u.y * (gc - ga)
    + u.x * u.y * (ga - gb - gc + gd)
    + du * (u.yx * k + vec2(vb, vc) - va);
  return vec3(v, d);
}

/** How much of an octave with this many cycles per tile is still visible. */
float octaveFade(float freq, float px) {
  return 1.0 - smoothstep(0.15, 0.45, freq * px);
}

// Each octave is turned a little so the noise grid never lines up.
const mat2 OCTAVE_TURN = mat2(0.8, 0.6, -0.6, 0.8);

/**
 * Fractal noise with derivatives: octaves from freq cycles per tile, each
 * twice as fine and half as strong as the last.
 */
vec3 fbm(vec2 p, float freq, int octaves, float px, uint seed) {
  vec3 sum = vec3(0.0);
  float amp = 0.5;
  mat2 turn = mat2(1.0);
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float fade = octaveFade(freq, px);
    if (fade <= 0.0) break;
    vec3 n = gradNoise(turn * p * freq, seed + uint(i) * 101u);
    sum += amp * fade * vec3(n.x, freq * (transpose(turn) * n.yz));
    amp *= 0.5;
    freq *= 2.0;
    turn = OCTAVE_TURN * turn;
  }
  return sum;
}

/**
 * Ridged fractal noise in about 0..1 with derivatives: sharp crests where
 * the noise crosses zero, for rock and crags.
 */
vec3 ridged(vec2 p, float freq, int octaves, float px, uint seed) {
  vec3 sum = vec3(0.0);
  float amp = 0.5;
  float norm = 0.0;
  mat2 turn = mat2(1.0);
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float fade = octaveFade(freq, px);
    vec3 n = gradNoise(turn * p * freq, seed + uint(i) * 131u);
    float s = n.x < 0.0 ? -1.0 : 1.0;
    float r = 1.0 - abs(n.x) * 1.4;
    // Faded octaves settle at their average instead of vanishing.
    sum.x += amp * mix(0.65, r * r, fade);
    sum.yz += amp * fade * (-2.8 * r * s) * freq * (transpose(turn) * n.yz);
    norm += amp;
    amp *= 0.5;
    freq *= 2.0;
    turn = OCTAVE_TURN * turn;
  }
  return sum / norm;
}

/**
 * Round bumps scattered one per cell (trees, shrubs, pebbles): 1 at a
 * bump's centre falling to 0 at its rim, with derivatives. density is the
 * chance a cell has a bump.
 */
vec3 bumps(vec2 p, float freq, float radius, float density, uint seed) {
  vec2 q = p * freq;
  ivec2 c = ivec2(floor(q));
  vec3 best = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      ivec2 cc = c + ivec2(x, y);
      uint h = cellHash(cc, seed + 7u);
      if (float(h & 1023u) / 1024.0 >= density) continue;
      vec2 o = vec2(cc) + 0.15 + 0.7 * cellPoint(cc, seed);
      vec2 d = q - o;
      float r = radius * (0.7 + 0.6 * float((h >> 10u) & 255u) / 255.0);
      float t = 1.0 - dot(d, d) / (r * r);
      if (t <= best.x) continue;
      best = vec3(t, (-2.0 / (r * r)) * d * freq);
    }
  }
  return best.x > 0.0 ? best : vec3(0.0);
}
`;

/**
 * The land mask (one texel per tile, 1 on land) read with a cubic B-spline,
 * which turns staircase coastlines into smooth curves. The B-spline alone
 * would melt one-tile islands and lakes away, so it stays within a quarter of
 * the plain bilinear reading. gx and gy are the uv derivatives, so mipmaps
 * are picked the same way as for the uv itself.
 */
export const SMOOTH_MASK_GLSL = /* glsl */ `
float smoothMask(sampler2D tex, vec2 tp, vec2 size, vec2 gx, vec2 gy) {
  vec2 st = tp - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / size;
  vec2 h1 = (i + 1.5 + w3 / g1) / size;
  float s =
    g0.y * (g0.x * textureGrad(tex, h0, gx, gy).r
      + g1.x * textureGrad(tex, vec2(h1.x, h0.y), gx, gy).r)
    + g1.y * (g0.x * textureGrad(tex, vec2(h0.x, h1.y), gx, gy).r
      + g1.x * textureGrad(tex, h1, gx, gy).r);
  float b = textureGrad(tex, tp / size, gx, gy).r;
  return clamp(s, b - 0.25, b + 0.25);
}
`;

/**
 * How the sea surface looks over a given depth (tiles from land): clear in
 * the shallows, close to opaque out at sea. Both the water plane and seabed
 * the terrain mesh lifts above sea level use it.
 */
export const WATER_GLSL = /* glsl */ `
float waterOpacity(float depthTiles) {
  return mix(0.38, 0.88, smoothstep(0.5, 9.0, depthTiles));
}
`;
