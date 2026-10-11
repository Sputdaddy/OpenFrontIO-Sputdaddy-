"""Ships: warship, transport and trade ship. Each is 1 long, its bow toward
-Y and its waterline at z = 0."""

import math
import random

from kit import Model, Vector, rot_x, rot_y, rot_z, translate
from vehicles import (CONTAINER_HEIGHT, CONTAINER_PAINTS, CONTAINER_WIDTH, apc,
                      container, military_truck, tank)


def frustum_band(m, x, y, z0, z1, sx0, sy0, sx1, sy1, dy1, za, zb, grow,
                 material):
    """A band hugging the sides of a frustum between heights za and zb."""
    def at(z):
        f = (z - z0) / (z1 - z0)
        return sx0 + (sx1 - sx0) * f, sy0 + (sy1 - sy0) * f, dy1 * f
    ax, ay, ady = at(za)
    bx, by, bdy = at(zb)
    m.frustum(x, y + ady, za, zb, ax + grow, ay + grow, bx + grow, by + grow,
              material, dy1=bdy - ady)


def ciws(m, x, y, z, facing):
    """Close-in weapon system: pedestal, white radome, gun barrel."""
    m.cylinder(x, y, z, z + 0.006, 0.013, "MetalDark", segments=12)
    m.cylinder(x, y, z + 0.006, z + 0.02, 0.0095, "Missile", segments=12)
    m.sphere(x, y, z + 0.025, 0.01, "Missile", subdivisions=2, sz=1.25)
    m.rod((x, y + facing * 0.006, z + 0.014), (x, y + facing * 0.032, z + 0.015),
          0.002, "MetalDark", 6)


def helicopter(m, x, y, z):
    for side in (-1, 1):
        m.rod((x + side * 0.012, y - 0.022, z + 0.003),
              (x + side * 0.012, y + 0.026, z + 0.003), 0.0016, "MetalDark", 6)
        for dy in (-0.01, 0.012):
            m.beam((x + side * 0.012, y + dy, z + 0.003),
                   (x + side * 0.006, y + dy, z + 0.013), 0.0015, "MetalDark")
    m.sphere(x, y, z + 0.022, 0.015, "MetalLight", subdivisions=2, sy=1.5,
             sz=0.9)
    m.sphere(x, y - 0.012, z + 0.026, 0.0105, "Window", subdivisions=2,
             sy=1.25, sz=0.85)
    m.rod((x, y + 0.018, z + 0.026), (x, y + 0.078, z + 0.031), 0.0045,
          "MetalLight", 8, r2=0.0022)
    m.box(x, y + 0.076, z + 0.029, 0.002, 0.012, 0.016, "TeamColor")
    m.cylinder(x, y, z + 0.036, z + 0.041, 0.003, "MetalDark", segments=8)
    for a in (25, 115):
        m.oriented_box(translate(x, y, z + 0.0425) @ rot_z(a), 0.1, 0.0045,
                       0.0012, "MetalDark")


