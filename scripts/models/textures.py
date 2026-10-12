"""Tileable surface textures for the models, generated from code.

Each texture set is a colour image and a normal map, SIZE pixels square,
that repeat seamlessly (every noise is made in the frequency domain, so it
wraps around). The colour image is a neutral detail layer: the model's
material multiplies it by its palette colour, so one "metal" set serves grey
steel, red hull paint and olive drab alike, and the owner tint still works
on Team* materials. kit.SURFACES says which material uses which set and how
big one repeat is on the model.

Run on its own to regenerate the images (build_models.py does it when they
are missing):

    python scripts/models/textures.py --out resources/models/textures
"""

import argparse
import math
import os

import numpy as np

SIZE = 1024


def srgb(linear):
    linear = np.clip(linear, 0.0, 1.0)
    return np.where(linear <= 0.0031308, linear * 12.92,
                    1.055 * np.power(linear, 1 / 2.4) - 0.055)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


class Gen:
    """Noise and pattern helpers for one SIZE x SIZE texture. Every result
    tiles: patterns repeat a whole number of times across the image."""

    def __init__(self, seed, n=SIZE):
        self.n = n
        self.rng = np.random.default_rng(seed)
        f = np.fft.fftfreq(n)
        self.fx = f[None, :]
        self.fy = f[:, None]
        yy, xx = np.mgrid[0:n, 0:n]
        self.x = xx + 0.5
        self.y = yy + 0.5

    def noise(self, small, large, stretch=1.0, beta=1.0):
        """Noise with features from small to large pixels across, mean 0 and
        standard deviation 1. stretch > 1 makes the features that many times
        taller than wide (streaks running down a wall)."""
        f = np.sqrt(self.fx ** 2 + (self.fy * stretch) ** 2)
        f[0, 0] = 1.0
        filt = f ** -beta
        filt *= np.exp(-((f * small) ** 2))
        filt *= 1.0 - np.exp(-((f * large) ** 2))
        filt[0, 0] = 0.0
        white = self.rng.standard_normal((self.n, self.n))
        out = np.real(np.fft.ifft2(np.fft.fft2(white) * filt))
        return (out - out.mean()) / (out.std() + 1e-9)

    def blur(self, a, sigma):
        f2 = self.fx ** 2 + self.fy ** 2
        filt = np.exp(-2 * math.pi ** 2 * sigma ** 2 * f2)
        return np.real(np.fft.ifft2(np.fft.fft2(a) * filt))

    def lines(self, coord, period, half_width, offset=0.0):
        """1 on lines every period pixels along coord, fading to 0 over
        half_width pixels either side."""
        d = np.abs(((coord - offset) % period) - period / 2)
        d = period / 2 - d  # distance to the nearest line
        return np.clip(1.0 - d / half_width, 0.0, 1.0)

    def cells(self, cw, ch, offsets=None):
        """Per-cell index of a grid of cw x ch cells, rows optionally
        shifted by offsets[row] pixels. Returns (cell id, distance to the
        nearest cell edge)."""
        n = self.n
        rows = n // ch
        cols = n // cw
        row = (self.y // ch).astype(int) % rows
        shift = 0.0 if offsets is None else np.asarray(offsets)[row]
        x = (self.x + shift) % n
        col = (x // cw).astype(int) % cols
        ex = np.minimum(x % cw, cw - x % cw)
        ey = np.minimum(self.y % ch, ch - self.y % ch)
        return row * cols + col, np.minimum(ex, ey)

    def per_cell(self, ids, spread):
        """A random value (mean 0) per cell."""
        return self.rng.normal(0.0, spread, ids.max() + 1)[ids]

    def splat(self, xs, ys, weights=None):
        """Adds points (fractional pixels, wrapping) bilinearly."""
        n = self.n
        acc = np.zeros((n, n))
        xs = np.asarray(xs) - 0.5
        ys = np.asarray(ys) - 0.5
        w = np.ones_like(xs) if weights is None else np.asarray(weights)
        x0 = np.floor(xs).astype(int)
        y0 = np.floor(ys).astype(int)
        fx = xs - x0
        fy = ys - y0
        for dx, dy, k in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)),
                          (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
            np.add.at(acc, ((y0 + dy) % n, (x0 + dx) % n), w * k)
        return acc

    def walks(self, count, length, wiggle=0.25, step=0.5, taper=True):
        """Thin random lines (cracks, scratches): 0..1 coverage."""
        xs, ys, ws = [], [], []
        for _ in range(count):
            x, y = self.rng.uniform(0, self.n, 2)
            a = self.rng.uniform(0, 2 * math.pi)
            steps = int(self.rng.uniform(0.5, 1.0) * length / step)
            for i in range(steps):
                a += self.rng.normal(0, wiggle)
                x += math.cos(a) * step
                y += math.sin(a) * step
                xs.append(x)
                ys.append(y)
                t = i / max(steps - 1, 1)
                ws.append(math.sin(math.pi * t) ** 0.5 if taper else 1.0)
        acc = self.blur(self.splat(xs, ys, ws), 0.5)
        return np.clip(acc * 1.6, 0.0, 1.0)

    def dots(self, count, radius, jitter=0.0):
        """Round spots of about radius pixels at random places: 0..1."""
        xs = self.rng.uniform(0, self.n, count)
        ys = self.rng.uniform(0, self.n, count)
        acc = self.blur(self.splat(xs, ys), radius)
        peak = 1.0 / (2 * math.pi * radius ** 2)
        return np.clip(acc / peak, 0.0, 1.0)


def normal_map(height, strength):
    """Tangent-space normal map (OpenGL / glTF: green points up the
    image) from a height field in pixels."""
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / 2
    drow = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / 2
    nx = -dx * strength
    ny = drow * strength  # rows run down the image, v runs up it
    nz = np.ones_like(height)
    length = np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    return np.stack([nx, ny, nz], -1) / length[..., None] * 0.5 + 0.5


def finish(value, mean, tint=None):
    """Linear colour multiplier with the given mean brightness, so a
    palette colour divided by mean comes out at its own shade on average.
    tint (n, n, 3) adds colour shifts (rust, dry grass)."""
    rgb = np.repeat(value[..., None], 3, -1)
    if tint is not None:
        rgb = rgb * tint
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722])
    return np.clip(rgb * (mean / lum.mean()), 0.0, 1.0)


