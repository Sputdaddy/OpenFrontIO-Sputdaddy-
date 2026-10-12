"""Builds the 3D map's unit and structure models as .gltf files.

Every model is generated from code here, so it can be rebuilt or tweaked
without hand-editing in Blender (though any .gltf can be opened, edited or
replaced in Blender too, as long as it keeps the conventions below).

Run with Blender's Python module or with Blender itself:

    pip install bpy
    python scripts/models/build_models.py --out resources/models \
        [--only KEY ...] [--render DIR [--groups]] [--textures] [--plain]

    blender --background --python scripts/models/build_models.py -- \
        --out resources/models [--render DIR]

--render also writes preview images: a close-up of each model, groups of
structures, ships and missiles, and (when building everything) a
map-scale view. --groups skips the close-ups.

The models live in structures.py, ships.py, vehicles.py (train cars and the
props parked on structures and ships) and missiles.py, built with kit.py.
Their surfaces (concrete, steel plating, glass, roofs...) are textures made
from code in textures.py and shared by every model from <out>/textures;
they are generated when missing, or every time with --textures. --plain
builds the models without them, for before-and-after comparisons.

Conventions the 3D map relies on:
- Structures fit a 1x1 footprint centred on the origin; anything that moves
  is 1 long. The game scales them to tiles (UNIT_MODELS in UnitModels.ts).
- The ground (or the waterline, for ships, or the rails, for trains) is at
  z = 0, z is up. Missiles and shells are centred on the origin.
- Anything that moves points its nose toward -Y in Blender, which is +Z in
  glTF/three.js. So does a port's quay: the game turns it to the sea.
- Parts drawn in the owner's colour use a material whose name starts with
  "Team". The game multiplies its colour by the owner's colour, so
  "TeamColor" (white) shows the owner's colour as is and a grey one such as
  "TeamDeck" shows a darker shade of it. Every other material keeps its
  colour. Emissive materials (exhaust flames, tracers) cast no shadow.
"""

import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402  (must come before anything that imports bmesh)

import kit  # noqa: E402
from kit import (PALETTE, SURFACES, hex_to_linear, make_material,  # noqa: E402
                 make_palette, scale, translate)
import missiles  # noqa: E402
import ships  # noqa: E402
import structures  # noqa: E402
import textures  # noqa: E402
import vehicles  # noqa: E402

import bmesh  # noqa: E402
from mathutils import Vector  # noqa: E402

# key: (builder, kind). kind says how previews stand it: on the ground, on
# the water or in the air.
BUILDERS = {
    "city": (structures.build_city, "structure"),
    "missile_silo": (structures.build_missile_silo, "structure"),
    "port": (structures.build_port, "structure"),
    "factory": (structures.build_factory, "structure"),
    "defense_post": (structures.build_defense_post, "structure"),
    "sam_launcher": (structures.build_sam_launcher, "structure"),
    "warship": (ships.build_warship, "ship"),
    "transport": (ships.build_transport, "ship"),
    "trade_ship": (ships.build_trade_ship, "ship"),
    "train_engine": (vehicles.build_train_engine, "train"),
    "train_car": (lambda: vehicles.build_train_car(False), "train"),
    "train_car_loaded": (lambda: vehicles.build_train_car(True), "train"),
    "atom_bomb": (missiles.build_atom_bomb, "air"),
    "hydrogen_bomb": (missiles.build_hydrogen_bomb, "air"),
    "mirv": (missiles.build_mirv, "air"),
    "mirv_warhead": (missiles.build_mirv_warhead, "air"),
    "sam_missile": (missiles.build_sam_missile, "air"),
    "shell": (missiles.build_shell, "air"),
}

