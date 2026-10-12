"""Missiles and other things in flight: the atom bomb, hydrogen bomb, MIRV
and its warheads, SAM interceptors and warship shells. Each is 1 long (the
exhaust flame trails beyond), centred on the origin with its nose toward
-Y."""

from kit import Model, rot_y


def missile(m, bands, segments=24):
    """Body of revolution from (y, r, material) bands, nose first: each
    band runs from its own point to the next one's."""
    profile = [(y, r) for y, r, _ in bands]
    materials = [material for _, _, material in bands[:-1]]
    m.revolve(profile, materials, segments=segments)


def fins(m, count, y0, y1, r0, span, tip, material, thickness=0.008,
         offset=45.0):
    """count fins round the body from y0 to y1, standing span out from
    radius r0, their tips tip long."""
    for k in range(count):
        with m.at(rot_y(offset + k * 360.0 / count)):
            m.extrude_x([(y0, r0), (y1, r0), (y1, r0 + span),
                         (y1 - tip, r0 + span)],
                        -thickness / 2, thickness / 2, material)


def exhaust(m, y, r, length):
    """Nozzle bell and a glowing flame."""
    m.revolve([(y - 0.01, r * 0.6), (y + 0.04, r)], "Dark", segments=20)
    m.revolve([(y + 0.03, r * 0.9), (y + 0.06, r * 1.05),
               (y + 0.06 + length * 0.4, r * 0.85),
               (y + 0.06 + length, r * 0.15)], "Flame", segments=20)


def build_atom_bomb():
    """Ballistic missile: white body, team-coloured nose and fins."""
    m = Model("AtomBomb")
    missile(m, [
        (-0.5, 0.003, "TeamColor"), (-0.47, 0.017, "TeamColor"),
        (-0.43, 0.031, "TeamColor"), (-0.37, 0.044, "TeamColor"),
        (-0.31, 0.053, "TeamColor"), (-0.25, 0.056, "Missile"),
        (-0.2, 0.056, "Dark"), (-0.18, 0.056, "Missile"),
        (0.24, 0.056, "TeamColor"), (0.28, 0.056, "Missile"),
        (0.4, 0.056, "MetalDark"), (0.42, 0.05, None),
    ])
    fins(m, 4, 0.27, 0.42, 0.05, 0.07, 0.06, "TeamColor")
    exhaust(m, 0.42, 0.04, 0.32)
    return m.to_object()


def build_hydrogen_bomb():
    """Two-stage missile: a dark first stage with hazard bands, a
    team-coloured interstage and nose."""
    m = Model("HydrogenBomb")
    missile(m, [
        (-0.5, 0.003, "TeamColor"), (-0.46, 0.02, "TeamColor"),
        (-0.41, 0.036, "TeamColor"), (-0.35, 0.047, "TeamColor"),
        (-0.29, 0.053, "Missile"), (-0.06, 0.053, "Hazard"),
        (-0.04, 0.053, "Dark"), (-0.025, 0.053, "Hazard"),
        (-0.005, 0.053, "TeamColor"), (0.04, 0.066, "CladdingDark"),
        (0.2, 0.066, "Missile"), (0.23, 0.066, "CladdingDark"),
        (0.4, 0.066, "MetalDark"), (0.42, 0.058, None),
    ])
    fins(m, 4, 0.3, 0.42, 0.06, 0.055, 0.05, "Dark")
    exhaust(m, 0.42, 0.05, 0.4)
    return m.to_object()


def build_mirv():
    """Three-stage intercontinental missile with a bulbous team-coloured
    payload shroud."""
    m = Model("MIRV")
    missile(m, [
        (-0.5, 0.004, "TeamColor"), (-0.48, 0.03, "TeamColor"),
        (-0.44, 0.052, "TeamColor"), (-0.38, 0.068, "TeamColor"),
        (-0.32, 0.074, "TeamColor"), (-0.18, 0.074, "Missile"),
        (-0.14, 0.058, "Missile"), (0.0, 0.058, "Dark"),
        (0.025, 0.067, "Missile"), (0.12, 0.067, "TeamColor"),
        (0.15, 0.067, "Missile"), (0.2, 0.067, "Dark"),
        (0.225, 0.076, "Missile"), (0.4, 0.076, "MetalDark"),
        (0.42, 0.066, None),
    ], segments=28)
    exhaust(m, 0.42, 0.058, 0.45)
    return m.to_object()


def build_mirv_warhead():
    """Re-entry vehicle: a dark ablative cone, its nose glowing from
    re-entry, with a band in the owner's colour."""
    m = Model("MIRVWarhead")
    missile(m, [
        (-0.5, 0.01, "Flame"), (-0.49, 0.04, "Flame"),
        (-0.45, 0.065, "Dark"), (0.05, 0.16, "TeamColor"),
        (0.13, 0.178, "Dark"), (0.32, 0.2, "MetalDark"),
        (0.36, 0.17, None),
    ], segments=24)
    return m.to_object()


def build_sam_missile():
    """Slim interceptor: white with a dark radome, a team band, canards and
    tail fins."""
    m = Model("SAMMissile")
    missile(m, [
        (-0.5, 0.003, "Dark"), (-0.45, 0.018, "Dark"),
        (-0.38, 0.032, "Dark"), (-0.3, 0.04, "Missile"),
        (-0.24, 0.04, "TeamColor"), (-0.18, 0.04, "Missile"),
        (0.38, 0.04, "MetalDark"), (0.42, 0.036, None),
    ], segments=16)
    fins(m, 4, -0.2, -0.12, 0.036, 0.03, 0.05, "Missile", 0.006)
    fins(m, 4, 0.28, 0.42, 0.036, 0.055, 0.08, "TeamColor", 0.006)
    exhaust(m, 0.42, 0.03, 0.5)
    return m.to_object()


def build_shell():
    """A glowing tracer round."""
    m = Model("Shell")
    missile(m, [
        (-0.5, 0.01, "Tracer"), (-0.35, 0.09, "Tracer"),
        (-0.2, 0.12, "Tracer"), (0.4, 0.12, "Tracer"), (0.5, 0.1, None),
    ], segments=12)
    return m.to_object()
