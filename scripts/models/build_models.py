"""Builds the 3D map's unit and structure models as .glb files.

Every model is generated from code here, so it can be rebuilt or tweaked
without hand-editing in Blender (though any .glb can be opened, edited or
replaced in Blender too, as long as it keeps the conventions below).

Run with Blender's Python module or with Blender itself:

    pip install bpy
    python scripts/models/build_models.py --out resources/models [--render DIR]

    blender --background --python scripts/models/build_models.py -- \
        --out resources/models [--render DIR]

--render also writes preview images (a close-up row and a map-scale view).

Conventions the 3D map relies on:
- Structures fit a 1x1 footprint centred on the origin; ships are 1 long.
  The game scales them to tiles.
- The ground (or the waterline, for ships) is at z = 0, z is up.
- Ships point their bow toward -Y in Blender, which is +Z in glTF/three.js.
- Parts drawn in the owner's colour use a material whose name starts with
  "Team". The game multiplies its colour by the owner's colour, so
  "TeamColor" (white) shows the owner's colour as is and a grey one such as
  "TeamDeck" shows a darker shade of it. Every other material keeps its
  colour.
"""

import argparse
import math
import os
import sys

import bpy  # must come first: it makes bmesh and mathutils importable
import bmesh
from mathutils import Matrix, Vector

# ---------------------------------------------------------------------------
# Materials

