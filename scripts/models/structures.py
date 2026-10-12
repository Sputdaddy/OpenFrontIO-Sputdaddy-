"""Structures: city, missile silo, port, factory, defense post and SAM
launcher. Each fits a 1x1 footprint centred on the origin, on the ground at
z = 0."""

import math
import random

from kit import Model, Vector, rot_x, rot_y, rot_z, translate
from vehicles import (CONTAINER_HEIGHT, CONTAINER_PAINTS, apc, car, container,
                      military_truck, tank, truck, wheel)


def banded_block(m, x, y, z0, sx, sy, floors, floor_h, wall):
    """Mid-rise with ribbon windows, a parapet and a team-colour roof.
    Returns the roof height."""
    z = z0
    for _ in range(floors):
        m.box(x, y, z, sx, sy, floor_h * 0.45, wall)
        m.box(x, y, z + floor_h * 0.45, sx - 0.008, sy - 0.008, floor_h * 0.55,
              "Window")
        z += floor_h
    m.box(x, y, z, sx, sy, floor_h * 0.5, wall)
    z += floor_h * 0.5
    m.box(x, y, z, sx - 0.014, sy - 0.014, 0.004, "TeamRoof")
    return z + 0.004


def glass_tower(m, x, y, z0, sx, sy, h, floor_h):
    """Curtain-wall tower: team-tinted glass with floor slabs and corner
    mullions. Returns the roof height."""
    m.box(x, y, z0, sx - 0.008, sy - 0.008, h, "TeamGlass")
    z = z0
    while z < z0 + h - 1e-6:
        m.box(x, y, z, sx, sy, 0.006, "Facade")
        z += floor_h
    for cx in (-1, 1):
        for cy in (-1, 1):
            m.box(x + cx * (sx / 2 - 0.006), y + cy * (sy / 2 - 0.006), z0,
                  0.012, 0.012, h, "Facade")
    m.box(x, y, z0 + h, sx + 0.004, sy + 0.004, 0.014, "Facade")
    return z0 + h + 0.014


def round_tower(m, x, y, z0, r, h, floor_h):
    m.cylinder(x, y, z0, z0 + h, r - 0.005, "TeamGlass", segments=24)
    z = z0
    while z < z0 + h - 1e-6:
        m.cylinder(x, y, z, z + 0.006, r, "Facade", segments=24)
        z += floor_h
    m.cylinder(x, y, z0 + h, z0 + h + 0.016, r + 0.003, "Facade", segments=24)
    return z0 + h + 0.016


def rooftop_units(m, x, y, z, units):
    for dx, dy, sx, sy, sz in units:
        m.box(x + dx, y + dy, z, sx, sy, sz, "MetalLight", bevel=0.002)


def tree(m, x, y, z, size=1.0):
    m.cylinder(x, y, z, z + 0.03 * size, 0.007 * size, "Trunk", segments=6)
    m.sphere(x, y, z + 0.05 * size, 0.034 * size, "Foliage", sz=1.15)


def fence(m, half, z0, height=0.07, gate=0.08, posts=11):
    """Square perimeter fence, half wide, with a gate gap gate wide each
    side of the middle of its front (-Y) edge."""
    ps = [-half + i * 2 * half / (posts - 1) for i in range(posts)]
    sides = [
        [(p, -half) for p in ps], [(half, p) for p in ps],
        [(p, half) for p in ps], [(-half, p) for p in ps],
    ]
    for k, edge in enumerate(sides):
        for i, (px, py) in enumerate(edge):
            if k == 0 and abs(px) < gate:
                continue
            m.rod((px, py, z0), (px, py, z0 + height), 0.0035, "MetalLight", 6)
            if i + 1 < len(edge):
                qx, qy = edge[i + 1]
                if k == 0 and (abs(px) < gate or abs(qx) < gate):
                    continue
                for h in (height / 2, height - 0.003):
                    m.beam((px, py, z0 + h), (qx, qy, z0 + h), 0.0025,
                           "MetalLight")


