#!/usr/bin/env python3
"""Download a ground-height grid for a course from USGS 3DEP (1 m lidar), for plays-like distances.

Usage: python3 tools/build_elevation.py data/courses/balboa_9_course.json [spacing_m]

Writes data/courses/<id>_elevation.json and copies it to app/courses/:
  { origin: [lon, lat] of the south-west corner, step: [dLon, dLat], nx, ny,
    meters: [row-major heights, south→north rows, west→east], source, spacing_m }
Public-domain USGS data; no key needed. Fills holes in the response by nearest neighbour.
"""
import json, math, os, shutil, sys, time, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/getSamples'


def coords(geom):
    if not geom: return []
    t = geom.get('type')
    if t == 'Polygon': return [p for ring in geom['coordinates'] for p in ring]
    if t == 'MultiPolygon': return [p for poly in geom['coordinates'] for ring in poly for p in ring]
    return geom.get('coordinates') or []


def sample(points):
    geom = {'points': points, 'spatialReference': {'wkid': 4326}}
    body = urllib.parse.urlencode({'geometry': json.dumps(geom), 'geometryType': 'esriGeometryMultipoint',
                                   'returnFirstValueOnly': 'true', 'f': 'json'}).encode()
    for attempt in range(4):
        try:
            r = json.load(urllib.request.urlopen(urllib.request.Request(URL, data=body), timeout=60))
            out = [None] * len(points)
            for s in r.get('samples', []):
                try: out[s['locationId']] = round(float(s['value']), 2)
                except (TypeError, ValueError): pass
            return out
        except Exception as e:
            print('  retry', attempt + 1, e); time.sleep(2 + attempt * 2)
    raise SystemExit('USGS service unavailable')


def main():
    course = json.load(open(sys.argv[1]))
    spacing = float(sys.argv[2]) if len(sys.argv) > 2 else 8.0
    pts = []
    for h in course['holes']:
        pts += coords(h['green']['polygon']) + [t['point'] for t in h.get('tee_boxes', [])] + (h.get('hole_line') or {}).get('coordinates', [])
        for k in ('fairways', 'bunkers', 'water'):
            for f in h.get(k) or []: pts += coords(f['polygon'])
    lons, lats = [p[0] for p in pts], [p[1] for p in pts]
    lat0 = (min(lats) + max(lats)) / 2
    dLat = spacing / 111320.0
    dLon = spacing / (111320.0 * math.cos(math.radians(lat0)))
    pad = 60 / spacing  # 60 m margin
    lon0, lat0s = min(lons) - pad * dLon, min(lats) - pad * dLat
    nx = int((max(lons) - min(lons)) / dLon + 2 * pad) + 1
    ny = int((max(lats) - min(lats)) / dLat + 2 * pad) + 1
    grid = [[round(lon0 + i * dLon, 7), round(lat0s + j * dLat, 7)] for j in range(ny) for i in range(nx)]
    print(f'{course["id"]}: {nx} x {ny} = {len(grid)} points at {spacing} m')
    vals, batch = [], 400
    for k in range(0, len(grid), batch):
        vals += sample(grid[k:k + batch])
        print(f'  {min(k + batch, len(grid))}/{len(grid)}', end='\r')
    print()
    # fill any gaps from the nearest filled neighbour on the same row
    for j in range(ny):
        row = vals[j * nx:(j + 1) * nx]
        for i, v in enumerate(row):
            if v is None:
                near = [row[x] for x in range(max(0, i - 5), min(nx, i + 6)) if row[x] is not None]
                vals[j * nx + i] = near[0] if near else 0
    out = {'course': course['id'], 'source': 'USGS 3DEP 1 m lidar (public domain)', 'spacing_m': spacing,
           'origin': [round(lon0, 7), round(lat0s, 7)], 'step': [dLon, dLat], 'nx': nx, 'ny': ny, 'meters': vals}
    name = os.path.basename(sys.argv[1]).replace('_course.json', '_elevation.json')
    dest = os.path.join(ROOT, 'data', 'courses', name)
    json.dump(out, open(dest, 'w'), separators=(',', ':'))
    shutil.copy(dest, os.path.join(ROOT, 'app', 'courses', name))
    print('wrote', dest, os.path.getsize(dest) // 1024, 'KB')


if __name__ == '__main__':
    main()