def tint_toward(amount, rgb):
    """(n, n, 3) tint: 1 where amount is 0, the rgb colour where it is 1."""
    rgb = np.asarray(rgb, float)
    return 1.0 + amount[..., None] * (rgb - 1.0)


# ---------------------------------------------------------------------------
# The sets. Each returns (brightness, colour tint or None, height in
# pixels). Feature sizes are in pixels; kit.SURFACES sets how much of the
# model one image covers.


def concrete(g):
    ids, edge = g.cells(64, 64)
    v = 1.0 + g.per_cell(ids, 0.08)
    v *= 1.0 + 0.07 * g.noise(24, 400)
    v *= 1.0 + 0.035 * g.noise(1, 6)
    joints = np.clip(1.2 - edge / 0.9, 0.0, 1.0)
    v *= 1.0 - 0.3 * joints
    stains = smoothstep(0.9, 2.2, g.noise(30, 300, beta=1.2))
    v *= 1.0 - 0.18 * stains
    cracks = g.walks(14, 200, wiggle=0.12)
    v *= 1.0 - 0.35 * cracks
    pits = g.dots(2600, 0.7)
    v *= 1.0 - 0.18 * pits
    h = -1.2 * joints - 0.8 * cracks - 0.5 * pits + 0.25 * g.noise(1, 5)
    tint = tint_toward(stains * 0.5, (1.02, 0.98, 0.92))
    return v, tint, h


def asphalt(g):
    v = 1.0 + 0.09 * g.noise(0.5, 3, beta=0.3)
    v *= 1.0 + 0.06 * g.noise(30, 500)
    stones = g.dots(9000, 0.6)
    v *= 1.0 + 0.16 * stones
    # Repair patches: darker rectangles with a sealed seam.
    patch = np.zeros((g.n, g.n))
    for _ in range(9):
        x0, y0 = g.rng.uniform(0, g.n, 2)
        w, hgt = g.rng.uniform(60, 220, 2)
        dx = (g.x - x0) % g.n
        dy = (g.y - y0) % g.n
        inside = (dx < w) & (dy < hgt)
        patch = np.maximum(patch, inside * g.rng.uniform(0.6, 1.0))
    patch = g.blur(patch, 0.8)
    seam = np.clip(np.abs(g.blur(patch, 1.2) - patch) * 6, 0, 1)
    v *= 1.0 - 0.12 * patch
    v *= 1.0 - 0.25 * seam
    cracks = g.walks(18, 260, wiggle=0.15)
    v *= 1.0 - 0.45 * cracks
    oil = smoothstep(1.4, 2.6, g.noise(8, 60, beta=1.5))
    v *= 1.0 - 0.18 * oil
    h = 0.7 * g.noise(0.5, 3, beta=0.3) + 0.6 * stones - 1.0 * cracks
    return v, None, h