def build_city():
    """A modern city block: four blocks round a crossroads with an office
    skyscraper, a round glass tower, offices, apartments and a park."""
    m = Model("City")
    road = 0.025
    top = road + 0.012  # sidewalk level

    # Streets: asphalt base, four raised blocks, markings.
    m.box(0, 0, 0, 0.98, 0.98, road, "Asphalt", bevel=0.008)
    for bx in (-1, 1):
        for by in (-1, 1):
            m.box(bx * 0.235, by * 0.235, road, 0.4, 0.4, 0.012, "Sidewalk",
                  bevel=0.004)
    for i in range(-6, 7):
        t = i * 0.075
        if abs(t) < 0.06:
            continue  # keep the junction clear
        m.box(t, 0, road, 0.035, 0.005, 0.0015, "Marking")
        m.box(0, t, road, 0.005, 0.035, 0.0015, "Marking")
    for k in range(-2, 3):
        for side in (-1, 1):
            m.box(side * 0.052, k * 0.013, road, 0.022, 0.006, 0.0015, "Marking")
            m.box(k * 0.013, side * 0.052, road, 0.006, 0.022, 0.0015, "Marking")

    # North-east: the skyscraper on a two-storey podium, with a spire.
    z = banded_block(m, 0.235, 0.235, top, 0.34, 0.34, 2, 0.032, "Facade")
    z = glass_tower(m, 0.25, 0.25, z, 0.2, 0.2, 0.42, 0.04)
    z = glass_tower(m, 0.25, 0.25, z, 0.14, 0.14, 0.1, 0.04)
    m.box(0.25, 0.25, z, 0.1, 0.1, 0.03, "TeamColor", bevel=0.004)
    m.cylinder(0.25, 0.25, z + 0.03, z + 0.17, 0.006, "MetalLight",
               r2=0.002, segments=8)
    rooftop_units(m, 0.235, 0.235, top + 0.0755, [
        (-0.12, -0.12, 0.04, 0.03, 0.02), (0.12, -0.13, 0.03, 0.03, 0.018),
    ])

    # North-west: round glass tower and an office slab.
    z = round_tower(m, -0.3, 0.3, top, 0.085, 0.4, 0.035)
    m.cylinder(-0.3, 0.3, z, z + 0.01, 0.07, "TeamRoof", segments=24)
    m.cylinder(-0.3, 0.3, z + 0.01, z + 0.03, 0.025, "MetalLight", segments=12)
    z = banded_block(m, -0.14, 0.235, top, 0.12, 0.34, 7, 0.04, "Facade")
    rooftop_units(m, -0.14, 0.235, z, [
        (0, 0.08, 0.06, 0.05, 0.025), (0, -0.07, 0.05, 0.04, 0.018),
    ])

    # South-west: apartment blocks round a small courtyard.
    z = banded_block(m, -0.235, -0.15, top, 0.34, 0.1, 5, 0.036, "FacadeWarm")
    rooftop_units(m, -0.235, -0.15, z, [
        (-0.1, 0, 0.03, 0.03, 0.016), (0.02, 0, 0.03, 0.03, 0.016),
        (0.12, 0.01, 0.04, 0.025, 0.02),
    ])
    z = banded_block(m, -0.235, -0.33, top, 0.34, 0.08, 3, 0.036, "FacadeWarm")
    rooftop_units(m, -0.235, -0.33, z, [(-0.08, 0, 0.03, 0.03, 0.015)])
    for tx in (-0.36, -0.235, -0.11):
        tree(m, tx, -0.245, top, 0.7)

    # South-east: low offices backing onto a park with a pond.
    z = banded_block(m, 0.235, -0.11, top, 0.3, 0.1, 2, 0.036, "Facade")
    rooftop_units(m, 0.235, -0.11, z, [(0.08, 0, 0.04, 0.04, 0.02)])
    m.box(0.235, -0.3, top, 0.36, 0.25, 0.003, "Grass")
    m.cylinder(0.29, -0.3, top, top + 0.0045, 0.06, "Water", segments=20,
               sx=1.4)
    for tx, ty in ((0.12, -0.22), (0.12, -0.37), (0.38, -0.21), (0.39, -0.39),
                   (0.22, -0.4), (0.3, -0.2), (0.175, -0.3)):
        tree(m, tx, ty, top + 0.003)

    # Traffic.
    for x, y, rz, paint in (
        (-0.33, -0.017, 0, "CarRed"), (0.15, 0.017, 180, "CarWhite"),
        (0.38, -0.017, 0, "CarYellow"), (0.017, -0.3, 90, "CarBlue"),
        (-0.017, 0.2, 270, "CarWhite"), (-0.4625, 0.1, 90, "CarYellow"),
        (0.2, 0.4625, 180, "CarBlue"),
    ):
        car(m, x, y, road, rz, paint)
    return m.to_object()




