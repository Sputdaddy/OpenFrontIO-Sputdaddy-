"""Ground vehicles: props parked on structures and carried by ships (cars,
trucks, a tank, an APC, containers), and the train cars, which are units of
their own. Props are built facing -Y on the ground at the point given."""

from kit import Model, rot_x, rot_y, rot_z, scale, translate

CONTAINER_PAINTS = [
    "ContainerRed", "ContainerBlue", "ContainerGreen", "ContainerOrange",
    "ContainerGrey", "ContainerTeal", "CarWhite",
]

# A 40 ft container in model units (structures are 1 wide).
CONTAINER_LENGTH = 0.075
CONTAINER_WIDTH = 0.016
CONTAINER_HEIGHT = 0.017


def placed(x, y, z, rz=0.0, s=1.0):
    return translate(x, y, z) @ rot_z(rz) @ scale(s, s, s)


def wheel(m, x, y, z, r, width, material="Dark", segments=12):
    """Wheel on an axle along X, its centre at (x, y, z)."""
    m.cylinder(0, 0, -width / 2, width / 2, r, material, segments=segments,
               m=translate(x, y, z) @ rot_y(90))


def car(m, x, y, z, rz, paint):
    m.box(x, y, z + 0.003, 0.042, 0.02, 0.011, paint, rz=rz, bevel=0.003)
    m.box(x, y, z + 0.014, 0.022, 0.017, 0.008, "Window", rz=rz, bevel=0.002)


def container(m, x, y, z, paint, rz=0.0, length=CONTAINER_LENGTH):
    """Shipping container lying along X, with corner posts and a darker
    door end."""
    with m.at(placed(x, y, z, rz)):
        w, h = CONTAINER_WIDTH, CONTAINER_HEIGHT
        m.box(0, 0, 0, length, w, h, paint, bevel=0.0008)
        m.box(length / 2 - 0.0008, 0, 0.001, 0.002, w * 0.86, h * 0.86, "Dark")


def truck(m, x, y, z, rz, cab="CarWhite", load=None, s=1.0):
    """Semi-trailer truck, cab toward -Y, with a container on the trailer
    when load names its paint."""
    with m.at(placed(x, y, z, rz, s)):
        m.box(0, 0.006, 0.007, 0.016, 0.104, 0.004, "Dark")
        for wy in (-0.04, -0.012, 0.036, 0.046):
            for side in (-1, 1):
                wheel(m, side * 0.0085, wy, 0.0055, 0.0055, 0.004)
        m.box(0, -0.039, 0.008, 0.021, 0.024, 0.02, cab, bevel=0.002)
        m.box(0, -0.0512, 0.017, 0.018, 0.0012, 0.008, "Window")
        m.box(0, -0.027, 0.012, 0.02, 0.003, 0.014, "Dark")
        m.box(0, 0.016, 0.011, 0.019, 0.078, 0.003, "MetalDark")
        if load:
            with m.at(rot_z(90)):
                container(m, 0, 0, 0.014, load)


def military_truck(m, x, y, z, rz, body="shelter", s=1.0):
    """Six-wheel army truck, cab toward -Y, carrying an equipment shelter
    (a team-coloured roof) or a generator."""
    with m.at(placed(x, y, z, rz, s)):
        m.box(0, 0.005, 0.01, 0.022, 0.11, 0.006, "Dark")
        for wy in (-0.036, 0.024, 0.044):
            for side in (-1, 1):
                wheel(m, side * 0.0125, wy, 0.008, 0.008, 0.006)
        m.box(0, -0.036, 0.014, 0.028, 0.026, 0.022, "Olive", bevel=0.002)
        m.box(0, -0.0492, 0.024, 0.024, 0.0015, 0.009, "Window")
        if body == "shelter":
            m.box(0, 0.021, 0.016, 0.03, 0.062, 0.03, "Olive", bevel=0.002)
            m.box(0, 0.021, 0.046, 0.026, 0.056, 0.002, "TeamColor")
            m.box(0.0152, 0.03, 0.022, 0.0015, 0.012, 0.018, "Dark")
            m.box(-0.006, 0.01, 0.048, 0.008, 0.008, 0.006, "MetalLight")
        else:
            m.box(0, 0.021, 0.016, 0.028, 0.058, 0.022, "Olive", bevel=0.002)
            for k in range(4):
                m.box(0.0145, 0.004 + k * 0.011, 0.02, 0.0015, 0.006, 0.014,
                      "Dark")
            m.rod((0.008, 0.04, 0.038), (0.008, 0.04, 0.052), 0.003, "Dark", 6)