def build_warship():
    """A modern destroyer: stealth-shaped superstructure with an integrated
    radar mast, a bow gun, missile cells, anti-ship missiles, boats, a
    hangar and a helicopter on the flight deck."""
    m = Model("Warship")
    # Hull outline from the bow (-Y) round the starboard side to the
    # transom and back up the port side (counter-clockwise from above).
    starboard = [
        (0.0, -0.5), (0.03, -0.44), (0.058, -0.35), (0.078, -0.24),
        (0.088, -0.12), (0.09, 0.0), (0.09, 0.3), (0.087, 0.42), (0.082, 0.5),
    ]
    outline = starboard + [(-x, y) for x, y in reversed(starboard) if x != 0.0]

    def deck(y):
        # Deck height, rising toward the bow.
        return 0.06 + 0.018 * max(0.0, (-y - 0.1) / 0.4)

    def ring(sx, bow, stern, z):
        return [(x * sx, y * (bow if y < 0 else stern), z(y)) for x, y in outline]

    m.loft(
        [
            ring(0.42, 0.88, 0.96, lambda y: -0.045),
            ring(0.9, 0.98, 0.995, lambda y: 0.0),
            ring(0.92, 0.985, 1.0, lambda y: 0.008),
            ring(0.99, 1.0, 1.0, lambda y: 0.03 + 0.5 * (deck(y) - 0.06)),
            ring(1.0, 1.0, 1.0, deck),
        ],
        ["MetalDark", "Dark", "TeamColor", "TeamColor"],
        "TeamDeck",
        "MetalDark",
    )

    # Guard rails along both sides.
    rail = [(x - 0.004, y) for x, y in starboard[1:]]
    for side in (-1, 1):
        for (x0, y0), (x1, y1) in zip(rail, rail[1:]):
            steps = max(1, round(math.hypot(x1 - x0, y1 - y0) / 0.035))
            for i in range(steps + 1):
                t = i / steps
                px, py = side * (x0 + (x1 - x0) * t), y0 + (y1 - y0) * t
                m.rod((px, py, deck(py)), (px, py, deck(py) + 0.012), 0.0012,
                      "MetalLight", 4)
            for h in (0.006, 0.012):
                m.beam((side * x0, y0, deck(y0) + h), (side * x1, y1, deck(y1) + h),
                       0.0014, "MetalLight")

    # Foredeck: jackstaff, bollards, the gun and the missile cells.
    m.rod((0, -0.485, deck(-0.485)), (0, -0.485, deck(-0.485) + 0.05), 0.0015,
          "MetalDark", 6)
    for bx in (-0.018, 0.018):
        m.cylinder(bx, -0.41, deck(-0.41), deck(-0.41) + 0.008, 0.006,
                   "MetalDark", segments=8)
    gz = deck(-0.31)
    m.cylinder(0, -0.31, gz, gz + 0.008, 0.032, "MetalDark", segments=16)
    m.frustum(0, -0.31, gz + 0.008, gz + 0.04, 0.06, 0.07, 0.036, 0.04,
              "MetalLight", dy1=0.01, bevel=0.003)
    m.rod((0, -0.33, gz + 0.022), (0, -0.43, gz + 0.026), 0.0045, "MetalDark", 8)
    m.rod((0, -0.424, gz + 0.0258), (0, -0.437, gz + 0.0263), 0.0058,
          "MetalDark", 8)
    vz = deck(-0.215)
    m.box(0, -0.215, vz, 0.075, 0.07, 0.005, "MetalDark")
    for i in range(4):
        for j in range(4):
            m.box(-0.0255 + i * 0.017, -0.2405 + j * 0.017, vz + 0.005, 0.014,
                  0.014, 0.0015, "MetalLight")

    # Deckhouse, bridge and the integrated mast with radar panels.
    m.frustum(0, 0.01, 0.06, 0.118, 0.13, 0.36, 0.112, 0.33, "MetalLight",
              dy1=0.006, bevel=0.003)
    bridge = (0, -0.065, 0.118, 0.162, 0.108, 0.1, 0.088, 0.078, 0.007)
    bx, by, bz0, bz1, bsx0, bsy0, bsx1, bsy1, bdy = bridge
    m.frustum(bx, by, bz0, bz1, bsx0, bsy0, bsx1, bsy1, "MetalLight", dy1=bdy,
              bevel=0.002)
    frustum_band(m, bx, by, bz0, bz1, bsx0, bsy0, bsx1, bsy1, bdy, 0.137,
                 0.149, 0.003, "Window")
    for side in (-1, 1):
        m.box(side * 0.058, -0.095, 0.142, 0.02, 0.026, 0.005, "MetalLight")
    ciws(m, 0, -0.132, 0.118, -1)

    my = by + bdy
    m.frustum(0, my, 0.162, 0.27, 0.07, 0.066, 0.036, 0.034, "MetalLight",
              bevel=0.002)
    pz, hx, hy = 0.205, 0.0282, 0.0266
    for matrix, sx, sy in (
        (translate(0, my - hy - 0.0015, pz) @ rot_x(-8.4), 0.034, 0.003),
        (translate(0, my + hy + 0.0015, pz) @ rot_x(8.4), 0.034, 0.003),
        (translate(hx + 0.0015, my, pz) @ rot_y(-8.9), 0.003, 0.034),
        (translate(-hx - 0.0015, my, pz) @ rot_y(8.9), 0.003, 0.034),
    ):
        m.oriented_box(matrix, sx, sy, 0.04, "Dark")
    m.box(0, my, 0.27, 0.05, 0.048, 0.004, "MetalDark")
    m.rod((0, my, 0.274), (0, my, 0.36), 0.0035, "MetalDark", 6)
    m.beam((-0.035, my, 0.33), (0.035, my, 0.33), 0.003, "MetalDark")
    m.box(0, my, 0.297, 0.05, 0.008, 0.006, "MetalDark")
    m.sphere(0, my, 0.366, 0.009, "Missile", subdivisions=2)
    m.box(0.03, my, 0.316, 0.002, 0.016, 0.011, "TeamColor")

    # Funnel with a team-colour band and twin exhausts.
    funnel = (0, 0.075, 0.118, 0.2, 0.062, 0.056, 0.046, 0.04, 0.006)
    fx, fy, fz0, fz1, fsx0, fsy0, fsx1, fsy1, fdy = funnel
    m.frustum(fx, fy, fz0, fz1, fsx0, fsy0, fsx1, fsy1, "MetalLight", dy1=fdy,
              bevel=0.002)
    frustum_band(m, fx, fy, fz0, fz1, fsx0, fsy0, fsx1, fsy1, fdy, 0.172,
                 0.188, 0.002, "TeamColor")
    m.frustum(fx, fy + fdy, fz1, fz1 + 0.004, fsx1, fsy1, fsx1 - 0.006,
              fsy1 - 0.006, "Dark")
    for ex in (-0.009, 0.009):
        m.rod((ex, fy + fdy, fz1), (ex, fy + fdy, fz1 + 0.016), 0.0055, "Dark", 10)

    # Anti-ship missile canisters, angled out over each side.
    for side in (-1, 1):
        out = Vector((side * 0.94, -0.34, 0.0)).normalized()
        up = Vector((0, 0, 1))
        along = (out + up * 0.18).normalized()
        across = out.cross(up).normalized()
        base = Vector((side * 0.024, 0.145, 0.118))
        m.box(base.x + side * 0.012, base.y, 0.118, 0.03, 0.04, 0.006, "MetalDark")
        for a in (-0.0055, 0.0055):
            for b in (0.0, 0.0105):
                p0 = base + across * a + Vector((0, 0, 0.012 + b))
                m.beam(p0, p0 + along * 0.05, 0.0095, "MetalLight")

    # Boats in davits and life-raft canisters along the deckhouse.
    for side in (-1, 1):
        for y in (-0.02, 0.12):
            m.frustum(side * 0.074, y, 0.08, 0.091, 0.018, 0.048, 0.017, 0.044,
                      "Dark", bevel=0.002)
            m.box(side * 0.074, y, 0.091, 0.012, 0.034, 0.004, "Hazard")
            for dy in (-0.018, 0.018):
                m.beam((side * 0.06, y + dy, 0.118), (side * 0.076, y + dy, 0.104),
                       0.0022, "MetalDark")
        for y in (-0.13, -0.11, 0.165, 0.185):
            m.rod((side * 0.076, y - 0.008, 0.068), (side * 0.076, y + 0.008, 0.068),
                  0.0065, "Missile", 8)

    # Hangar with its door, a second CIWS and whip antennas.
    m.frustum(0, 0.255, 0.06, 0.135, 0.122, 0.13, 0.11, 0.118, "MetalLight",
              dy1=-0.004, bevel=0.003)
    m.box(0, 0.3215, 0.06, 0.082, 0.003, 0.058, "MetalDark")
    for k in range(1, 5):
        m.box(0, 0.3235, 0.06 + k * 0.0115, 0.08, 0.002, 0.0015, "Dark")
    ciws(m, 0, 0.235, 0.135, 1)
    for wx in (-0.045, 0.045):
        m.rod((wx, 0.29, 0.135), (wx, 0.29, 0.2), 0.0012, "MetalDark", 4)

    # Flight deck: non-skid pad, markings and a helicopter.
    m.box(0, 0.41, 0.06, 0.15, 0.15, 0.0012, "Asphalt")
    m.ring(0, 0.41, 0.0612, 0.0622, 0.045, 0.051, "Marking", 32)
    m.box(0, 0.41, 0.0612, 0.003, 0.15, 0.001, "Marking")
    for ex in (-0.073, 0.073):
        m.box(ex, 0.41, 0.0612, 0.003, 0.15, 0.001, "Marking")
    helicopter(m, 0, 0.405, 0.0622)
    m.rod((0, 0.492, 0.06), (0, 0.492, 0.11), 0.0015, "MetalDark", 6)
    m.box(0, 0.5, 0.098, 0.002, 0.016, 0.011, "TeamColor")
    return m.to_object()