def build_missile_silo():
    """A missile silo, blast doors open and the missile raised, with a
    service gantry, control bunker, fuel farm, tanker truck, floodlights
    and a perimeter fence."""
    m = Model("MissileSilo")
    pad = 0.05
    m.box(0, 0, 0.0, 0.9, 0.9, pad, "Concrete", bevel=0.02)
    for t in (-0.3, 0.3):
        m.box(t, 0, pad, 0.004, 0.86, 0.0008, "ConcreteDark")
        m.box(0, t, pad, 0.86, 0.004, 0.0008, "ConcreteDark")

    # Chevron hazard ring, collar, bolts and the open shaft.
    for i in range(24):
        m.ring(0, 0, pad, pad + 0.003, 0.27, 0.32,
               "Hazard" if i % 2 == 0 else "Dark", segments=2,
               a0=i * 15, a1=(i + 1) * 15)
    m.cylinder(0, 0, pad, 0.1, 0.24, "ConcreteDark", segments=32, bevel=0.008)
    m.cylinder(0, 0, 0.1, 0.12, 0.24, "TeamColor", segments=32, bevel=0.004)
    m.ring(0, 0, 0.12, 0.124, 0.178, 0.2, "MetalDark", 32)
    m.cylinder(0, 0, 0.11, 0.1215, 0.18, "Dark", segments=32)
    for i in range(20):
        a = math.radians(i * 18)
        m.cylinder(0.218 * math.cos(a), 0.218 * math.sin(a), 0.12, 0.126, 0.004,
                   "MetalDark", segments=6)

    # The missile, raised out of the shaft.
    m.cylinder(0, 0, 0.1, 0.25, 0.072, "Missile", segments=24)
    m.cylinder(0, 0, 0.2, 0.222, 0.0725, "TeamColor", segments=24)
    for k in range(4):
        a = 45 + 90 * k
        r = math.radians(a)
        m.oriented_box(translate(0.0725 * math.cos(r), 0.0725 * math.sin(r), 0.165)
                       @ rot_z(a), 0.002, 0.014, 0.05, "Dark")
    m.cylinder(0, 0, 0.25, 0.254, 0.0735, "MetalDark", segments=24)
    m.cylinder(0, 0, 0.254, 0.36, 0.072, "Missile", r2=0.006, segments=24)
    m.cylinder(0, 0, 0.36, 0.368, 0.006, "MetalDark", r2=0.0, segments=8)

    # Blast doors swung open, with ribs, hinges and hydraulic rams.
    for side in (-1, 1):
        hinge = translate(side * 0.21, 0, 0.12) @ rot_y(side * 105)
        m.box(-side * 0.1, 0, 0.0, 0.2, 0.36, 0.03, "TeamColor", bevel=0.008,
              m=hinge)
        for ry in (-0.12, 0.0, 0.12):
            m.box(-side * 0.1, ry, 0.03, 0.18, 0.014, 0.008, "MetalDark", m=hinge)
        m.box(-side * 0.1, 0, 0.03, 0.014, 0.32, 0.008, "MetalDark", m=hinge)
        m.rod((side * 0.21, -0.17, 0.12), (side * 0.21, 0.17, 0.12), 0.012,
              "MetalDark", 12)
        for dy in (-0.11, 0.11):
            base = Vector((side * 0.31, dy, pad + 0.006))
            tip = (hinge @ Vector((-side * 0.09, dy, 0.03))).to_3d()
            mid = base + (tip - base) * 0.55
            m.box(base.x, base.y, pad, 0.02, 0.02, 0.008, "MetalDark")
            m.rod(base, mid, 0.008, "MetalDark", 10)
            m.rod(mid, tip, 0.0045, "MetalLight", 8)

    # Service gantry behind the shaft, with an access arm to the missile.
    gx, gy, top = 0.0, 0.34, 0.44
    corners = [(gx - 0.045, gy - 0.045), (gx + 0.045, gy - 0.045),
               (gx + 0.045, gy + 0.045), (gx - 0.045, gy + 0.045)]
    for cx, cy in corners:
        m.beam((cx, cy, pad), (cx, cy, top), 0.008, "Gantry")
    levels = [pad, 0.16, 0.28, 0.4]
    for z in levels[1:]:
        m.box(gx, gy, z, 0.11, 0.11, 0.005, "MetalDark")
    for (ax, ay), (bx2, by2) in zip(corners, corners[1:] + corners[:1]):
        for z0, z1 in zip(levels, levels[1:]):
            m.beam((ax, ay, z0), (bx2, by2, z1), 0.0045, "Gantry")
            m.beam((bx2, by2, z0), (ax, ay, z1), 0.0045, "Gantry")
    m.box(0, 0.19, 0.297, 0.022, 0.21, 0.006, "MetalDark")
    for side in (-1, 1):
        m.beam((side * 0.011, 0.09, 0.312), (side * 0.011, 0.295, 0.312), 0.002,
               "Gantry")
    m.rod((0, 0.085, 0.3), (0, 0.047, 0.29), 0.003, "Dark", 6)
    m.rod((gx, gy, top), (gx, gy, top + 0.06), 0.002, "MetalDark", 6)
    m.sphere(gx, gy, top + 0.062, 0.005, "CarRed", subdivisions=1)

    # Control bunker: door, windows, roof plant, antenna and dish.
    m.box(0.3, 0.31, pad, 0.2, 0.14, 0.08, "ConcreteDark", bevel=0.015)
    m.box(0.27, 0.239, pad, 0.035, 0.004, 0.055, "MetalDark")
    m.box(0.345, 0.239, 0.09, 0.05, 0.003, 0.012, "Window")
    m.box(0.36, 0.35, 0.13, 0.03, 0.03, 0.016, "MetalLight", bevel=0.002)
    for vx in (0.22, 0.24):
        m.cylinder(vx, 0.36, 0.13, 0.145, 0.006, "MetalDark", segments=8)
    m.rod((0.37, 0.28, 0.13), (0.37, 0.28, 0.29), 0.0035, "MetalDark", 6)
    for z in (0.22, 0.26):
        m.beam((0.35, 0.28, z), (0.39, 0.28, z), 0.002, "MetalDark")
    m.cylinder(0.25, 0.3, 0.13, 0.16, 0.008, "MetalDark", segments=8)
    dish = translate(0.25, 0.3, 0.17) @ rot_x(-40)
    m.cylinder(0, 0, -0.012, 0.012, 0.045, "MetalLight", r2=0.012,
               segments=16, m=dish)
    feed = (dish @ Vector((0, 0, 0.04))).to_3d()
    m.rod((0.25, 0.3, 0.17), feed, 0.002, "MetalDark", 4)

    # Fuel farm: two tanks on saddles with team bands, piped to the silo.
    for ty in (0.22, 0.34):
        m.rod((-0.4, ty, 0.095), (-0.18, ty, 0.095), 0.045, "MetalLight", 16)
        for ex in (-0.4, -0.18):
            m.sphere(ex, ty, 0.095, 0.045, "MetalLight", subdivisions=2, sx=0.35)
        m.rod((-0.3, ty, 0.095), (-0.28, ty, 0.095), 0.0465, "TeamColor", 16)
        for sx_ in (-0.36, -0.22):
            m.box(sx_, ty, pad, 0.016, 0.07, 0.03, "ConcreteDark")
        m.rod((-0.2, ty, 0.095), (-0.155, ty, 0.095), 0.006, "MetalDark", 8)
        m.rod((-0.155, ty, 0.095), (-0.155, ty, pad + 0.007), 0.006, "MetalDark", 8)
        m.cylinder(-0.168, ty, 0.088, 0.102, 0.009, "CarRed", segments=8)
    m.rod((-0.155, 0.345, pad + 0.007), (-0.155, 0.16, pad + 0.007), 0.006,
          "MetalDark", 8)

    # Fuel tanker parked inside the gate.
    tx, ty = -0.33, -0.22
    m.box(tx, ty, pad + 0.008, 0.035, 0.125, 0.006, "MetalDark")
    m.box(tx, ty - 0.05, pad + 0.012, 0.036, 0.032, 0.03, "Olive", bevel=0.003)
    m.box(tx, ty - 0.0665, pad + 0.03, 0.03, 0.002, 0.01, "Window")
    m.rod((tx, ty - 0.03, pad + 0.035), (tx, ty + 0.06, pad + 0.035), 0.019,
          "MetalLight", 16)
    for wy in (-0.05, 0.02, 0.045):
        for side in (-1, 1):
            m.rod((tx + side * 0.012, ty + wy, pad + 0.009),
                  (tx + side * 0.021, ty + wy, pad + 0.009), 0.009, "Dark", 10)

    # Floodlight masts at the front corners.
    for lx, rz in ((-0.4, -45), (0.4, 45)):
        ly = -0.4
        m.rod((lx, ly, pad), (lx, ly, 0.3), 0.005, "MetalDark", 8)
        m.box(lx, ly, 0.3, 0.04, 0.012, 0.018, "MetalDark", rz=rz)
        m.box(lx * 0.985, ly * 0.985, 0.302, 0.034, 0.004, 0.013, "Lamp", rz=rz)

    # Perimeter fence with a gate and guard booth at the front.
    fence(m, 0.43, pad)
    m.box(0.13, -0.39, pad, 0.05, 0.05, 0.06, "Facade", bevel=0.003)
    m.box(0.13, -0.39, pad + 0.035, 0.052, 0.052, 0.014, "Window")
    m.box(0.13, -0.39, pad + 0.06, 0.06, 0.06, 0.006, "MetalDark")
    m.box(0.06, -0.43, pad, 0.008, 0.008, 0.03, "MetalDark")
    m.box(0.0, -0.43, pad + 0.026, 0.12, 0.005, 0.006, "Hazard")
    return m.to_object()




def light_mast(m, x, y, z0, top, rz=0.0):
    m.rod((x, y, z0), (x, y, top), 0.0045, "MetalDark", 8)
    m.box(x, y, top, 0.05, 0.012, 0.016, "MetalDark", rz=rz)
    with m.at(translate(x, y, top) @ rot_z(rz)):
        for lx in (-0.016, 0.0, 0.016):
            m.box(lx, -0.0062, 0.003, 0.012, 0.002, 0.01, "Lamp")