# name: (colour, roughness, metallic)
PALETTE = {
    "TeamColor": ("#ffffff", 0.7, 0.0),
    "TeamDeck": ("#d4d4d4", 0.75, 0.0),
    "TeamGlass": ("#a4a4a4", 0.25, 0.35),
    "Facade": ("#dcdad4", 0.8, 0.0),
    "FacadeWarm": ("#c9b9a3", 0.85, 0.0),
    "Window": ("#2f3d4b", 0.25, 0.2),
    "Asphalt": ("#4a4f56", 0.9, 0.0),
    "Sidewalk": ("#c7c3ba", 0.9, 0.0),
    "Marking": ("#efeee8", 0.8, 0.0),
    "Grass": ("#76a352", 0.95, 0.0),
    "Water": ("#4f8fbf", 0.15, 0.0),
    "Foliage": ("#4f8a3c", 0.9, 0.0),
    "Trunk": ("#6b5544", 0.9, 0.0),
    "MetalLight": ("#c4c9cd", 0.5, 0.3),
    "MetalDark": ("#5c636b", 0.55, 0.3),
    "Concrete": ("#b5afa5", 0.9, 0.0),
    "ConcreteDark": ("#8b867e", 0.9, 0.0),
    "Hazard": ("#e8b52c", 0.7, 0.0),
    "Dark": ("#262b31", 0.6, 0.0),
    "Missile": ("#ebebe7", 0.5, 0.0),
    "CarRed": ("#c23b32", 0.4, 0.2),
    "CarWhite": ("#e9eaec", 0.4, 0.2),
    "CarYellow": ("#e6b422", 0.4, 0.2),
    "CarBlue": ("#2f4f7f", 0.4, 0.2),
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_linear(hexstr):
    h = hexstr.lstrip("#")
    return tuple(srgb_to_linear(int(h[i : i + 2], 16) / 255) for i in (0, 2, 4))


def make_material(name, hexstr, roughness=0.8, metallic=0.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*hex_to_linear(hexstr), 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    mat.diffuse_color = (*hex_to_linear(hexstr), 1.0)
    return mat


# ---------------------------------------------------------------------------
# Mesh building: every model is one bmesh, one object, one material per part.


def translate(x, y, z):
    return Matrix.Translation((x, y, z))


def rot_x(deg):
    return Matrix.Rotation(math.radians(deg), 4, "X")


def rot_y(deg):
    return Matrix.Rotation(math.radians(deg), 4, "Y")


def rot_z(deg):
    return Matrix.Rotation(math.radians(deg), 4, "Z")


def scale(x, y, z):
    return Matrix.Diagonal((x, y, z, 1.0))


# Maps a prism built along local Z with its profile in local XY onto one
# extruded along world X with the profile in world YZ (for gable roofs).
ALONG_X = Matrix(((0, 0, 1, 0), (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


class Model:
    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.materials = []

    def _material_index(self, name):
        if name not in self.materials:
            self.materials.append(name)
        return self.materials.index(name)

    def _finish(self, verts, material, bevel, faces_material=None):
        faces = {f for v in verts for f in v.link_faces}
        index = self._material_index(material)
        for f in faces:
            f.material_index = index
        if faces_material:
            for f, name in faces_material:
                f.material_index = self._material_index(name)
        if bevel > 0:
            edges = {e for v in verts for e in v.link_edges}
            sharp = [
                e
                for e in edges
                if e.is_manifold and e.calc_face_angle(0) > math.radians(40)
            ]
            if sharp:
                bmesh.ops.bevel(
                    self.bm,
                    geom=sharp,
                    offset=bevel,
                    offset_type="OFFSET",
                    segments=1,
                    profile=0.5,
                    affect="EDGES",
                    clamp_overlap=True,
                )

    def box(self, x, y, z0, sx, sy, sz, material, rz=0.0, bevel=0.0, m=None):
        """Box with its base centred on (x, y, z0)."""
        matrix = (m or Matrix()) @ translate(x, y, z0 + sz / 2) @ rot_z(rz)
        matrix = matrix @ scale(sx, sy, sz)
        verts = bmesh.ops.create_cube(self.bm, size=1.0, matrix=matrix)["verts"]
        self._finish(verts, material, bevel)

    def cylinder(
        self, x, y, z0, z1, r1, material, r2=None, segments=12, rz=0.0,
        sx=1.0, sy=1.0, bevel=0.0, m=None,
    ):
        """Cylinder or cone (r2) standing on (x, y, z0), up to z1."""
        r2 = r1 if r2 is None else r2
        matrix = (m or Matrix()) @ translate(x, y, (z0 + z1) / 2) @ rot_z(rz)
        matrix = matrix @ scale(sx, sy, 1.0)
        verts = bmesh.ops.create_cone(
            self.bm,
            cap_ends=True,
            cap_tris=False,
            segments=segments,
            radius1=r1,
            radius2=r2,
            depth=z1 - z0,
            matrix=matrix,
        )["verts"]
        self._finish(verts, material, bevel)

    def loft(self, rings, side_materials, top_material, bottom_material,
             bevel=0.0, m=None):
        """Closed solid through rings of 3D points (same count, CCW from
        above, bottom ring first). side_materials[i] colours the band
        between ring i and ring i + 1."""
        matrix = m or Matrix()
        vert_rings = [
            [self.bm.verts.new(matrix @ Vector(p)) for p in ring] for ring in rings
        ]
        n = len(rings[0])
        tagged = []
        for i in range(len(vert_rings) - 1):
            lo, hi = vert_rings[i], vert_rings[i + 1]
            for j in range(n):
                k = (j + 1) % n
                f = self.bm.faces.new((lo[j], lo[k], hi[k], hi[j]))
                tagged.append((f, side_materials[i]))
        tagged.append((self.bm.faces.new(vert_rings[-1]), top_material))
        tagged.append((self.bm.faces.new(list(reversed(vert_rings[0]))), bottom_material))
        verts = [v for ring in vert_rings for v in ring]
        self._finish(verts, side_materials[0], bevel, tagged)

    def prism(self, poly, z0, z1, material, bevel=0.0, m=None):
        """Polygon (2D points, CCW) extruded from z0 to z1."""
        rings = [[(x, y, z0) for x, y in poly], [(x, y, z1) for x, y in poly]]
        self.loft(rings, [material], material, material, bevel, m)

    def gable_roof(self, x, y, z0, length, width, height, material, rz=0.0,
                   bevel=0.0):
        """Gable roof whose ridge runs along X (before rz), eaves at z0."""
        profile = [(-width / 2, 0.0), (width / 2, 0.0), (0.0, height)]
        m = translate(x, y, z0) @ rot_z(rz) @ ALONG_X
        self.prism(profile, -length / 2, length / 2, material, bevel, m)

    def pyramid_roof(self, x, y, z0, side, height, material, rz=0.0):
        r = side / math.sqrt(2)
        self.cylinder(x, y, z0, z0 + height, r, material, r2=0.0, segments=4,
                      rz=45 + rz)

    def sphere(self, x, y, z, r, material, subdivisions=1, sz=1.0):
        matrix = translate(x, y, z) @ scale(1.0, 1.0, sz)
        verts = bmesh.ops.create_icosphere(
            self.bm, subdivisions=subdivisions, radius=r, matrix=matrix
        )["verts"]
        self._finish(verts, material, 0.0)

    def to_object(self):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for name in self.materials:
            mesh.materials.append(bpy.data.materials[name])
        for poly in mesh.polygons:
            poly.use_smooth = False
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj


# ---------------------------------------------------------------------------
# Models


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
    m.box(x, y, z, sx - 0.014, sy - 0.014, 0.004, "TeamColor")
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


def car(m, x, y, z, rz, paint):
    m.box(x, y, z + 0.003, 0.042, 0.02, 0.011, paint, rz=rz, bevel=0.003)
    m.box(x, y, z + 0.014, 0.022, 0.017, 0.008, "Window", rz=rz, bevel=0.002)


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
    m.cylinder(-0.3, 0.3, z, z + 0.01, 0.07, "TeamColor", segments=24)
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


def turret(m, y, z, facing, raised=0.0):
    """Twin-gun turret on the centreline at (0, y), base at z. facing is
    -1 for the bow (-Y), +1 for the stern."""
    if raised > 0:
        m.cylinder(0, y, z, z + raised, 0.042, "MetalDark", segments=12)
        z += raised
    m.cylinder(0, y, z, z + 0.012, 0.038, "MetalDark", segments=12)
    z += 0.012
    housing = [(-0.034, -0.03), (0.034, -0.03), (0.034, 0.04), (-0.034, 0.04)]
    housing = [(px, py * -facing) for px, py in housing]
    if facing > 0:
        housing = list(reversed(housing))
    shift = translate(0, y, 0)
    m.prism(housing, z, z + 0.032, "MetalLight", bevel=0.008, m=shift)
    for bx in (-0.014, 0.014):
        start = y + facing * 0.025
        length = 0.085
        matrix = translate(bx, start + facing * length / 2, z + 0.016)
        matrix = matrix @ rot_x(90)
        m.cylinder(0, 0, -length / 2, length / 2, 0.0055, "MetalDark",
                   segments=6, m=matrix)


def build_warship():
    m = Model("Warship")
    # Hull outline from the bow (-Y) round the starboard side to the stern
    # and back up the port side (counter-clockwise seen from above).
    starboard = [
        (0.0, -0.5), (0.035, -0.43), (0.068, -0.32), (0.09, -0.18),
        (0.1, -0.02), (0.1, 0.3), (0.092, 0.42), (0.074, 0.5),
    ]
    outline = starboard + [(-x, y) for x, y in reversed(starboard) if x != 0.0]

    def sheer(y):
        # Deck rises toward the bow.
        return 0.02 * max(0.0, (-y - 0.15) / 0.35)

    bottom = [(x * 0.5, y * 0.88, -0.045) for x, y in outline]
    waterline = [(x * 0.96, y * 0.99, 0.012) for x, y in outline]
    deck = [(x, y, 0.065 + sheer(y)) for x, y in outline]
    m.loft([bottom, waterline, deck], ["MetalDark", "TeamColor"], "TeamDeck",
           "MetalDark")

    # Superstructure, stepping up to the bridge.
    m.box(0, 0.02, 0.065, 0.13, 0.27, 0.05, "MetalLight", bevel=0.006)
    m.box(0, -0.05, 0.115, 0.1, 0.14, 0.04, "MetalLight", bevel=0.006)
    m.box(0, -0.085, 0.155, 0.085, 0.07, 0.04, "MetalLight", bevel=0.005)
    m.box(0, -0.087, 0.172, 0.089, 0.072, 0.013, "Dark")
    # Mast with a yard and radar.
    m.cylinder(0, -0.06, 0.195, 0.33, 0.005, "MetalDark", segments=6)
    m.box(0, -0.06, 0.29, 0.08, 0.007, 0.007, "MetalDark")
    m.box(0, -0.06, 0.33, 0.035, 0.012, 0.012, "MetalDark")
    # Funnel with a team-colour band.
    m.cylinder(0, 0.075, 0.115, 0.19, 0.034, "MetalLight", segments=12,
               sx=0.75, bevel=0.004)
    m.cylinder(0, 0.075, 0.19, 0.225, 0.036, "TeamColor", segments=12,
               sx=0.75)
    m.cylinder(0, 0.075, 0.225, 0.229, 0.03, "Dark", segments=12, sx=0.75)

    turret(m, -0.3, 0.065 + sheer(-0.3), -1)
    turret(m, -0.185, 0.065 + sheer(-0.185), -1, raised=0.03)
    turret(m, 0.31, 0.065, 1)
    return m.to_object()


def build_missile_silo():
    m = Model("MissileSilo")
    m.box(0, 0, 0.0, 0.9, 0.9, 0.05, "Concrete", bevel=0.02)
    # Painted hazard ring round the silo.
    m.cylinder(0, 0, 0.05, 0.053, 0.32, "Hazard", segments=24)
    m.cylinder(0, 0, 0.05, 0.055, 0.28, "Concrete", segments=24)
    # Collar and the open shaft.
    m.cylinder(0, 0, 0.05, 0.1, 0.24, "ConcreteDark", segments=20, bevel=0.01)
    m.cylinder(0, 0, 0.1, 0.12, 0.24, "TeamColor", segments=20, bevel=0.006)
    m.cylinder(0, 0, 0.12, 0.1215, 0.19, "Dark", segments=20)
    # The missile, nose up out of the shaft.
    m.cylinder(0, 0, 0.1, 0.21, 0.075, "Missile", segments=12)
    m.cylinder(0, 0, 0.21, 0.235, 0.075, "TeamColor", segments=12)
    m.cylinder(0, 0, 0.235, 0.34, 0.075, "Missile", r2=0.0, segments=12)
    # Blast doors swung open either side of the shaft.
    for side in (-1, 1):
        hinge = translate(side * 0.21, 0, 0.12) @ rot_y(side * 105)
        m.box(-side * 0.1, 0, 0.0, 0.2, 0.36, 0.03, "TeamColor", bevel=0.008,
              m=hinge)
        m.box(-side * 0.1, 0, 0.03, 0.04, 0.3, 0.012, "MetalDark", m=hinge)
    # Control bunker with an antenna and dish.
    m.box(0.3, 0.31, 0.05, 0.2, 0.14, 0.08, "ConcreteDark", bevel=0.015)
    m.cylinder(0.36, 0.33, 0.13, 0.26, 0.005, "MetalDark", segments=6)
    dish = translate(0.25, 0.3, 0.17) @ rot_x(-40)
    m.cylinder(0, 0, -0.012, 0.012, 0.045, "MetalLight", r2=0.012,
               segments=12, m=dish)
    m.cylinder(0.25, 0.3, 0.13, 0.16, 0.008, "MetalDark", segments=6)
    # Fuel tanks lying along the west edge.
    for ty in (0.22, 0.34):
        tank = translate(-0.3, ty, 0.095) @ rot_y(90)
        m.cylinder(0, 0, -0.11, 0.11, 0.045, "MetalLight", segments=12,
                   bevel=0.008, m=tank)
    # Corner bollards.
    for bx, by in ((-0.4, -0.4), (0.4, -0.4), (-0.4, 0.4)):
        m.cylinder(bx, by, 0.05, 0.1, 0.018, "Hazard", segments=8)
    return m.to_object()


BUILDERS = {
    "city": build_city,
    "warship": build_warship,
    "missile_silo": build_missile_silo,
}


# ---------------------------------------------------------------------------
# Export


def export_glb(obj, path):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
    )


# ---------------------------------------------------------------------------
# Preview renders (Cycles on the CPU, so they work headless)

PREVIEW_TEAMS = ["#4a7fd4", "#d64545", "#4caf50", "#9b59d0", "#e8913a"]


def tinted_copy(obj, team_hex, location, rz=0.0, s=1.0):
    """Copy of a model with its Team* materials tinted the way the game
    does it: material colour times the owner's colour."""
    copy = obj.copy()
    copy.data = obj.data.copy()
    team = hex_to_linear(team_hex)
    for i, mat in enumerate(copy.data.materials):
        if not mat.name.startswith("Team"):
            continue
        name = f"Owner {mat.name} {team_hex}"
        tinted = bpy.data.materials.get(name)
        if tinted is None:
            hexstr, roughness, metallic = PALETTE[mat.name]
            base = hex_to_linear(hexstr)
            tinted = make_material(name, "#ffffff", roughness, metallic)
            color = tuple(b * t for b, t in zip(base, team))
            bsdf = tinted.node_tree.nodes.get("Principled BSDF")
            bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        copy.data.materials[i] = tinted
    copy.location = location
    copy.rotation_euler = (0, 0, math.radians(rz))
    copy.scale = (s, s, s)
    copy.hide_render = False
    bpy.context.scene.collection.objects.link(copy)
    return copy


def plane(name, hexstr, x, y, sx, sy, z=0.0):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=0.5,
                          matrix=translate(x, y, z) @ scale(sx, sy, 1))
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(make_material(name, hexstr, roughness=0.9))
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def setup_scene(width, height, samples=96):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (*hex_to_linear("#c9d6e3"), 1.0)
    bg.inputs["Strength"].default_value = 0.55

    sun_data = bpy.data.lights.get("Sun") or bpy.data.lights.new("Sun", "SUN")
    sun_data.energy = 2.6
    sun_data.angle = math.radians(6)
    sun = bpy.data.objects.get("Sun") or bpy.data.objects.new("Sun", sun_data)
    if sun.name not in scene.collection.objects:
        scene.collection.objects.link(sun)
    # Light from the north-west, like the map's relief shading.
    sun.rotation_euler = (math.radians(48), 0, math.radians(-135))
    return scene


def add_camera(location, target, lens=50.0, ortho_scale=None):
    data = bpy.data.cameras.new("Camera")
    if ortho_scale:
        data.type = "ORTHO"
        data.ortho_scale = ortho_scale
    data.lens = lens
    cam = bpy.data.objects.new("Camera", data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = location
    direction = Vector(target) - Vector(location)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam


def clear_preview_objects(keep):
    for obj in list(bpy.context.scene.collection.objects):
        if obj not in keep:
            bpy.data.objects.remove(obj, do_unlink=True)


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def render_previews(models, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    for obj in models.values():
        obj.hide_render = True
    keep = set(models.values())

    # Close-up row.
    setup_scene(1800, 700)
    plane("Ground", "#d8d2c4", 0, 0, 12, 8)
    tinted_copy(models["city"], PREVIEW_TEAMS[0], (-1.35, 0, 0))
    tinted_copy(models["warship"], PREVIEW_TEAMS[1], (0, 0, 0.04), rz=-35, s=1.5)
    tinted_copy(models["missile_silo"], PREVIEW_TEAMS[2], (1.35, 0, 0))
    add_camera((0, -5.4, 4.0), (0, 0.05, 0.2), lens=58)
    render(os.path.join(out_dir, "models-closeup.png"))
    clear_preview_objects(keep)

    # Map scale: small, many owners, seen through a tilted game camera.
    setup_scene(1600, 900, samples=64)
    plane("Land", "#b7bd86", 0, 4, 30, 8)
    plane("Water", "#3e78a6", 0, -4, 30, 8, z=-0.01)
    land = [
        ("city", 0, (-3.2, 1.6)), ("city", 1, (-0.4, 2.8)),
        ("city", 2, (2.6, 1.4)), ("city", 3, (5.2, 3.0)),
        ("missile_silo", 0, (-1.8, 3.6)), ("missile_silo", 2, (3.9, 3.2)),
        ("city", 4, (-5.6, 3.2)), ("missile_silo", 1, (1.0, 1.2)),
    ]
    for key, team, (x, y) in land:
        tinted_copy(models[key], PREVIEW_TEAMS[team], (x, y, 0), s=0.9)
    sea = [
        (0, (-3.0, -1.6), 20), (1, (-0.8, -2.4), -60), (2, (1.8, -1.2), 75),
        (3, (4.0, -2.6), 160), (4, (-5.2, -2.8), 110), (1, (2.8, -3.6), -20),
    ]
    for team, (x, y), rz in sea:
        tinted_copy(models["warship"], PREVIEW_TEAMS[team], (x, y, 0.0), rz=rz,
                    s=1.2)
    add_camera((0, -9.5, 11.0), (0, 0.6, 0), lens=42)
    render(os.path.join(out_dir, "models-map-scale.png"))
    clear_preview_objects(keep)


# ---------------------------------------------------------------------------


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="directory for the .glb files")
    parser.add_argument("--render", help="directory for preview renders")
    parser.add_argument("--only", nargs="*", help="model keys to build")
    args = parser.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    for name, (hexstr, roughness, metallic) in PALETTE.items():
        make_material(name, hexstr, roughness, metallic)

    os.makedirs(args.out, exist_ok=True)
    models = {}
    for key, build in BUILDERS.items():
        if args.only and key not in args.only:
            continue
        obj = build()
        path = os.path.join(args.out, key + ".glb")
        export_glb(obj, path)
        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        print(f"{key}: {tris} triangles -> {path}")
        models[key] = obj

    if args.render:
        render_previews(models, args.render)


if __name__ == "__main__":
    main()