def hull(m, starboard, deck, bottom=-0.04, keel_sx=0.42, sides=None,
         deck_material="TeamDeck"):
    """Lofted hull from a starboard outline ((x, y) from the bow round to
    the transom). deck(y) gives the deck height. sides colours the bands
    from the keel up (bottom, waterline, topsides x2)."""
    outline = starboard + [(-x, y) for x, y in reversed(starboard) if x != 0.0]

    def ring(sx, bow, stern, z):
        return [(x * sx, y * (bow if y < 0 else stern), z(y)) for x, y in outline]

    m.loft(
        [
            ring(keel_sx, 0.9, 0.97, lambda y: bottom),
            ring(0.9, 0.98, 0.995, lambda y: 0.0),
            ring(0.93, 0.985, 1.0, lambda y: 0.008),
            ring(0.99, 1.0, 1.0, lambda y: 0.03 + 0.5 * (deck(y) - 0.05)),
            ring(1.0, 1.0, 1.0, deck),
        ],
        sides or ["HullRed", "Dark", "TeamColor", "TeamColor"],
        deck_material,
        "HullRed",
    )


def build_transport():
    """A landing craft: an open well deck between high wing walls carrying a
    tank, an APC and a truck, a raised bow ramp, and the pilot house at the
    stern."""
    m = Model("Transport")
    starboard = [
        (0.0, -0.5), (0.09, -0.5), (0.125, -0.485), (0.14, -0.45),
        (0.145, -0.35), (0.145, 0.42), (0.14, 0.48), (0.13, 0.5),
    ]
    deck = lambda y: 0.05
    hull(m, starboard, deck, bottom=-0.03, keel_sx=0.7)

    # Wing walls along both sides of the well deck.
    for side in (-1, 1):
        m.box(side * 0.127, -0.12, 0.05, 0.03, 0.62, 0.065, "TeamColor",
              bevel=0.003)
        m.box(side * 0.127, -0.12, 0.115, 0.034, 0.62, 0.004, "MetalLight")
        for k in range(6):
            m.box(side * 0.111, -0.4 + k * 0.11, 0.06, 0.002, 0.006, 0.05,
                  "MetalDark")
        for k in range(4):
            m.cylinder(side * 0.127, -0.38 + k * 0.17, 0.119, 0.127, 0.006,
                       "MetalDark", segments=8)
    # Bow ramp, raised, with its hinge and chains.
    with m.at(translate(0, -0.455, 0.05) @ rot_x(-12)):
        m.box(0, 0, 0.0, 0.22, 0.014, 0.085, "MetalDark", bevel=0.003)
        for k in range(5):
            m.box(0, 0.008, 0.012 + k * 0.016, 0.21, 0.003, 0.004, "Dark")
    m.rod((-0.11, -0.455, 0.05), (0.11, -0.455, 0.05), 0.008, "Dark", 8)
    for side in (-1, 1):
        m.rod((side * 0.1, -0.44, 0.112), (side * 0.112, -0.38, 0.12), 0.0025,
              "Dark", 4)

    # Cargo in the well deck.
    tank(m, 0, -0.27, 0.05, 0, 0.82)
    apc(m, -0.05, -0.02, 0.05, 0, 0.78)
    military_truck(m, 0.055, 0.0, 0.05, 0, body="shelter", s=0.95)

    # Stern deckhouse and pilot house.
    m.frustum(0, 0.33, 0.05, 0.12, 0.27, 0.27, 0.25, 0.25, "MetalLight",
              bevel=0.003)
    m.box(0, 0.1955, 0.075, 0.2, 0.003, 0.014, "Window")
    m.box(0, 0.31, 0.12, 0.16, 0.12, 0.05, "MetalLight", bevel=0.003)
    m.box(0, 0.249, 0.137, 0.15, 0.003, 0.02, "Window")
    for side in (-1, 1):
        m.box(side * 0.0805, 0.3, 0.137, 0.003, 0.08, 0.02, "Window")
    m.box(0, 0.31, 0.17, 0.168, 0.128, 0.006, "TeamColor")
    m.rod((0, 0.33, 0.176), (0, 0.33, 0.27), 0.004, "MetalDark", 6)
    m.box(0, 0.33, 0.235, 0.07, 0.008, 0.005, "MetalDark")
    m.box(0, 0.33, 0.25, 0.04, 0.012, 0.006, "Dark")
    m.sphere(0, 0.33, 0.275, 0.006, "CarRed")
    for side in (-1, 1):
        m.box(side * 0.1, 0.42, 0.12, 0.03, 0.04, 0.04, "Dark", bevel=0.003)
        m.rod((side * 0.12, 0.25, 0.09), (side * 0.12, 0.25, 0.1), 0.008,
              "Orange", 8)
    m.rod((0, 0.49, 0.05), (0, 0.49, 0.14), 0.002, "MetalDark", 4)
    m.box(0, 0.49 + 0.012, 0.115, 0.002, 0.024, 0.02, "TeamColor")
    return m.to_object()