def sts_crane(m, x0, deck):
    """Ship-to-shore container crane in the owner's colours, on rails along
    the quay, its boom reaching out over the water (-Y) with a container on
    the spreader."""
    legs = (-0.43, -0.25)
    half, top = 0.066, 0.3
    for ly in legs:
        for side in (-1, 1):
            lx = x0 + side * half
            m.box(lx, ly, deck, 0.028, 0.05, 0.014, "Dark", bevel=0.002)
            m.beam((lx, ly, deck + 0.014), (lx, ly, top), 0.018, "TeamColor")
        m.box(x0, ly, top, 2 * half + 0.018, 0.022, 0.026, "TeamColor")
        m.beam((x0 - half, ly, deck + 0.13), (x0 + half, ly, deck + 0.13), 0.01,
               "TeamColor")
    for side in (-1, 1):
        lx = x0 + side * half
        m.box(lx, -0.34, top, 0.018, 0.2, 0.026, "TeamColor")
        m.beam((lx, legs[0], deck + 0.13), (lx, legs[1], top), 0.009,
               "TeamColor")
    # Boom: twin girders with cross ties, from the backreach out over the
    # water, held by stays from the A-frame.
    bz = top + 0.026
    for side in (-1, 1):
        gx = x0 + side * 0.042
        m.box(gx, -0.36, bz, 0.012, 0.86, 0.024, "MetalLight")
        m.box(gx, -0.36, bz + 0.024, 0.016, 0.86, 0.003, "TeamColor")
    for k in range(13):
        m.box(x0, 0.06 - k * 0.07, bz + 0.004, 0.084, 0.006, 0.006,
              "MetalLight")
    apex = 0.56
    for side in (-1, 1):
        ax = x0 + side * 0.042
        for ly in legs:
            m.beam((x0 + side * half, ly, bz), (ax, -0.34, apex), 0.014,
                   "TeamColor")
        for ty in (-0.78, -0.58, 0.06):
            m.rod((ax, -0.34, apex), (ax, ty, bz + 0.024), 0.003, "MetalDark",
                  6)
    m.box(x0, -0.34, apex - 0.008, 0.1, 0.03, 0.016, "TeamColor")
    m.sphere(x0, -0.34, apex + 0.012, 0.005, "CarRed")
    # Machinery house on the backreach, the operator's cab under the boom.
    m.box(x0, -0.02, bz + 0.024, 0.1, 0.12, 0.05, "MetalLight", bevel=0.003)
    m.box(x0, -0.02, bz + 0.074, 0.104, 0.124, 0.004, "TeamColor")
    for k in range(3):
        m.box(x0 + 0.051, -0.06 + k * 0.035, bz + 0.04, 0.002, 0.02, 0.02,
              "Dark")
    m.box(x0 + 0.03, -0.47, bz - 0.034, 0.032, 0.032, 0.034, "MetalLight",
          bevel=0.002)
    m.box(x0 + 0.03, -0.4865, bz - 0.03, 0.028, 0.002, 0.022, "Window")
    # Trolley, hoist ropes, spreader and the container it's lifting.
    ty = -0.64
    m.box(x0, ty, bz - 0.01, 0.07, 0.05, 0.012, "Dark")
    for cx in (-0.03, 0.03):
        for cy in (-0.012, 0.012):
            m.rod((x0 + cx, ty + cy, bz - 0.01), (x0 + cx * 0.9, ty + cy, 0.172),
                  0.001, "Dark", 4)
    m.box(x0, ty, 0.162, 0.082, 0.022, 0.01, "Hazard")
    container(m, x0, ty, 0.144, "ContainerBlue")


def rtg_crane(m, x0, y0, y1, deck, height=0.11):
    """Rubber-tyred gantry crane straddling a container block from y0 to
    y1."""
    for ly in (y0, y1):
        for side in (-1, 1):
            lx = x0 + side * 0.035
            wheel(m, lx, ly, deck + 0.008, 0.008, 0.008)
            m.beam((lx, ly, deck + 0.012), (lx, ly, deck + height), 0.008,
                   "MetalLight")
        m.box(x0, ly, deck + 0.012, 0.08, 0.01, 0.008, "MetalLight")
    for side in (-1, 1):
        m.box(x0 + side * 0.035, (y0 + y1) / 2, deck + height, 0.012,
              abs(y1 - y0) + 0.012, 0.014, "Hazard")
    m.box(x0, (y0 + y1) / 2 - 0.02, deck + height + 0.002, 0.06, 0.03, 0.012,
          "MetalLight")
    m.box(x0 + 0.03, y0 + 0.02, deck + height - 0.03, 0.016, 0.016, 0.02,
          "Window")