def paving(g):
    ids, edge = g.cells(32, 32, offsets=[(r % 2) * 16 for r in range(32)])
    v = 1.0 + g.per_cell(ids, 0.05)
    v *= 1.0 + 0.04 * g.noise(1, 5)
    v *= 1.0 + 0.05 * g.noise(40, 400)
    grout = np.clip(1.2 - edge / 0.8, 0, 1)
    v *= 1.0 - 0.25 * grout
    stains = smoothstep(1.0, 2.4, g.noise(10, 120, beta=1.3))
    v *= 1.0 - 0.15 * stains
    h = -1.0 * grout + 0.2 * g.noise(1, 4)
    return v, None, h


def facade(g):
    """Precast concrete or rendered wall: faint panel joints and rain
    streaks running down."""
    ids, edge = g.cells(128, 128)
    v = 1.0 + g.per_cell(ids, 0.05)
    v *= 1.0 + 0.06 * g.noise(20, 300)
    v *= 1.0 + 0.03 * g.noise(1, 4)
    joints = np.clip(1.2 - edge / 0.8, 0, 1)
    v *= 1.0 - 0.2 * joints
    streaks = smoothstep(0.3, 1.8, g.noise(3, 120, stretch=12, beta=0.8))
    v *= 1.0 - 0.2 * streaks
    h = -0.8 * joints + 0.15 * g.noise(1, 4)
    return v, tint_toward(streaks, (0.98, 0.98, 1.0)), h


