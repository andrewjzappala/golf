#!/usr/bin/env python3
"""Build miss-zone polygons (dead / trouble / safe) from Andrew's plain-language zone spec.

Usage:
  python3 tools/build_zones.py tools/zones/balboa_9_spec.json            # build zones file
  python3 tools/build_zones.py tools/zones/balboa_9_spec.json --describe # print where bunkers etc. sit

Zones are boxes measured off the green's edges, in yards, in a frame aligned with the line
of play into the green:
  along: "front-25" .. "back+20"   (short is negative, long is positive; also "center")
  side:  "left-20"  .. "right+15"  (left/right as you face the green; also "center")
or reuse a mapped feature:  "feature": "bunker:0"  (index into the hole's bunkers list).

Tee-shot zones use "from": "tee": along = yards from the tee along the hole line (follows
doglegs), side = yards left (negative) / right (positive) of that line, e.g.
  {"from": "tee", "along": [225, 265], "side": [18, 40]}   # right side, 225-265 out

Output (data/courses/<course>_zones.json, copied to app/courses/) is a SEPARATE manual file,
so re-importing course geometry from OpenStreetMap can never overwrite it.
No third-party libraries needed.
"""
import json, math, os, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EARTH_R = 6371008.8
YD = 0.9144  # meters per yard
KINDS = ("safe", "trouble", "dead")


def frame_for(hole):
    """Local frame at the green center: u = along the line of play (toward long), r = to the right."""
    c = hole["green"]["center"]
    kx = EARTH_R * math.cos(math.radians(c[1])) * math.pi / 180
    ky = EARTH_R * math.pi / 180
    to_m = lambda p: ((p[0] - c[0]) * kx, (p[1] - c[1]) * ky)
    to_ll = lambda x, y: [round(c[0] + x / kx, 7), round(c[1] + y / ky, 7)]
    line = (hole.get("hole_line") or {}).get("coordinates") or [hole["tee"]["point"], c]
    # direction into the green: from the last hole-line vertex that isn't at the green
    start = next((p for p in reversed(line[:-1]) if math.hypot(*to_m(p)) > 30), line[0])
    sx, sy = to_m(start)
    n = math.hypot(sx, sy)
    u = (-sx / n, -sy / n)
    r = (u[1], -u[0])
    along = lambda p: (lambda m: (m[0] * u[0] + m[1] * u[1]) / YD)(to_m(p))
    side = lambda p: (lambda m: (m[0] * r[0] + m[1] * r[1]) / YD)(to_m(p))
    point = lambda a, s: to_ll(a * YD * u[0] + s * YD * r[0], a * YD * u[1] + s * YD * r[1])
    ring = hole["green"]["polygon"]["coordinates"][0]
    edges = {
        "front": min(map(along, ring)), "back": max(map(along, ring)),
        "left": min(map(side, ring)), "right": max(map(side, ring)), "center": 0.0,
    }
    return along, side, point, edges


def tee_frame(hole):
    """Points measured along the hole line from the tee, offset left/right of the line."""
    c = hole["green"]["center"]
    kx = EARTH_R * math.cos(math.radians(c[1])) * math.pi / 180
    ky = EARTH_R * math.pi / 180
    to_m = lambda p: ((p[0] - c[0]) * kx, (p[1] - c[1]) * ky)
    to_ll = lambda x, y: [round(c[0] + x / kx, 7), round(c[1] + y / ky, 7)]
    line = [to_m(p) for p in ((hole.get("hole_line") or {}).get("coordinates") or [hole["tee"]["point"], c])]

    def at(dist_yd, side_yd):
        d = dist_yd * YD
        for (x0, y0), (x1, y1) in zip(line, line[1:]):
            seg = math.hypot(x1 - x0, y1 - y0)
            if d <= seg or (x1, y1) == line[-1]:
                ux, uy = (x1 - x0) / seg, (y1 - y0) / seg
                rx, ry = uy, -ux
                return to_ll(x0 + ux * d + rx * side_yd * YD, y0 + uy * d + ry * side_yd * YD)
            d -= seg

    def box(a0, a1, s0, s1, step=10):
        n = max(2, int((a1 - a0) / step) + 1)
        stops = [a0 + (a1 - a0) * i / (n - 1) for i in range(n)]
        ring = [at(a, s0) for a in stops] + [at(a, s1) for a in reversed(stops)]
        return ring + [ring[0]]
    return box