def build_port():
    """A container port: a concrete wharf with two ship-to-shore cranes in
    the owner's colours over the water (-Y), a container yard with gantry
    cranes, trucks, a warehouse and a harbour office with a control
    tower."""
    m = Model("Port")
    rng = random.Random(11)
    deck = 0.045
    m.box(0, 0, 0, 0.98, 0.98, deck, "Concrete", bevel=0.004)
    # Quay edge: fenders, bollards, a safety line and the crane rails.
    for i in range(10):
        x = -0.45 + i * 0.1
        m.box(x, -0.494, 0.006, 0.032, 0.012, 0.034, "Dark", bevel=0.002)
        m.cylinder(x + 0.05, -0.475, deck, deck + 0.008, 0.0055, "MetalDark",
                   segments=8)
        m.cylinder(x + 0.05, -0.475, deck + 0.008, deck + 0.011, 0.0075,
                   "MetalDark", segments=8)
    m.box(0, -0.458, deck, 0.97, 0.006, 0.001, "Hazard")
    for ry in (-0.43, -0.25):
        m.box(0, ry, deck, 0.97, 0.006, 0.002, "Rail")
    m.box(0, -0.34, deck, 0.97, 0.15, 0.0006, "ConcreteDark")
    for x0 in (-0.24, 0.2):
        sts_crane(m, x0, deck)
    # A truck under the crane waiting for its container.
    truck(m, 0.2, -0.33, deck, 90, "CarBlue")

    # Container yard: two blocks either side of a lane, gantry cranes over
    # them, trucks in the lanes.
    m.box(0, 0.185, deck, 0.97, 0.05, 0.0008, "Asphalt")
    for k in range(-9, 10):
        m.box(k * 0.05, 0.185, deck + 0.0008, 0.024, 0.003, 0.0006, "Marking")
    rows = [-0.155 + k * 0.021 for k in range(6)] + \
        [0.0 + k * 0.021 for k in range(6)]
    for bx0 in (-0.44, 0.06):
        for c in range(4):
            cx = bx0 + 0.04 + c * 0.093
            for ry in rows:
                for tier in range(rng.choice((0, 1, 1, 2, 2, 3, 3, 4))):
                    paint = rng.choice(CONTAINER_PAINTS + ["TeamColor"])
                    container(m, cx, ry, deck + tier * CONTAINER_HEIGHT, paint)
    m.box(0.0, 0.0, deck, 0.1, 0.36, 0.0008, "Asphalt")
    for x0, (y0, y1) in ((-0.15, (-0.172, -0.035)), (0.3, (-0.017, 0.12))):
        rtg_crane(m, x0, y0, y1, deck)
    truck(m, 0.0, -0.02, deck, 0, "CarRed", "ContainerGreen")
    truck(m, -0.3, 0.185, deck, 90, "CarWhite", "ContainerOrange")
    truck(m, 0.16, 0.185, deck, 270, "CarYellow", "TeamColor")

    # Warehouse with loading doors and a team-colour roof.
    wz = deck + 0.075
    m.box(-0.2, 0.37, deck, 0.54, 0.18, 0.075, "Cladding")
    m.extrude_x([(0.278, wz), (0.462, wz), (0.37, wz + 0.035)], -0.475, 0.075,
                "TeamSheet")
    for k in range(6):
        m.box(-0.42 + k * 0.08, 0.279, deck, 0.05, 0.004, 0.05, "CladdingDark")
    for k in range(5):
        m.box(-0.4 + k * 0.1, 0.37, wz + 0.018, 0.03, 0.03, 0.012,
              "MetalLight")
    # Harbour office with a control tower.
    z = banded_block(m, 0.29, 0.37, deck, 0.17, 0.16, 3, 0.036, "Facade")
    m.cylinder(0.33, 0.4, z, z + 0.1, 0.022, "Facade", segments=16)
    m.cylinder(0.33, 0.4, z + 0.1, z + 0.13, 0.04, "Window", segments=16)
    m.cylinder(0.33, 0.4, z + 0.13, z + 0.138, 0.046, "TeamColor",
               segments=16)
    m.rod((0.33, 0.4, z + 0.138), (0.33, 0.4, z + 0.2), 0.0025, "MetalDark", 6)
    rooftop_units(m, 0.29, 0.37, z, [(-0.04, -0.03, 0.04, 0.03, 0.016)])
    for x in (-0.47, -0.02, 0.47):
        light_mast(m, x, 0.225, deck, 0.3)
    return m.to_object()


def sawtooth_roof(m, x0, x1, y0, y1, z, teeth, rise):
    """Factory roof of teeth whose slopes face -Y (the owner's colour) and
    whose glazed sides face +Y."""
    w = (y1 - y0) / teeth
    for k in range(teeth):
        a = y0 + k * w
        m.extrude_x([(a, z), (a + w, z), (a + w, z + rise)], x0, x1,
                    "TeamSheet")
        m.box((x0 + x1) / 2, a + w + 0.0015, z + rise * 0.15, x1 - x0 - 0.01,
              0.003, rise * 0.75, "Window")