def window(g):
    """Ribbon windows: dark panes split by light mullions, each pane
    reflecting a little differently."""
    ids = (g.x // 32).astype(int)
    pane = 0.12 + g.per_cell(ids, 0.035)
    v = np.clip(pane + 0.01 * g.noise(10, 200), 0.04, 0.3)
    mullion = g.lines(g.x, 32, 2.0)
    v = v * (1 - mullion) + 1.0 * mullion
    h = 1.0 * mullion
    return v, tint_toward(1 - mullion, (0.96, 0.99, 1.04)), h


def glass(g):
    """Curtain wall: a grid of glass panes in thin frames. Each pane tilts
    a hair, so the reflections break up pane by pane."""
    ids, edge = g.cells(32, 64)
    v = 0.55 + g.per_cell(ids, 0.1)
    v += 0.1 * (1.0 - (g.y % 64) / 64)  # sky reflection, top of each pane
    v *= 1.0 + 0.02 * g.noise(30, 300)
    frame = np.clip(1.8 - edge / 0.8, 0, 1)
    v = v * (1 - frame) + 1.0 * frame
    tilt_x = g.per_cell(ids, 0.06)
    tilt_y = g.per_cell(ids, 0.06)
    # A tilted pane is a height ramp across it.
    h = tilt_x * (g.x % 32) + tilt_y * (g.y % 64) + 1.2 * frame
    return v, None, h


def metal(g):
    """Painted steel plating: welded plates in staggered rows, a little
    oil-canning per plate, grime and rust streaks running down."""
    offsets = g.rng.integers(0, 8, g.n // 64) * 32
    ids, edge = g.cells(256, 64, offsets=offsets)
    v = 1.0 + g.per_cell(ids, 0.06)
    v *= 1.0 + 0.05 * g.noise(16, 300)
    v *= 1.0 + 0.025 * g.noise(0.5, 3)
    seam = np.clip(1.3 - edge / 0.8, 0, 1)
    bead = np.clip(1.0 - np.abs(edge - 2.0) / 1.2, 0, 1)
    v *= 1.0 - 0.28 * seam
    grime = smoothstep(0.6, 2.2, g.noise(2, 160, stretch=16, beta=0.9))
    rust = smoothstep(1.6, 2.6, g.noise(1.5, 100, stretch=10, beta=0.9))
    v *= 1.0 - 0.15 * grime - 0.15 * rust
    chips = g.dots(1400, 0.6)
    v *= 1.0 - 0.15 * chips
    dent = g.noise(40, 200) * 1.2
    h = dent - 1.0 * seam + 0.5 * bead + 0.12 * g.noise(0.5, 3)
    tint = tint_toward(rust, (1.12, 0.92, 0.75)) * tint_toward(grime * 0.4,
                                                               (1.0, 0.98, 0.94))
    return v, tint, h


def deck(g):
    """Non-skid deck coating: gritty surface, panel lines, tie-down
    points and scuffed walkways. Grey only, the owner tint colours it."""
    ids, edge = g.cells(128, 128)
    v = 1.0 + g.per_cell(ids, 0.08)
    grit = g.noise(0.5, 2.5, beta=0.2)
    v *= 1.0 + 0.06 * grit
    v *= 1.0 + 0.04 * g.noise(20, 300)
    lines = np.clip(1.2 - edge / 0.8, 0, 1)
    v *= 1.0 - 0.4 * lines
    scuff = smoothstep(0.8, 2.2, g.noise(10, 200, beta=1.2))
    v *= 1.0 - 0.15 * scuff
    tie = np.clip(1.0 - np.hypot((g.x % 64) - 32, (g.y % 64) - 32) / 2.5, 0, 1)
    v *= 1.0 - 0.35 * tie
    h = 0.6 * grit - 0.9 * lines - 0.8 * tie
    return v, None, h


def paint(g):
    """Painted surface: slight mottling, faint streaks and scratches."""
    v = 1.0 + 0.07 * g.noise(16, 300)
    v *= 1.0 + 0.02 * g.noise(0.5, 3)
    streaks = smoothstep(0.8, 2.4, g.noise(2, 160, stretch=14, beta=0.9))
    v *= 1.0 - 0.06 * streaks
    scratches = g.walks(40, 40, wiggle=0.05)
    v *= 1.0 - 0.1 * scratches
    h = 0.4 * g.noise(1, 6) - 0.4 * scratches
    return v, None, h


def roof(g):
    """Flat roof membrane: lapped strips, ponding stains, patches and
    gravel. Grey only, the owner tint colours it."""
    ids, edge = g.cells(1024, 64)
    v = 1.0 + g.per_cell(ids, 0.07)
    v *= 1.0 + 0.08 * g.noise(20, 300)
    grit = g.noise(0.5, 2, beta=0.2)
    v *= 1.0 + 0.05 * grit
    lap = np.clip(1.0 - np.abs((g.y % 64) - 2.0) / 1.5, 0, 1)
    v *= 1.0 + 0.08 * lap
    seam = np.clip(1.2 - edge / 0.8, 0, 1)
    v *= 1.0 - 0.2 * seam
    ponding = smoothstep(0.7, 2.2, g.noise(20, 250, beta=1.3))
    v *= 1.0 - 0.25 * ponding
    patch = np.zeros((g.n, g.n))
    for _ in range(10):
        x0, y0 = g.rng.uniform(0, g.n, 2)
        w, hgt = g.rng.uniform(40, 140, 2)
        patch = np.maximum(patch, ((g.x - x0) % g.n < w) & ((g.y - y0) % g.n < hgt))
    patch = g.blur(patch.astype(float), 0.8)
    v *= 1.0 - 0.14 * patch
    h = 0.5 * grit + 0.8 * lap - 0.8 * seam + 0.6 * patch
    return v, None, h


def corrugated(g):
    """Corrugated sheet (warehouse cladding, shipping containers): vertical
    ridges, rain streaks, a few rust spots."""
    phase = (g.x % 16) / 16
    ridge = 0.5 - 0.5 * np.cos(2 * math.pi * phase)
    joints = g.lines(g.y, 256, 1.0)
    v = 0.93 + 0.07 * ridge
    v *= 1.0 + 0.03 * g.noise(20, 300)
    streaks = smoothstep(0.5, 2.0, g.noise(2, 160, stretch=16, beta=0.9))
    rust = smoothstep(1.5, 2.6, g.noise(3, 60, beta=1.3))
    v *= 1.0 - 0.12 * streaks - 0.15 * rust - 0.15 * joints
    h = 3.0 * ridge - 1.0 * joints
    tint = tint_toward(rust, (1.15, 0.9, 0.72))
    return v, tint, h


def grass(g):
    v = 1.0 + 0.10 * g.noise(30, 400)
    blades = g.noise(0.5, 2.5, beta=0.2)
    v *= 1.0 + 0.08 * blades
    clumps = g.noise(4, 30)
    v *= 1.0 + 0.06 * clumps
    dry = smoothstep(0.3, 1.8, g.noise(40, 300))
    h = 0.6 * blades + 0.8 * clumps
    return v, tint_toward(dry * 0.6, (1.25, 1.08, 0.7)), h


def foliage(g):
    """Leafy crowns: clumps of leaves with dark gaps between them."""
    clumps = g.noise(5, 40, beta=1.2)
    leaves = g.noise(0.7, 4, beta=0.4)
    v = 1.0 + 0.18 * clumps + 0.1 * leaves
    v *= 1.0 - 0.3 * smoothstep(-0.6, -1.8, clumps)
    lit = smoothstep(0.5, 1.8, clumps)
    h = 3.0 * clumps + 0.8 * leaves
    return v, tint_toward(lit * 0.5, (1.12, 1.1, 0.8)), h


def ground(g):
    """Sand, gravel and dirt: grains and pebbles."""
    v = 1.0 + 0.08 * g.noise(0.5, 2, beta=0.2)
    v *= 1.0 + 0.07 * g.noise(20, 300)
    pebbles = g.dots(4000, 1.6)
    dark = g.dots(3000, 1.0)
    v *= 1.0 + 0.12 * pebbles - 0.18 * dark
    h = 2.0 * pebbles - 0.6 * dark + 0.4 * g.noise(0.5, 3)
    return v, None, h


# name: (builder, normal map strength, mean brightness). The mean is what
# the material divides its palette colour by, so it keeps its shade; dark
# glass sets a low one to leave room for bright frames.
SETS = {
    "concrete": (concrete, 0.6, 0.88),
    "asphalt": (asphalt, 0.5, 0.85),
    "paving": (paving, 0.6, 0.88),
    "facade": (facade, 0.5, 0.9),
    "window": (window, 0.6, 0.25),
    "glass": (glass, 1.0, 0.62),
    "metal": (metal, 0.35, 0.9),
    "deck": (deck, 0.6, 0.88),
    "paint": (paint, 0.3, 0.93),
    "roof": (roof, 0.5, 0.9),
    "corrugated": (corrugated, 0.9, 0.85),
    "grass": (grass, 0.6, 0.85),
    "foliage": (foliage, 0.5, 0.78),
    "ground": (ground, 0.6, 0.85),
}


def generate(name, seed=None):
    """(colour sRGB, normal) float arrays, rows top to bottom."""
    build, strength, mean = SETS[name]
    g = Gen(seed if seed is not None else sum(map(ord, name)))
    value, tint, height = build(g)
    return srgb(finish(value, mean, tint)), normal_map(height, strength)


def color_path(out_dir, name):
    return os.path.join(out_dir, f"{name}_color.jpg")


def normal_path(out_dir, name):
    return os.path.join(out_dir, f"{name}_normal.jpg")


def save_jpeg(path, rgb, quality=90):
    """Saves (n, n, 3) values in 0..1 (rows top to bottom) through Blender,
    so the build needs nothing beyond bpy."""
    import bpy

    n = rgb.shape[0]
    img = bpy.data.images.new(os.path.basename(path), n, n, alpha=False)
    px = np.ones((n, n, 4), np.float32)
    px[..., :3] = rgb[::-1]  # Blender stores rows bottom to top
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = path
    img.file_format = "JPEG"
    img.save(filepath=path, quality=quality)
    bpy.data.images.remove(img)


def write_all(out_dir, names=None):
    os.makedirs(out_dir, exist_ok=True)
    for name in names or SETS:
        color, normal = generate(name)
        save_jpeg(color_path(out_dir, name), color)
        save_jpeg(normal_path(out_dir, name), normal, quality=95)
        print(f"texture {name} -> {out_dir}")


def missing(out_dir):
    return [n for n in SETS
            if not (os.path.exists(color_path(out_dir, n))
                    and os.path.exists(normal_path(out_dir, n)))]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    parser.add_argument("--only", nargs="*")
    args = parser.parse_args()
    write_all(args.out, args.only)
