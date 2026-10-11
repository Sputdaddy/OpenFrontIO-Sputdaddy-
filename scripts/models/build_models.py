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
    "Gantry": ("#b4472d", 0.55, 0.3),
    "Olive": ("#5a6141", 0.7, 0.1),
    "Lamp": ("#fff3cf", 0.3, 0.0),
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

    def sphere(self, x, y, z, r, material, subdivisions=1, sz=1.0, sx=1.0,
               sy=1.0):
        matrix = translate(x, y, z) @ scale(sx, sy, sz)
        verts = bmesh.ops.create_icosphere(
            self.bm, subdivisions=subdivisions, radius=r, matrix=matrix
        )["verts"]
        self._finish(verts, material, 0.0)

    def _cube(self, matrix, material, bevel=0.0):
        verts = bmesh.ops.create_cube(self.bm, size=1.0, matrix=matrix)["verts"]
        self._finish(verts, material, bevel)

    def oriented_box(self, matrix, sx, sy, sz, material, bevel=0.0):
        """Box of size (sx, sy, sz) centred on matrix's origin."""
        self._cube(matrix @ scale(sx, sy, sz), material, bevel)

    def beam(self, p0, p1, w, material, h=None, bevel=0.0):
        """Square (w x h) bar from p0 to p1."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        rot = d.to_track_quat("Z", "Y").to_matrix().to_4x4()
        matrix = Matrix.Translation((p0 + p1) / 2) @ rot
        self._cube(matrix @ scale(w, h or w, d.length), material, bevel)

    def rod(self, p0, p1, r, material, segments=8, r2=None):
        """Cylinder (or cone, r2) from p0 to p1."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        rot = d.to_track_quat("Z", "Y").to_matrix().to_4x4()
        matrix = Matrix.Translation((p0 + p1) / 2) @ rot
        self.cylinder(0, 0, -d.length / 2, d.length / 2, r, material, r2=r2,
                      segments=segments, m=matrix)

    def frustum(self, x, y, z0, z1, sx0, sy0, sx1, sy1, material, dy1=0.0,
                top_material=None, bevel=0.0, rz=0.0):
        """Rectangular block that narrows from (sx0, sy0) at z0 to
        (sx1, sy1) at z1, its top shifted dy1 along Y."""
        def rect(sx, sy, dy, z):
            return [(-sx / 2, -sy / 2 + dy, z), (sx / 2, -sy / 2 + dy, z),
                    (sx / 2, sy / 2 + dy, z), (-sx / 2, sy / 2 + dy, z)]
        m = translate(x, y, 0) @ rot_z(rz)
        self.loft([rect(sx0, sy0, 0.0, z0), rect(sx1, sy1, dy1, z1)], [material],
                  top_material or material, material, bevel, m)

    def ring(self, x, y, z0, z1, r_in, r_out, material, segments=24,
             a0=0.0, a1=360.0):
        """Flat annulus (or an arc of one, from a0 to a1 degrees)."""
        full = abs(a1 - a0) >= 360.0
        n = segments if full else segments + 1
        pts = []
        for i in range(n):
            a = math.radians(a0 + (a1 - a0) * i / segments)
            pts.append((math.cos(a), math.sin(a)))
        bm = self.bm
        rows = [[bm.verts.new((x + c * r, y + s * r, z)) for c, s in pts]
                for r, z in ((r_out, z0), (r_out, z1), (r_in, z1), (r_in, z0))]
        steps = n if full else n - 1
        for k in range(4):
            a, b = rows[k], rows[(k + 1) % 4]
            for i in range(steps):
                j = (i + 1) % n
                bm.faces.new((a[i], a[j], b[j], b[i]))
        if not full:
            for i in (0, n - 1):
                bm.faces.new([rows[k][i] for k in range(4)])
        verts = [v for row in rows for v in row]
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
    posts = [-0.43 + i * 0.086 for i in range(11)]
    sides = [
        [(p, -0.43) for p in posts], [(0.43, p) for p in posts],
        [(p, 0.43) for p in posts], [(-0.43, p) for p in posts],
    ]
    for k, edge in enumerate(sides):
        for i, (px, py) in enumerate(edge):
            if k == 0 and abs(px) < 0.08:
                continue
            m.rod((px, py, pad), (px, py, 0.12), 0.0035, "MetalLight", 6)
            if i + 1 < len(edge):
                qx, qy = edge[i + 1]
                if k == 0 and (abs(px) < 0.08 or abs(qx) < 0.08):
                    continue
                for h in (0.085, 0.117):
                    m.beam((px, py, h), (qx, qy, h), 0.0025, "MetalLight")
    m.box(0.13, -0.39, pad, 0.05, 0.05, 0.06, "Facade", bevel=0.003)
    m.box(0.13, -0.39, pad + 0.035, 0.052, 0.052, 0.014, "Window")
    m.box(0.13, -0.39, pad + 0.06, 0.06, 0.06, 0.006, "MetalDark")
    m.box(0.06, -0.43, pad, 0.008, 0.008, 0.03, "MetalDark")
    m.box(0.0, -0.43, pad + 0.026, 0.12, 0.005, 0.006, "Hazard")
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

    # One close-up per model.
    shots = {
        "city": ((0.9, -1.25, 1.05), (0, 0, 0.22), PREVIEW_TEAMS[0], 0),
        "warship": ((0.75, -0.95, 0.6), (0, -0.02, 0.08), PREVIEW_TEAMS[1], 25),
        "missile_silo": ((0.8, -1.1, 0.9), (0, 0, 0.12), PREVIEW_TEAMS[2], 0),
    }
    for key, (cam, target, team, rz) in shots.items():
        if key not in models:
            continue
        setup_scene(1400, 1000, samples=64)
        plane("Ground", "#d8d2c4", 0, 0, 12, 8)
        tinted_copy(models[key], team, (0, 0, 0.04 if key == "warship" else 0),
                    rz=rz)
        add_camera(cam, target, lens=50)
        render(os.path.join(out_dir, f"model-{key}.png"))
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
