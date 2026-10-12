"""Shared kit for the model builders: materials, transforms and Model, a
bmesh-based mesh builder. See build_models.py for the conventions."""

import math
from contextlib import contextmanager

import bpy  # must come first: it makes bmesh and mathutils importable
import bmesh
from mathutils import Matrix, Vector

# ---------------------------------------------------------------------------
# Materials

# name: (colour, roughness, metallic[, emission strength])
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
    "Cladding": ("#aab2ba", 0.6, 0.2),
    "CladdingDark": ("#6d757d", 0.6, 0.2),
    "ContainerRed": ("#a63a2d", 0.65, 0.1),
    "ContainerBlue": ("#2d5a8a", 0.65, 0.1),
    "ContainerGreen": ("#3d7550", 0.65, 0.1),
    "ContainerOrange": ("#d07a2c", 0.65, 0.1),
    "ContainerGrey": ("#8b929a", 0.65, 0.1),
    "ContainerTeal": ("#2e8487", 0.65, 0.1),
    "Sand": ("#c7b289", 0.95, 0.0),
    "SandDark": ("#a39071", 0.95, 0.0),
    "Gravel": ("#a29d93", 0.95, 0.0),
    "Dirt": ("#8c7a5d", 0.95, 0.0),
    "HullRed": ("#8a3029", 0.7, 0.0),
    "Orange": ("#e2702a", 0.5, 0.0),
    "Rail": ("#8a8c8f", 0.35, 0.7),
    "Sleeper": ("#5d5148", 0.9, 0.0),
    "Flame": ("#ffa94d", 0.5, 0.0, 6.0),
    "Tracer": ("#ffe28a", 0.5, 0.0, 10.0),
}


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_linear(hexstr):
    h = hexstr.lstrip("#")
    return tuple(srgb_to_linear(int(h[i : i + 2], 16) / 255) for i in (0, 2, 4))


def make_material(name, hexstr, roughness=0.8, metallic=0.0, emission=0.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    color = (*hex_to_linear(hexstr), 1.0)
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    if emission > 0:
        # Exhaust flames and tracers glow (exported as emissive).
        bsdf.inputs["Emission Color"].default_value = color
        bsdf.inputs["Emission Strength"].default_value = emission
    mat.diffuse_color = color
    return mat


def make_palette():
    for name, (hexstr, *rest) in PALETTE.items():
        make_material(name, hexstr, *rest)


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
        # Applied to everything added; see at().
        self.base = Matrix()

    @contextmanager
    def at(self, matrix):
        """Adds everything inside the block in matrix's frame, so a prop
        (a truck, a crane) can be built once and placed anywhere."""
        outer = self.base
        self.base = outer @ matrix
        try:
            yield
        finally:
            self.base = outer

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
        matrix = self.base @ (m or Matrix()) @ translate(x, y, z0 + sz / 2)
        matrix = matrix @ rot_z(rz)
        matrix = matrix @ scale(sx, sy, sz)
        verts = bmesh.ops.create_cube(self.bm, size=1.0, matrix=matrix)["verts"]
        self._finish(verts, material, bevel)

    def cylinder(
        self, x, y, z0, z1, r1, material, r2=None, segments=12, rz=0.0,
        sx=1.0, sy=1.0, bevel=0.0, m=None,
    ):
        """Cylinder or cone (r2) standing on (x, y, z0), up to z1."""
        r2 = r1 if r2 is None else r2
        matrix = self.base @ (m or Matrix()) @ translate(x, y, (z0 + z1) / 2)
        matrix = matrix @ rot_z(rz)
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
        matrix = self.base @ (m or Matrix())
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

    def extrude_x(self, profile, x0, x1, material, bevel=0.0):
        """Polygon in the YZ plane ((y, z) points) extruded from x0 to x1:
        roof profiles, ramps and the like."""
        rings = [[(x, y, z) for y, z in profile] for x in (x0, x1)]
        self.loft(rings, [material], material, material, bevel)

    def revolve(self, profile, materials, segments=16, m=None):
        """Solid of revolution about the Y axis (missiles, chimneys lying
        down). profile is (y, r) pairs from one end to the other, every
        r > 0; materials[i] colours the band from profile[i] to
        profile[i + 1], or one name colours it all."""
        if isinstance(materials, str):
            materials = [materials] * (len(profile) - 1)
        angles = [2 * math.pi * i / segments for i in range(segments)]
        rings = [[(r * math.cos(a), y, r * math.sin(a)) for a in angles]
                 for y, r in profile]
        self.loft(rings, materials, materials[-1], materials[0], m=m)

    def prism(self, poly, z0, z1, material, bevel=0.0, m=None):
        """Polygon (2D points, CCW) extruded from z0 to z1."""
        rings = [[(x, y, z0) for x, y in poly], [(x, y, z1) for x, y in poly]]
        self.loft(rings, [material], material, material, bevel, m)

    def sphere(self, x, y, z, r, material, subdivisions=1, sz=1.0, sx=1.0,
               sy=1.0):
        matrix = self.base @ translate(x, y, z) @ scale(sx, sy, sz)
        verts = bmesh.ops.create_icosphere(
            self.bm, subdivisions=subdivisions, radius=r, matrix=matrix
        )["verts"]
        self._finish(verts, material, 0.0)

    def _cube(self, matrix, material, bevel=0.0):
        verts = bmesh.ops.create_cube(self.bm, size=1.0,
                                      matrix=self.base @ matrix)["verts"]
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
        rows = [[bm.verts.new(self.base @ Vector((x + c * r, y + s * r, z)))
                 for c, s in pts]
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