def build_trade_ship():
    """A container ship: a long hull in the owner's colours stacked with
    containers between lashing bridges, the accommodation block and funnel
    aft, a breakwater and mooring gear on the bow, and a free-fall lifeboat
    on the stern."""
    m = Model("TradeShip")
    rng = random.Random(5)
    starboard = [
        (0.0, -0.5), (0.025, -0.47), (0.05, -0.42), (0.068, -0.35),
        (0.076, -0.26), (0.078, -0.1), (0.078, 0.36), (0.074, 0.45),
        (0.066, 0.5),
    ]

    def deck(y):
        return 0.05 + 0.014 * max(0.0, (-y - 0.36) / 0.14)

    hull(m, starboard, deck, bottom=-0.04)
    m.sphere(0, -0.47, -0.02, 0.022, "HullRed", subdivisions=2, sy=1.6)

    # Containers bay by bay, with lashing bridges between the bays.
    rows = 7
    bays = [-0.33 + k * 0.08 for k in range(8)]
    for k, by in enumerate(bays):
        tiers = rng.choice((3, 4, 4, 5)) if k else 3
        for r in range(rows):
            rx = (r - (rows - 1) / 2) * (CONTAINER_WIDTH + 0.002)
            height = tiers - (1 if r in (0, rows - 1) else 0)
            for t in range(height):
                paint = rng.choice(CONTAINER_PAINTS)
                with m.at(translate(rx, by, 0.05 + t * CONTAINER_HEIGHT)):
                    container(m, 0, 0, 0, paint, rz=90)
        m.box(0, by + 0.0415, 0.05, 0.15, 0.004, 0.05, "MetalLight")
    m.box(0, bays[0] - 0.045, 0.05, 0.15, 0.006, 0.05, "TeamColor")

    # Bow: breakwater, winches, foremast.
    m.frustum(0, -0.39, 0.064, 0.09, 0.11, 0.008, 0.11, 0.004, "TeamColor")
    for side in (-1, 1):
        m.rod((side * 0.025, -0.43, 0.072), (side * 0.005, -0.43, 0.072),
              0.008, "MetalDark", 8)
        m.cylinder(side * 0.03, -0.465, 0.064, 0.07, 0.005, "MetalDark",
                   segments=8)
    m.rod((0, -0.42, 0.064), (0, -0.42, 0.13), 0.0025, "MetalLight", 6)
    m.sphere(0, -0.42, 0.132, 0.004, "Lamp")

    # Accommodation block and bridge with wings.
    ax, ay = 0.0, 0.35
    z = 0.05
    for level in range(5):
        m.box(ax, ay, z, 0.13 - level * 0.004, 0.06, 0.02, "Facade")
        m.box(ax, ay - 0.0302, z + 0.009, 0.11, 0.002, 0.007, "Window")
        z += 0.022
    m.box(ax, ay, z, 0.19, 0.05, 0.022, "Facade", bevel=0.002)
    m.box(ax, ay - 0.0252, z + 0.008, 0.18, 0.002, 0.01, "Window")
    m.box(ax, ay, z + 0.022, 0.194, 0.054, 0.004, "TeamColor")
    m.rod((0, ay + 0.01, z + 0.026), (0, ay + 0.01, z + 0.09), 0.0025,
          "MetalDark", 6)
    m.box(0, ay + 0.01, z + 0.06, 0.05, 0.006, 0.004, "MetalDark")
    m.box(0, ay + 0.01, z + 0.072, 0.03, 0.008, 0.004, "Dark")
    # Funnel.
    m.frustum(0, 0.425, 0.05, 0.2, 0.06, 0.05, 0.05, 0.04, "MetalLight",
              dy1=0.008, bevel=0.002)
    frustum_band(m, 0, 0.425, 0.05, 0.2, 0.06, 0.05, 0.05, 0.04, 0.008, 0.15,
                 0.18, 0.002, "TeamColor")
    m.frustum(0, 0.433, 0.2, 0.206, 0.05, 0.04, 0.046, 0.036, "Dark")
    # Free-fall lifeboat on its ramp, mooring gear on the stern.
    with m.at(translate(0, 0.47, 0.11) @ rot_x(30)):
        m.box(0, 0, -0.004, 0.024, 0.06, 0.004, "MetalDark")
        m.sphere(0, 0, 0.01, 0.012, "Orange", subdivisions=2, sy=2.4, sz=0.9)
    for side in (-1, 1):
        m.cylinder(side * 0.04, 0.47, 0.05, 0.058, 0.007, "MetalDark",
                   segments=8)
    return m.to_object()