def tank(m, x, y, z, rz=0.0, s=1.0, turret_rz=0.0):
    """Main battle tank, gun toward -Y, with a team-coloured air
    recognition panel on the engine deck."""
    with m.at(placed(x, y, z, rz, s)):
        for side in (-1, 1):
            tx = side * 0.035
            m.box(tx, 0, 0.002, 0.02, 0.15, 0.02, "Dark", bevel=0.005)
            for k in range(7):
                wheel(m, tx + side * 0.002, -0.06 + k * 0.02, 0.009, 0.0075,
                      0.019, "MetalDark", segments=10)
            m.box(side * 0.037, -0.004, 0.015, 0.017, 0.142, 0.01, "Olive")
        m.frustum(0, 0, 0.012, 0.036, 0.09, 0.16, 0.086, 0.13, "Olive",
                  dy1=0.012, bevel=0.002)
        m.box(0, 0.056, 0.036, 0.05, 0.032, 0.0015, "TeamColor")
        for k in range(3):
            m.box(0, 0.045 + k * 0.01, 0.0375, 0.044, 0.003, 0.001, "Dark")
        m.box(0, -0.077, 0.03, 0.02, 0.004, 0.004, "Dark")
        with m.at(translate(0, 0.004, 0.036) @ rot_z(turret_rz)):
            m.frustum(0, 0, 0, 0.022, 0.066, 0.078, 0.058, 0.066, "Olive",
                      dy1=0.005, bevel=0.002)
            m.box(0, 0.037, 0.002, 0.052, 0.022, 0.016, "Olive", bevel=0.002)
            for side in (-1, 1):
                m.box(side * 0.026, 0.044, 0.018, 0.008, 0.012, 0.006, "Dark")
            m.box(0, -0.038, 0.006, 0.018, 0.006, 0.014, "Olive")
            m.rod((0, -0.04, 0.012), (0, -0.135, 0.013), 0.0032, "Olive", 8)
            m.rod((0, -0.07, 0.0122), (0, -0.088, 0.0124), 0.0048, "Olive", 8)
            m.rod((0, -0.13, 0.013), (0, -0.138, 0.013), 0.0042, "Dark", 8)
            m.cylinder(0.014, 0.012, 0.022, 0.03, 0.009, "Olive", segments=10)
            m.cylinder(0.014, 0.012, 0.03, 0.032, 0.007, "Dark", segments=10)
            m.rod((0.014, 0.006, 0.034), (0.014, -0.014, 0.035), 0.0012, "Dark",
                  4)
            m.box(-0.016, -0.012, 0.022, 0.012, 0.012, 0.007, "Dark")
            m.rod((-0.022, 0.03, 0.022), (-0.022, 0.03, 0.06), 0.0007, "Dark", 4)


def apc(m, x, y, z, rz=0.0, s=1.0):
    """Eight-wheel armoured personnel carrier with a remote weapon
    station, nose toward -Y."""
    with m.at(placed(x, y, z, rz, s)):
        for side in (-1, 1):
            for k in range(4):
                wheel(m, side * 0.034, -0.05 + k * 0.032, 0.012, 0.012, 0.01,
                      segments=12)
        m.frustum(0, 0.004, 0.01, 0.044, 0.07, 0.15, 0.064, 0.136, "Olive",
                  dy1=0.006, bevel=0.003)
        m.frustum(0, -0.074, 0.016, 0.044, 0.07, 0.006, 0.064, 0.03, "Olive",
                  dy1=0.014)
        m.box(-0.016, -0.06, 0.044, 0.016, 0.012, 0.0012, "Window")
        m.box(0, 0.045, 0.044, 0.044, 0.036, 0.0015, "TeamColor")
        m.cylinder(0.008, -0.01, 0.044, 0.056, 0.014, "Olive", segments=12)
        m.box(0.008, -0.01, 0.056, 0.016, 0.02, 0.008, "Olive", bevel=0.001)
        m.rod((0.008, -0.02, 0.06), (0.008, -0.06, 0.061), 0.0018, "Dark", 6)
        m.rod((-0.024, 0.06, 0.044), (-0.024, 0.06, 0.09), 0.0007, "Dark", 4)
        for side in (-1, 1):
            m.box(side * 0.034, -0.038, 0.038, 0.004, 0.012, 0.006, "Dark")


# ---------------------------------------------------------------------------
# Train cars: 1 long, front toward -Y, standing on the rails at z = 0.

TRAIN_WIDTH = 0.3
DECK = 0.13


def bogies(m):
    for by in (-0.3, 0.3):
        m.box(0, by, 0.025, 0.22, 0.2, 0.04, "MetalDark", bevel=0.006)
        for ay in (-0.055, 0.055):
            for side in (-1, 1):
                wheel(m, side * 0.105, by + ay, 0.042, 0.042, 0.02, "Dark",
                      segments=14)
            m.rod((-0.1, by + ay, 0.042), (0.1, by + ay, 0.042), 0.01,
                  "MetalDark", 6)
        for side in (-1, 1):
            m.box(side * 0.122, by, 0.03, 0.012, 0.07, 0.035, "MetalLight")
    for end in (-1, 1):
        m.box(0, end * 0.495, 0.08, 0.06, 0.03, 0.03, "Dark")