def resolve(token, edges):
    token = token.replace(" ", "")
    for name in ("front", "back", "left", "right", "center"):
        if token.startswith(name):
            rest = token[len(name):]
            return edges[name] + (float(rest) if rest else 0.0)
    return float(token)


def build_zone(z, hole, frame, n):
    along, side, point, edges = frame
    out = {"id": f"h{hole['number']}-{n}", "kind": z["kind"], "label": z["label"], "source": "manual"}
    if z.get("note"):
        out["note"] = z["note"]
    if z.get("from") == "tee":
        (a0, a1), (s0, s1) = sorted(z["along"]), sorted(z["side"])
        out["polygon"] = {"type": "Polygon", "coordinates": [tee_frame(hole)(a0, a1, s0, s1)]}
        out["frame"] = "tee"
    elif "feature" in z:
        kind, idx = z["feature"].split(":")
        feat = hole[{"bunker": "bunkers", "water": "water", "fairway": "fairways"}[kind]][int(idx)]
        out["polygon"] = feat["polygon"]
        out["from_feature"] = feat.get("osm_id")
    else:
        a0, a1 = sorted(resolve(t, edges) for t in z["along"])
        s0, s1 = sorted(resolve(t, edges) for t in z["side"])
        out["polygon"] = {"type": "Polygon", "coordinates": [[
            point(a0, s0), point(a0, s1), point(a1, s1), point(a1, s0), point(a0, s0)]]}
    assert out["kind"] in KINDS, f"unknown zone kind {out['kind']}"
    return out


def describe(course):
    for h in course["holes"]:
        along, side, _, e = frame_for(h)
        print(f"\nHole {h['number']} (par {h['par']}): green {e['back'] - e['front']:.0f} deep x {e['right'] - e['left']:.0f} wide")
        for kind in ("bunkers", "water"):
            for i, f in enumerate(h.get(kind) or []):
                ring = f["polygon"]["coordinates"][0]
                a = sum(map(along, ring)) / len(ring)
                s = sum(map(side, ring)) / len(ring)
                ad = "short" if a < e["front"] else "long" if a > e["back"] else "pin-high"
                sd = "left" if s < e["left"] else "right" if s > e["right"] else "middle"
                print(f"  {kind[:-1] if kind == 'bunkers' else kind}:{i}  {ad}-{sd}  (along {a:+.0f}, side {s:+.0f} yds from center)")


def main():
    spec_path = sys.argv[1]
    spec = json.load(open(spec_path))
    course_file = os.path.join(ROOT, "data", "courses", spec["course_file"])
    course = json.load(open(course_file))
    if "--describe" in sys.argv:
        return describe(course)
    holes = {}
    for num, h in spec["holes"].items():
        hole = next(x for x in course["holes"] if x["number"] == int(num))
        frame = frame_for(hole)
        holes[num] = {
            "notes": h.get("notes", []),
            **({"caddy": h["caddy"]} if h.get("caddy") else {}),
            "zones": [build_zone(z, hole, frame, i) for i, z in enumerate(h.get("zones", []))],
        }
    out = {"course": spec["course"], "source": "manual", "author": spec.get("author"),
           "levels": {"dead": "penalty, lost ball, or near-certain double",
                      "trouble": "hard up-and-down or likely bogey",
                      "safe": "the bailout"},
           "holes": holes}
    dest = os.path.join(ROOT, "data", "courses", spec["output"])
    json.dump(out, open(dest, "w"), indent=1)
    shutil.copy(dest, os.path.join(ROOT, "app", "courses", spec["output"]))
    print(f"wrote {dest} ({sum(len(h['zones']) for h in holes.values())} zones) and copied to app/courses/")


if __name__ == "__main__":
    main()