# Size in tiles on the map (keep in step with UNIT_MODELS in
# src/client/render/three/UnitModels.ts), for the map-scale preview.
MAP_SIZES = {
    "city": 9, "missile_silo": 9, "port": 9, "factory": 9, "defense_post": 7,
    "sam_launcher": 9, "warship": 11, "transport": 6, "trade_ship": 10,
    "train_engine": 2, "train_car": 2, "train_car_loaded": 2, "atom_bomb": 6,
    "hydrogen_bomb": 8, "mirv": 11, "mirv_warhead": 2.5, "sam_missile": 3,
    "shell": 1.2,
}


# ---------------------------------------------------------------------------
# Export


def export_gltf(obj, path):
    """Writes path (.gltf) and its .bin. The texture images are shared by
    every model, so they stay in textures/ next to them rather than being
    copied into each file."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLTF_SEPARATE",
        export_keep_originals=True,
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
            hexstr, roughness, metallic = PALETTE[mat.name][:3]
            base = hex_to_linear(hexstr)
            color = tuple(b * t for b, t in zip(base, team))
            surface = SURFACES.get(mat.name, (None,))[0]
            tinted = make_material(name, "#ffffff", roughness, metallic,
                                   surface=surface, linear=color)
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


def lift(kind):
    """How high a model of this kind stands above the preview ground."""
    return {"ship": 0.04, "air": 0.45}.get(kind, 0.0)


def bounds(obj):
    corners = [Vector(c) for c in obj.bound_box]
    lo = Vector(tuple(min(c[i] for c in corners) for i in range(3)))
    hi = Vector(tuple(max(c[i] for c in corners) for i in range(3)))
    return lo, hi


def render_closeup(key, obj, kind, team, out_dir):
    setup_scene(1400, 1000, samples=64)
    plane("Ground", "#d8d2c4", 0, 0, 12, 8)
    rz = 25 if kind in ("ship", "air", "train") else 0
    tinted_copy(obj, team, (0, 0, lift(kind)), rz=rz)
    lo, hi = bounds(obj)
    centre = (lo + hi) / 2
    centre.z += lift(kind)
    radius = max((hi - lo).length / 2, 0.15)
    direction = Vector((0.55, -0.85, 0.62)).normalized()
    add_camera(tuple(centre + direction * radius * 3.1), tuple(centre),
               lens=50)
    render(os.path.join(out_dir, f"model-{key}.png"))


def render_group(models, keys, path, spacing=1.35, row=4):
    """The given models side by side in rows, close up."""
    keys = [k for k in keys if k in models]
    if not keys:
        return
    setup_scene(1800, 1000)
    plane("Ground", "#d8d2c4", 0, 0, 20, 14)
    cols = min(row, len(keys))
    rows = (len(keys) + row - 1) // row
    for i, key in enumerate(keys):
        obj, kind = models[key]
        cx = (i % row - (cols - 1) / 2) * spacing
        cy = (rows - 1) / 2 * spacing - (i // row) * spacing
        rz = -35 if kind == "ship" else (-60 if kind in ("air", "train") else 0)
        tinted_copy(obj, PREVIEW_TEAMS[i % len(PREVIEW_TEAMS)],
                    (cx, cy, lift(kind)), rz=rz)
    w = cols * spacing
    add_camera((0, -w * 1.05 - rows * 0.6, w * 0.8 + rows * 0.5),
               (0, 0.0, 0.15), lens=50)
    render(path)


def render_map_scale(models, path):
    """Everything at its size on the map, many owners, seen through a
    tilted game-like camera."""
    setup_scene(1800, 1000, samples=64)
    plane("Land", "#b7bd86", 0, 4, 40, 8)
    plane("Water", "#3e78a6", 0, -4, 40, 8, z=-0.01)

    def put(key, team, x, y, rz=0.0, z=None):
        if key not in models:
            return
        obj, kind = models[key]
        s = MAP_SIZES[key] / 10
        tinted_copy(obj, PREVIEW_TEAMS[team % len(PREVIEW_TEAMS)],
                    (x, y, lift(kind) * 3 if z is None else z), rz=rz, s=s)

    land = ["city", "port", "factory", "missile_silo", "defense_post",
            "sam_launcher", "city", "factory"]
    for i, key in enumerate(land):
        x = -6.3 + i * 1.8
        put(key, i, x, 0.75 if key != "port" else 0.5)
    for i, key in enumerate(["warship", "transport", "trade_ship", "warship",
                             "trade_ship", "transport"]):
        put(key, i + 2, -5.5 + i * 2.2, -1.4 - 0.5 * (i % 2), rz=70 + i * 25)
    # A train running along the back.
    put("train_engine", 1, -4.0, 2.4, rz=90)
    for k in range(5):
        key = "train_car_loaded" if k % 2 == 0 else "train_car"
        put(key, 1, -4.0 + 0.2 * (k + 1), 2.4, rz=90)
    put("train_engine", 1, -4.0 + 0.2 * 6, 2.4, rz=270)
    for i, key in enumerate(["atom_bomb", "hydrogen_bomb", "mirv",
                             "sam_missile", "mirv_warhead", "shell"]):
        put(key, i, 0.8 + i * 1.1, 2.4 - (i % 2) * 0.5, rz=100 + i * 10,
            z=1.6)
    add_camera((0, -10.5, 11.0), (0, 0.5, 0), lens=42)
    render(path)


def render_previews(models, out_dir, closeups=True):
    """models: key -> (object, kind)."""
    os.makedirs(out_dir, exist_ok=True)
    for obj, _ in models.values():
        obj.hide_render = True
    keep = {obj for obj, _ in models.values()}
    for i, (key, (obj, kind)) in enumerate(models.items()):
        if not closeups:
            break
        render_closeup(key, obj, kind, PREVIEW_TEAMS[i % len(PREVIEW_TEAMS)],
                       out_dir)
        clear_preview_objects(keep)
    groups = {
        "structures": ["city", "missile_silo", "port", "factory",
                       "defense_post", "sam_launcher"],
        "ships": ["warship", "transport", "trade_ship", "train_engine",
                  "train_car", "train_car_loaded"],
        "missiles": ["atom_bomb", "hydrogen_bomb", "mirv", "mirv_warhead",
                     "sam_missile", "shell"],
    }
    for name, keys in groups.items():
        render_group(models, keys, os.path.join(out_dir, f"group-{name}.png"),
                     row=3)
        clear_preview_objects(keep)
    if len(models) == len(BUILDERS):
        render_map_scale(models, os.path.join(out_dir, "map-scale.png"))
        clear_preview_objects(keep)


# ---------------------------------------------------------------------------


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else sys.argv[1:]
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True,
                        help="directory for the .gltf files")
    parser.add_argument("--render", help="directory for preview renders")
    parser.add_argument("--only", nargs="*", help="model keys to build")
    parser.add_argument("--groups", action="store_true",
                        help="with --render: only the group and map-scale views")
    parser.add_argument("--textures", action="store_true",
                        help="regenerate the texture images")
    parser.add_argument("--plain", action="store_true",
                        help="build without textures (for comparisons)")
    args = parser.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    if not args.plain:
        kit.TEXTURE_DIR = os.path.abspath(os.path.join(args.out, "textures"))
        stale = list(textures.SETS) if args.textures else textures.missing(
            kit.TEXTURE_DIR)
        if stale:
            textures.write_all(kit.TEXTURE_DIR, stale)
    make_palette()

    os.makedirs(args.out, exist_ok=True)
    models = {}
    for key, (build, kind) in BUILDERS.items():
        if args.only and key not in args.only:
            continue
        obj = build()
        path = os.path.join(args.out, key + ".gltf")
        export_gltf(obj, path)
        tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
        print(f"{key}: {tris} triangles -> {path}")
        models[key] = (obj, kind)

    if args.render:
        render_previews(models, args.render, closeups=not args.groups)


if __name__ == "__main__":
    main()