def build_train_engine():
    """A modern diesel-electric locomotive in the owner's colours: a cab
    with a raked windscreen, a white side stripe, roof fans and grilles."""
    m = Model("TrainEngine")
    bogies(m)
    m.box(0, 0, 0.075, TRAIN_WIDTH, 0.96, 0.05, "Dark")
    m.box(0, 0.0, 0.035, 0.2, 0.3, 0.05, "MetalDark", bevel=0.01)
    side = [(0.48, 0.125), (0.48, 0.4), (0.46, 0.425), (-0.33, 0.425),
            (-0.43, 0.34), (-0.48, 0.21), (-0.485, 0.125)]
    m.extrude_x(side, -TRAIN_WIDTH / 2, TRAIN_WIDTH / 2, "TeamColor")
    hw = TRAIN_WIDTH / 2
    for sx in (-1, 1):
        m.box(sx * (hw + 0.001), 0.04, 0.2, 0.004, 0.86, 0.028, "CarWhite")
        m.box(sx * (hw + 0.001), -0.36, 0.27, 0.004, 0.08, 0.07, "Window")
        m.box(sx * (hw + 0.001), -0.25, 0.15, 0.004, 0.05, 0.2, "Dark")
        for k in range(6):
            m.box(sx * (hw + 0.001), -0.08 + k * 0.08, 0.3, 0.004, 0.05, 0.08,
                  "CladdingDark")
    # Windscreen on the raked nose, headlights and a horn.
    with m.at(translate(0, -0.38, 0.3825) @ rot_x(40)):
        m.box(0, 0, -0.0015, TRAIN_WIDTH * 0.86, 0.11, 0.004, "Window")
        m.box(0, 0, 0.0025, 0.008, 0.11, 0.002, "Dark")
    for sx in (-1, 1):
        m.box(sx * 0.09, -0.484, 0.16, 0.05, 0.008, 0.025, "Lamp")
    m.box(0, -0.488, 0.13, 0.22, 0.012, 0.02, "CarWhite")
    # Roof: fans, grilles, exhaust and a horn.
    for k, fy in enumerate((0.12, 0.25, 0.38)):
        m.cylinder(0, fy, 0.425, 0.432, 0.05, "MetalDark", segments=16)
        m.cylinder(0, fy, 0.432, 0.434, 0.042, "Dark", segments=16)
    m.box(0, -0.08, 0.425, 0.2, 0.18, 0.012, "MetalLight")
    for k in range(6):
        m.box(0, -0.15 + k * 0.028, 0.437, 0.18, 0.008, 0.002, "Dark")
    m.box(0.04, 0.04, 0.425, 0.04, 0.03, 0.03, "Dark")
    m.rod((-0.05, -0.3, 0.425), (-0.05, -0.33, 0.445), 0.008, "MetalLight", 6)
    # Handrails along the walkways at both ends.
    m.box(0, 0.47, 0.125, TRAIN_WIDTH, 0.03, 0.006, "MetalDark")
    return m.to_object()


def flatcar(m):
    bogies(m)
    m.box(0, 0, 0.065, 0.12, 0.94, 0.045, "MetalDark")
    m.box(0, 0, DECK - 0.02, TRAIN_WIDTH, 0.96, 0.02, "TeamColor", bevel=0.004)
    for sx in (-1, 1):
        m.box(sx * (TRAIN_WIDTH / 2 - 0.006), 0, DECK - 0.035, 0.012, 0.94,
              0.016, "MetalDark")
        for k in range(6):
            m.box(sx * (TRAIN_WIDTH / 2 + 0.002), -0.4 + k * 0.16,
                  DECK - 0.035, 0.006, 0.02, 0.03, "MetalDark")


def build_train_car(loaded):
    """A container flatcar, carrying two containers when loaded."""
    m = Model("TrainCarLoaded" if loaded else "TrainCar")
    flatcar(m)
    for py in (-0.43, -0.03, 0.03, 0.43):
        for sx in (-1, 1):
            m.box(sx * 0.12, py, DECK, 0.02, 0.02, 0.012, "Hazard")
    if loaded:
        for cy, paint in ((-0.235, "TeamColor"), (0.235, "ContainerGrey")):
            m.box(0, cy, DECK, 0.27, 0.45, 0.27, paint, bevel=0.006)
            for sx in (-1, 1):
                for k in range(9):
                    m.box(sx * 0.1355, cy - 0.2 + k * 0.05, DECK + 0.02, 0.002,
                          0.012, 0.23, paint)
            end = cy + (0.226 if cy > 0 else -0.226)
            m.box(0, end, DECK + 0.015, 0.24, 0.004, 0.24, "Dark")
    return m.to_object()