def build_factory():
    """A modern factory: a hall with a sawtooth roof in the owner's colours,
    an office block, smokestacks, silos with a conveyor, storage tanks and a
    pipe rack, loading docks with trucks, and a rail siding."""
    m = Model("Factory")
    base = 0.02
    m.box(0, 0, 0, 0.98, 0.98, base, "Asphalt", bevel=0.006)

    # Rail siding along the front with two hopper wagons.
    for k in range(25):
        m.box(-0.48 + k * 0.04, -0.43, base, 0.012, 0.06, 0.004, "Sleeper")
    for ry in (-0.448, -0.412):
        m.box(0, ry, base + 0.004, 0.97, 0.004, 0.004, "Rail")
    for wx in (-0.27, -0.06):
        m.box(wx, -0.43, base + 0.01, 0.19, 0.06, 0.01, "Dark")
        m.frustum(wx, -0.43, base + 0.02, base + 0.075, 0.16, 0.05, 0.19,
                  0.062, "CladdingDark", bevel=0.002)
        m.box(wx, -0.43, base + 0.075, 0.18, 0.05, 0.004, "MetalDark")

    # Main hall.
    x0, x1, y0, y1, h = -0.45, 0.13, -0.12, 0.43, 0.11
    m.box((x0 + x1) / 2, (y0 + y1) / 2, base, x1 - x0, y1 - y0, h, "Cladding",
          bevel=0.002)
    m.box((x0 + x1) / 2, (y0 + y1) / 2, base + h - 0.012, x1 - x0 + 0.004,
          y1 - y0 + 0.004, 0.012, "TeamColor")
    m.box((x0 + x1) / 2, y0 - 0.001, base + 0.05, x1 - x0 - 0.04, 0.003, 0.018,
          "Window")
    sawtooth_roof(m, x0, x1, y0, y1, base + h, 6, 0.042)
    # Loading docks on the east wall, trucks backed up to them.
    for k in range(3):
        dy = 0.05 + k * 0.08
        m.box(x1 + 0.001, dy, base, 0.004, 0.05, 0.06, "Dark")
        m.box(x1 + 0.012, dy, base + 0.064, 0.024, 0.06, 0.004, "MetalDark")
    truck(m, x1 + 0.065, 0.05, base, 270, "CarRed", "ContainerGrey")
    truck(m, x1 + 0.065, 0.21, base, 270, "CarWhite", "ContainerBlue")

    # Office block at the front-left.
    z = banded_block(m, -0.31, -0.24, base, 0.26, 0.13, 3, 0.036, "Facade")
    rooftop_units(m, -0.31, -0.24, z, [(0.06, 0.0, 0.05, 0.04, 0.02)])
    m.box(-0.31, -0.307, base, 0.06, 0.006, 0.03, "Window")

    # Smokestacks with red and white aviation bands and a team band.
    for sx, sy, top in ((0.27, 0.36, 0.58), (0.39, 0.36, 0.5)):
        m.box(sx, sy, base, 0.07, 0.07, 0.03, "ConcreteDark", bevel=0.004)
        m.cylinder(sx, sy, base + 0.03, top, 0.028, "CarWhite", r2=0.021,
                   segments=20)
        f = lambda z: 0.028 + (0.021 - 0.028) * (z - base - 0.03) / (
            top - base - 0.03)
        for za, zb, paint in ((top - 0.09, top - 0.06, "CarRed"),
                              (top - 0.03, top, "CarRed"),
                              (base + 0.18, base + 0.22, "TeamColor")):
            m.cylinder(sx, sy, za, zb, f(za) + 0.0015, paint, r2=f(zb) + 0.0015,
                       segments=20)
        m.ring(sx, sy, top - 0.12, top - 0.115, f(top - 0.12),
               f(top - 0.12) + 0.012, "MetalDark", 20)
        m.cylinder(sx, sy, top - 0.002, top + 0.002, 0.017, "Dark", segments=16)

    # Silos with a conveyor gallery up to the hall roof.
    for k in range(3):
        sx = 0.22 + k * 0.085
        m.cylinder(sx, 0.08, base, base + 0.21, 0.038, "MetalLight",
                   segments=20)
        m.cylinder(sx, 0.08, base + 0.21, base + 0.24, 0.039, "MetalLight",
                   r2=0.01, segments=20)
        m.cylinder(sx, 0.08, base + 0.12, base + 0.135, 0.0395, "TeamColor",
                   segments=20)
        m.rod((sx + 0.039, 0.08, base), (sx + 0.039, 0.08, base + 0.21), 0.002,
              "MetalDark", 4)
    m.box(0.305, 0.08, base + 0.24, 0.2, 0.024, 0.012, "MetalDark")
    m.beam((0.2, 0.08, base + 0.25), (x1 - 0.03, 0.08, base + h + 0.02),
           0.026, "Cladding", h=0.02)

    # Storage tanks, piped to the hall.
    for tx in (0.24, 0.38):
        m.cylinder(tx, -0.17, base, base + 0.1, 0.055, "CarWhite", segments=24)
        m.cylinder(tx, -0.17, base + 0.1, base + 0.112, 0.055, "MetalLight",
                   r2=0.035, segments=24)
        m.cylinder(tx, -0.17, base + 0.075, base + 0.088, 0.0555, "TeamColor",
                   segments=24)
        m.rod((tx, -0.17, base + 0.112), (tx, -0.17, base + 0.125), 0.004,
              "MetalDark", 6)
    for px in (0.31, 0.22, 0.17):
        m.rod((px, -0.1, base), (px, -0.1, base + 0.08), 0.003, "MetalDark", 6)
    for pz, pr, paint in ((base + 0.08, 0.006, "MetalLight"),
                          (base + 0.07, 0.004, "CarYellow")):
        m.rod((0.38, -0.11, pz), (x1, -0.11, pz), pr, paint, 8)
    for tx in (0.24, 0.38):
        m.rod((tx, -0.115, base + 0.07), (tx, -0.11, base + 0.07), 0.004,
              "CarYellow", 6)
    # Car park and trees along the front.
    for k in range(5):
        m.box(-0.09 + k * 0.05, -0.25, base, 0.002, 0.05, 0.0006, "Marking")
    for k, paint in enumerate(("CarRed", "CarWhite", "CarBlue", "CarYellow")):
        car(m, -0.065 + k * 0.05, -0.25, base, 90, paint)
    for tx in (-0.46, -0.13, 0.08):
        tree(m, tx, -0.34, base, 0.8)
    return m.to_object()


def hesco_wall(m, x0, y0, x1, y1, z0, cell=0.058, height=0.068):
    """A line of filled barrier cells from (x0, y0) to (x1, y1)."""
    n = max(1, round(math.hypot(x1 - x0, y1 - y0) / cell))
    for i in range(n):
        t = (i + 0.5) / n
        x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
        paint = "Sand" if i % 2 == 0 else "SandDark"
        rz = math.degrees(math.atan2(y1 - y0, x1 - x0))
        m.box(x, y, z0, cell * 0.97, cell * 0.97, height, paint, rz=rz,
              bevel=0.004)
        m.box(x, y, z0 + height, cell * 0.85, cell * 0.85, 0.0015, "Dirt",
              rz=rz)


def sandbags(m, x, y, z0, r, a0, a1, layers=3, material="SandDark"):
    """An arc of stacked sandbags round (x, y)."""
    for layer in range(layers):
        n = max(2, round(math.radians(a1 - a0) * r / 0.018))
        for i in range(n):
            a = math.radians(a0 + (a1 - a0) * (i + 0.5 * (layer % 2)) / n)
            m.box(x + r * math.cos(a), y + r * math.sin(a), z0 + layer * 0.008,
                  0.008, 0.017, 0.0085, material, rz=math.degrees(a),
                  bevel=0.0025)


def watchtower(m, x, y, z0, height=0.2):
    for cx in (-1, 1):
        for cy in (-1, 1):
            m.beam((x + cx * 0.04, y + cy * 0.04, z0),
                   (x + cx * 0.034, y + cy * 0.034, z0 + height), 0.008,
                   "MetalDark")
    for cx, cy, dx, dy in ((-1, -1, 1, 0), (1, -1, 0, 1), (1, 1, -1, 0),
                           (-1, 1, 0, -1)):
        a = (x + cx * 0.038, y + cy * 0.038)
        b = (a[0] + dx * 0.076, a[1] + dy * 0.076)
        m.beam((*a, z0 + 0.02), (*b, z0 + height * 0.55), 0.004, "MetalDark")
        m.beam((*b, z0 + 0.02), (*a, z0 + height * 0.55), 0.004, "MetalDark")
    pz = z0 + height
    m.box(x, y, pz, 0.1, 0.1, 0.008, "MetalDark")
    for k, (dx, dy) in enumerate(((0, -1), (1, 0), (0, 1), (-1, 0))):
        m.box(x + dx * 0.044, y + dy * 0.044, pz + 0.008,
              0.1 if dy else 0.012, 0.012 if dy else 0.1, 0.028, "SandDark",
              bevel=0.003)
    for cx in (-1, 1):
        for cy in (-1, 1):
            m.rod((x + cx * 0.044, y + cy * 0.044, pz + 0.036),
                  (x + cx * 0.044, y + cy * 0.044, pz + 0.066), 0.002,
                  "MetalDark", 4)
    m.box(x, y, pz + 0.066, 0.11, 0.11, 0.006, "TeamColor", bevel=0.002)
    m.rod((x + 0.03, y - 0.045, pz + 0.04), (x + 0.03, y - 0.075, pz + 0.042),
          0.0015, "Dark", 4)
    m.box(x - 0.03, y - 0.05, pz + 0.058, 0.016, 0.008, 0.01, "Lamp")
    for k in range(8):
        m.beam((x + 0.052, y - 0.01, z0 + k * height / 8),
               (x + 0.052, y + 0.01, z0 + k * height / 8), 0.0015,
               "MetalLight")


