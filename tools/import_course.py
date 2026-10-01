"""
Course importer: turns an Overpass Turbo GeoJSON export into a clean course file.
Usage: python3 import_course.py <export.geojson> <course_config.json> <output.json>
Requires: pip install shapely pyproj
"""
import json, math, sys
from shapely.geometry import shape, Point, LineString, mapping
from shapely.ops import transform
import pyproj

YD = 1.09361  # meters -> yards

def playing_line(tee_pt, hole_line, target):
    """Yards from tee to target following the hole line's dogleg bends (how scorecards measure)."""
    bends = [Point(c) for c in hole_line.coords[1:-1]]
    # skip bends that sit behind this tee (can happen on forward tees)
    bends = [b for b in bends if b.distance(target) < tee_pt.distance(target)]
    path = LineString([tee_pt] + bends + [target]) if bends else LineString([tee_pt, target])
    return round(path.length * YD)

def main(src, cfg_path, out):
    raw = json.load(open(src)); cfg = json.load(open(cfg_path))
    to_m = pyproj.Transformer.from_crs(4326, 32611, always_xy=True).transform   # UTM 11N (San Diego)
    to_ll = pyproj.Transformer.from_crs(32611, 4326, always_xy=True).transform
    feats = [(f["properties"], shape(f["geometry"])) for f in raw["features"]]
    feats = [(p, g, transform(to_m, g)) for p, g in feats]
    by = lambda t: [f for f in feats if f[0].get("golf") == t]
    holes, greens, tees = by("hole"), by("green"), by("tee")
    bunkers, fairways, water = by("bunker"), by("fairway"), by("water_hazard") + by("lateral_water_hazard")
    ll = lambda pt: [round(c, 7) for c in to_ll(pt.x, pt.y)]
    used_greens, out_holes = set(), []

    for p, _, h in sorted(holes, key=lambda f: int(f[0]["ref"])):
        n = int(p["ref"]); card = cfg["holes"].get(str(n), {})
        start, end = Point(h.coords[0]), Point(h.coords[-1])
        gi = min(range(len(greens)), key=lambda i: greens[i][2].distance(end)); used_greens.add(gi)
        gp, g_ll, g = greens[gi]
        # every tee box belongs to the hole whose starting point it's closest to
        my_tees = [f for f in tees
                   if min(holes, key=lambda hh: hh[2].distance(f[2]) if f[2].distance(Point(hh[2].coords[0])) < 80 else 1e9)[0]["ref"] == p["ref"]
                   and f[2].distance(Point(h.coords[0])) < 80] or [min(tees, key=lambda f: f[2].distance(start))]
        my_tees.sort(key=lambda f: -f[2].centroid.distance(g.centroid))  # back -> forward
        card_yds = card.get("yards")
        # primary tee = the box whose yardage best matches the card (else the one the hole line starts at)
        if card_yds:
            tp, t_ll, t = min(my_tees, key=lambda f: abs(playing_line(f[2].centroid, h, g.centroid) - card_yds))
        else:
            tp, t_ll, t = min(my_tees, key=lambda f: f[2].distance(start))
        # front/back: extend the final approach line through the green
        a, b = h.coords[-2], h.coords[-1]
        dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy); ux, uy = dx / L, dy / L
        ray = LineString([(a[0] - ux * 5, a[1] - uy * 5), (b[0] + ux * 200, b[1] + uy * 200)])
        inter = ray.intersection(g)
        pts = [Point(c) for gg in getattr(inter, "geoms", [inter]) for c in gg.coords]
        green_fallback = False
        if not pts:  # hole line misses its green: aim from the last bend through the green's center
            green_fallback = True
            c0 = g.centroid; dx, dy = c0.x - a[0], c0.y - a[1]; L = math.hypot(dx, dy); ux, uy = dx / L, dy / L
            ray = LineString([a, (a[0] + ux * (L + 200), a[1] + uy * (L + 200))])
            inter = ray.intersection(g)
            pts = [Point(c) for gg in getattr(inter, "geoms", [inter]) for c in gg.coords]
        front = min(pts, key=lambda q: q.distance(Point(a))); back = max(pts, key=lambda q: q.distance(Point(a)))
        center = g.centroid; tee_pt = t.centroid
        measured = playing_line(tee_pt, h, center)
        near = lambda coll, d: [f for f in coll if f[2].distance(h) < d or f[2].distance(g) < d]
        # assign each bunker/fairway only to its closest hole
        def closest_is_me(f):
            return min(holes, key=lambda hh: hh[2].distance(f[2]))[0]["ref"] == p["ref"]
        hole_bunkers = [f for f in near(bunkers, 25) if closest_is_me(f)]
        hole_fairways = [f for f in near(fairways, 10) if closest_is_me(f)]
        hole_water = [f for f in near(water, 25) if closest_is_me(f)]
        flags = ["hole line doesn't reach the green in OSM; front/back aimed at green center"] if green_fallback else []
        if card.get("note"):
            flags.append(card["note"])
        elif card_yds and abs(measured - card_yds) > 10:
            flags.append(f"measured {measured} yds vs card {card_yds} yds: verify tee position")
        out_holes.append({
            "number": n, "par": int(p.get("par") or card.get("par")),
            "handicap": card.get("handicap"),
            "card_yards": card_yds, "measured_yards_to_center": measured, "yardage_method": "playing line (follows dogleg)",
            "tee": {"point": ll(tee_pt), "polygon": mapping(t_ll), "osm_id": tp.get("@id"), "source": "osm"},
            "tee_boxes": [{"point": ll(f[2].centroid), "yards_to_center": playing_line(f[2].centroid, h, center),
                           "color": f[0].get("tee"), "osm_id": f[0].get("@id"), "polygon": mapping(f[1])} for f in my_tees],
            "green": {
                "front": ll(front), "center": ll(center), "back": ll(back),
                "yards_from_tee": {"front": playing_line(tee_pt, h, front),
                                   "center": measured,
                                   "back": playing_line(tee_pt, h, back)},
                "depth_yards": round(front.distance(back) * YD),
                "area_sqft": round(g.area * 10.764),
                "polygon": mapping(g_ll), "osm_id": gp.get("@id"), "source": "osm"},
            "hole_line": {"coordinates": [ll(Point(c)) for c in h.coords], "osm_id": p.get("@id")},
            "fairways": [{"polygon": mapping(f[1]), "osm_id": f[0].get("@id"), "source": "osm"} for f in hole_fairways],
            "bunkers": [{"polygon": mapping(f[1]), "osm_id": f[0].get("@id"), "source": "osm"} for f in hole_bunkers],
            "water": [{"polygon": mapping(f[1]), "osm_id": f[0].get("@id"), "source": "osm"} for f in hole_water],
            "elevation": None,
            "completeness": {"tee": True, "green": True, "hole_line": True,
                             "fairway": bool(hole_fairways), "bunkers": bool(hole_bunkers)},
            "flags": flags,
        })

    extra = [{"polygon": mapping(greens[i][1]), "osm_id": greens[i][0].get("@id"), "note": "not attached to any of this course's holes (practice green or a neighboring course)"}
             for i in range(len(greens)) if i not in used_greens]
    course = {**cfg["course"], "holes": out_holes, "other_features": {"unassigned_greens": extra},
              "data_sources": {"geometry": "OpenStreetMap (ODbL)", "scorecard": cfg["course"].get("scorecard_source")}}
    json.dump(course, open(out, "w"), indent=2)
    for hh in out_holes:
        g = hh["green"]["yards_from_tee"]
        print(f'H{hh["number"]} par {hh["par"]} card {hh["card_yards"]}: {g["front"]}/{g["center"]}/{g["back"]}  tees {[t["yards_to_center"] for t in hh["tee_boxes"]]}  '
              f'bunkers {len(hh["bunkers"])}  fairways {len(hh["fairways"])}  {"; ".join(hh["flags"])}')
    print(f"unassigned greens: {len(extra)}")

if __name__ == "__main__":
    main(*sys.argv[1:4])