def build_defense_post():
    """A fortified outpost: barrier walls round a command bunker with a
    radio mast, two watchtowers, a tank and an APC, machine-gun nests at the
    gate, barracks and a flag in the owner's colour."""
    m = Model("DefensePost")
    base = 0.015
    m.box(0, 0, 0, 0.97, 0.97, base, "Gravel", bevel=0.006)
    half = 0.43
    gate = 0.08
    hesco_wall(m, -half, -half, -gate, -half, base)
    hesco_wall(m, gate, -half, half, -half, base)
    hesco_wall(m, half, -half, half, half, base)
    hesco_wall(m, half, half, -half, half, base)
    hesco_wall(m, -half, half, -half, -half, base)
    # Gate: a barrier arm and a guard booth.
    m.box(-0.07, -0.43, base, 0.012, 0.012, 0.03, "MetalDark")
    for k in range(6):
        m.box(-0.05 + k * 0.02, -0.43, base + 0.028, 0.02, 0.005, 0.005,
              "CarRed" if k % 2 else "CarWhite")
    m.box(0.11, -0.36, base, 0.05, 0.05, 0.055, "Sand", bevel=0.003)
    m.box(0.11, -0.3855, base + 0.03, 0.03, 0.002, 0.014, "Window")
    m.box(0.11, -0.36, base + 0.055, 0.06, 0.06, 0.006, "TeamColor")
    sandbags(m, -0.15, -0.33, base, 0.045, 200, 340)
    m.rod((-0.15, -0.33, base + 0.02), (-0.15, -0.37, base + 0.024), 0.0015,
          "Dark", 4)
    m.cylinder(-0.15, -0.33, base, base + 0.02, 0.003, "Dark", segments=6)

    # Command bunker with sandbagged roof, radio mast and a dish.
    bz = base + 0.085
    m.frustum(0, 0.2, base, bz, 0.34, 0.22, 0.3, 0.18, "ConcreteDark",
              bevel=0.006)
    m.box(0, 0.2, bz, 0.26, 0.15, 0.006, "TeamColor", bevel=0.002)
    for k in range(4):
        m.box(-0.12 + k * 0.08, 0.091, base + 0.05, 0.04, 0.006, 0.008,
              "Dark")
    m.box(0.0, 0.0895, base, 0.05, 0.004, 0.05, "MetalDark")
    hesco_wall(m, -0.06, 0.05, 0.06, 0.05, base, cell=0.04, height=0.05)
    sandbags(m, 0.07, 0.22, bz + 0.006, 0.04, 0, 360, layers=2)
    m.rod((-0.1, 0.24, bz), (-0.1, 0.24, 0.42), 0.004, "MetalDark", 6)
    for z, w in ((0.3, 0.05), (0.36, 0.035)):
        m.beam((-0.1 - w, 0.24, z), (-0.1 + w, 0.24, z), 0.003, "MetalDark")
    m.sphere(-0.1, 0.24, 0.425, 0.006, "CarRed")
    dish = translate(0.08, 0.15, bz + 0.03) @ rot_x(-35)
    m.cylinder(0, 0, -0.006, 0.006, 0.03, "MetalLight", r2=0.008,
               segments=16, m=dish)
    m.rod((0.08, 0.15, bz + 0.006), (0.08, 0.15, bz + 0.03), 0.003, "MetalDark",
          6)

    # Watchtowers at two corners.
    watchtower(m, -0.355, -0.355, base)
    watchtower(m, 0.355, 0.355, base)

    # Armour.
    tank(m, -0.19, -0.12, base, 0, 1.15, turret_rz=-15)
    apc(m, 0.2, -0.13, base, 10, 1.15)

    # Barracks containers and a generator.
    for by in (0.06, 0.16, 0.26):
        m.box(-0.33, by, base, 0.12, 0.07, 0.05, "Olive", bevel=0.003)
        m.box(-0.33, by, base + 0.05, 0.118, 0.068, 0.002, "TeamColor")
        m.box(-0.2685, by, base + 0.012, 0.003, 0.02, 0.032, "Dark")
        m.box(-0.33, by - 0.0355, base + 0.025, 0.04, 0.003, 0.012, "Window")
    military_truck(m, 0.3, 0.12, base, 180, body="generator")
    # Flagpole.
    m.rod((0.2, 0.3, base), (0.2, 0.3, 0.32), 0.0028, "MetalLight", 6)
    m.box(0.2, 0.3 + 0.032, 0.27, 0.003, 0.064, 0.042, "TeamColor")
    m.sphere(0.2, 0.3, 0.322, 0.005, "MetalLight")
    return m.to_object()


def patriot_launcher(m, x, y, z0, rz=0.0, elevation=38):
    """Trailer launcher with four missile canisters in a team-coloured box,
    raised toward -Y, and its tractor unit behind."""
    with m.at(translate(x, y, z0) @ rot_z(rz)):
        m.box(0, -0.02, 0.012, 0.07, 0.24, 0.012, "Olive")
        for wy in (0.06, 0.085):
            for side in (-1, 1):
                wheel(m, side * 0.033, wy, 0.012, 0.012, 0.01)
        for cx in (-1, 1):
            for cy in (-0.13, 0.07):
                m.box(cx * 0.042, cy, 0.0, 0.014, 0.014, 0.014, "MetalDark")
                m.beam((cx * 0.033, cy, 0.014), (cx * 0.042, cy, 0.006),
                       0.005, "MetalDark")
        # Tractor.
        m.box(0, 0.15, 0.01, 0.06, 0.06, 0.012, "Dark")
        for wy in (0.13, 0.17):
            for side in (-1, 1):
                wheel(m, side * 0.03, wy, 0.011, 0.011, 0.01)
        m.box(0, 0.16, 0.02, 0.064, 0.04, 0.034, "Olive", bevel=0.003)
        m.box(0, 0.1395, 0.034, 0.056, 0.0015, 0.014, "Window")
        # Launcher box on its hinge, struts from the bed.
        hinge = translate(0, 0.08, 0.03) @ rot_x(-elevation)
        with m.at(hinge):
            m.box(0, -0.13, 0.0, 0.08, 0.26, 0.078, "TeamColor", bevel=0.003)
            for cx in (-0.019, 0.019):
                for cz in (0.02, 0.058):
                    m.box(cx, -0.2605, cz - 0.016, 0.032, 0.002, 0.032,
                          "MetalDark")
                    m.box(cx, -0.262, cz - 0.012, 0.024, 0.002, 0.024, "Dark")
            for k in range(3):
                m.box(0, -0.04 - k * 0.08, -0.002, 0.084, 0.012, 0.082,
                      "Olive")
        strut_top = (hinge @ Vector((0, -0.16, 0.0))).to_3d()
        for side in (-1, 1):
            m.rod((side * 0.02, -0.06, 0.024),
                  (side * 0.02, strut_top.y, strut_top.z), 0.005, "MetalDark",
                  8)


def radar_trailer(m, x, y, z0):
    """Phased-array radar: an octagonal antenna face, framed in the owner's
    colour, tilted up toward -Y on an equipment trailer."""
    with m.at(translate(x, y, z0)):
        m.box(0, 0.03, 0.012, 0.09, 0.2, 0.012, "Olive")
        for wy in (0.07, 0.1):
            for side in (-1, 1):
                wheel(m, side * 0.045, wy, 0.012, 0.012, 0.01)
        m.box(0, 0.06, 0.024, 0.1, 0.1, 0.07, "Olive", bevel=0.003)
        m.box(0, 0.06, 0.094, 0.09, 0.09, 0.003, "TeamColor")
        for k in range(3):
            m.box(0.051, 0.03 + k * 0.03, 0.04, 0.002, 0.02, 0.04, "Dark")
        octagon = [(0.095 * math.cos(math.radians(22.5 + 45 * k)),
                    0.095 * math.sin(math.radians(22.5 + 45 * k)))
                   for k in range(8)]
        inner = [(px * 0.86, py * 0.86) for px, py in octagon]
        face = translate(0, -0.02, 0.12) @ rot_x(65)
        m.prism(octagon, -0.012, 0.004, "TeamColor", bevel=0.002, m=face)
        m.prism(inner, 0.004, 0.008, "Dark", m=face)
        with m.at(face):
            for k in range(-3, 4):
                m.box(k * 0.022, 0, 0.008, 0.001, 0.15, 0.0008, "MetalDark")
                m.box(0, k * 0.022, 0.008, 0.15, 0.001, 0.0008, "MetalDark")
            m.box(0, 0.088, 0.004, 0.12, 0.014, 0.01, "MetalDark")
        m.beam((0, 0.0, 0.036), (0, -0.0, 0.1), 0.02, "MetalDark")
        for side in (-1, 1):
            for cy in (-0.06, 0.11):
                m.box(side * 0.05, cy, 0.0, 0.014, 0.014, 0.012, "MetalDark")


def berm(m, x, y, z0, w, d, h, open_side="-y"):
    """A low earth berm round three sides of a w x d emplacement."""
    t = 0.035
    sides = {
        "+y": (x, y + d / 2, w + 2 * t, t),
        "-x": (x - w / 2 - t / 2, y, t, d),
        "+x": (x + w / 2 + t / 2, y, t, d),
        "-y": (x, y - d / 2, w + 2 * t, t),
    }
    for name, (bx, by, sx, sy) in sides.items():
        if name == open_side:
            continue
        m.frustum(bx, by, z0, z0 + h, sx, sy, max(sx - 0.03, 0.01),
                  max(sy - 0.03, 0.01), "Dirt", top_material="Grass")


def build_sam_launcher():
    """A surface-to-air missile battery: two trailer launchers with missile
    canisters in team-coloured boxes behind earth berms, a phased-array
    radar, a control station, a generator, an antenna mast and a fence."""
    m = Model("SAMLauncher")
    base = 0.015
    m.box(0, 0, 0, 0.97, 0.97, base, "Gravel", bevel=0.006)
    m.box(0, -0.12, base, 0.36, 0.34, 0.002, "Concrete")
    m.box(0, -0.4, base, 0.12, 0.17, 0.0015, "Asphalt")
    fence(m, 0.45, base, height=0.06, gate=0.07)
    for lx in (-0.29, 0.29):
        berm(m, lx, -0.02, base, 0.13, 0.4, 0.05, open_side="-y")
        patriot_launcher(m, lx, -0.03, base)
    radar_trailer(m, 0, -0.2, base + 0.002)
    military_truck(m, -0.07, 0.24, base, 180, body="shelter", s=1.2)
    military_truck(m, 0.09, 0.26, base, 180, body="generator", s=1.2)
    # Antenna mast with guy wires.
    ax, ay = -0.15, 0.36
    m.rod((ax, ay, base), (ax, ay, 0.42), 0.0035, "MetalDark", 6)
    for z in (0.24, 0.32, 0.4):
        m.beam((ax - 0.03, ay, z), (ax + 0.03, ay, z), 0.002, "MetalDark")
    for gx, gy in ((-0.08, 0), (0.06, 0.05), (0.0, -0.08)):
        m.rod((ax, ay, 0.3), (ax + gx, ay + gy, base), 0.0008, "MetalDark", 3)
    m.sphere(ax, ay, 0.425, 0.006, "CarRed")
    # Cables from the control station to the launchers and radar.
    for tx, ty in ((-0.29, 0.16), (0.29, 0.16), (0.0, -0.06)):
        m.beam((-0.07, 0.2, base + 0.001), (tx, ty, base + 0.001), 0.004,
               "Dark", h=0.002)
    return m.to_object()
