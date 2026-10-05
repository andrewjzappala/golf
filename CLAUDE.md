# Golf Tracker & AI Caddy — Project Brief

This file is the handoff from a planning conversation. Read it fully before starting work.

## Who you're working with

- **Andrew** — a golfer and the product owner. **He is not a coder.** Explain technical choices in plain language, make decisions where they're purely technical, and ask him only about things that affect how the app works or feels.
- He works in performance creative and marketing, so **brand, visual design, and UX are his expertise.** Build functional, clean UI scaffolding, but treat look and feel as his call; don't invest in visual polish before he weighs in.
- Uses an **iPhone**. No Apple Watch. No sensor hardware.
- Current handicap index **~7.5** (inflated by a tough 9-hole course). Plays to ~5–6 at his club. **Goal: a 2 handicap next year.**

## What we're building

An Arccos-style app **without hardware**:
1. **Shot-by-shot tracking** using the phone's GPS plus fast manual input.
2. **Strokes-gained analysis** that shows where he gains and loses strokes, round over round.
3. **An AI caddy** that recommends clubs and targets from his own history plus live conditions.

## Home courses (course data already built)

- **Balboa Park 9-Hole Executive** (San Diego): par 32, 2,175 yds. Small greens (~2,600 sq ft median, ~20 yds deep), four par 3s of 130–198 yds, two drivable par 4s (holes 6 and 7).
- **Balboa Park 18-Hole** (San Diego): par 72, ~6,339 yds from the blue tees. Greens ~3,500 sq ft, ~26 yds deep.
- **San Diego Country Club** (his club) is closed for a year for renovation. Skip it for now; the same pipeline will handle it later.

## Files in this project

```
CLAUDE.md                          ← this brief
data/courses/balboa_9_course.json  ← app-ready course file
data/courses/balboa_18_course.json ← app-ready course file
tools/import_course.py             ← OSM GeoJSON → course file importer
tools/balboa_9_config.json         ← scorecard input for the 9-hole
tools/balboa_18_config.json        ← scorecard input for the 18-hole
```

```
app/                               ← the logging web app (step 1), deploy this folder as-is
  index.html, css/app.css, sw.js (offline cache), manifest.webmanifest, icons/ (placeholders)
  js/app.js      screens + actions        js/rounds.js  round/shot model, derived end/distances/scores
  js/course.js   course load, lie detect  js/gps.js     live GPS, multi-reading capture, simulate mode
  js/clubs.js    bag, suggestions         js/voice.js   note parser + optional speech
  js/weather.js  Open-Meteo per-hole      js/holemap.js offline SVG hole diagram
  js/db.js       IndexedDB storage + export/import
  courses/       COPY of data/courses/*.json — re-copy after re-running the importer, and bump VERSION in sw.js
```

No build step (Node isn't installed): plain ES modules. Local preview: the preview server can't read ~/Documents (macOS privacy), so rsync `app/` into the scratchpad and serve it from there (`.claude/launch.json`). "Simulate GPS" in Settings lets you double-tap the hole drawing to place yourself (a single tap or drag moves the target). The preview server is `serve.py` in the scratchpad, which sends `Cache-Control: no-store`. If the browser still holds old modules from before that change, open the preview at `http://127.0.0.1:8765/` (a separate cache from localhost).

## Status (2026-09-30)

- **Step 1 prototype built and tested locally** (simulated GPS): start round → one tap per shot (tapping the club *is* the "here" tap; position is averaged over ~2s of GPS readings) → auto lie detection → putt buckets appear automatically on the green → "Holed" auto-advances → scorecard → finish. Weather per hole from Open-Meteo (no key; offline holes are backfilled later from hourly history).
- **Live at https://andrewjzappala.github.io/golf/** (GitHub Pages, repo `andrewjzappala/golf`, public). `.github/workflows/pages.yml` publishes `app/` on every push to `main`. Andrew pushes with GitHub Desktop; Pages source must be set to "GitHub Actions" in the repo settings.
- **Sync:** on-device only for now, plus JSON export/import backup. Cloud sync is still to do.
- **Voice notes:** a yellow **Note** chip opens a note card pinned to the top of the screen, with the keyboard up. The primary path is the **iPhone keyboard's dictation mic** (reliable). A yellow **Speak** button uses Safari speech recognition, which Andrew reported as not recording in the home-screen app. Every failure now shows a message, and a hard failure hides the button for good (`localStorage.speechOff`). Notes autosave while typing and when the app is backgrounded. The parser ignores wind phrases, and pull/push/hook/slice outrank a bare left/right.
- **Target dot** (Andrew's request, the standard golf-app feature): the anchor is the player's GPS position (or the tee box before a fix), and a draggable target shows *you → target* and *target → center* on the drawing, plus a margin line and the zone the target sits in. On a par 4/5 tee the target starts at the planned club's carry along the hole line (book club, else the distance suggestion). Dragging or tapping moves it, and the suggested club then follows the target distance. It clears after each shot and on hole change; "Reset target" restores the plan.
- **Multi-player ready (2026-10-04, for a friend's beta):** a new phone (no saved player and no rounds) gets a **welcome setup** (name, handicap index, goal handicap, bag carries pre-filled from `STARTER_BAG`). Andrew's phone (rounds exist, no saved player) silently keeps `ANDREW_PLAYER` and `ANDREW_BAG` (`js/clubs.js`). The goal handicap is a setting (home shows "the goal is N").
- **Book plans are shots, not clubs:** `caddy.plan = {carry, swing?, exclude?}` (e.g. No. 5 `{carry: 235, exclude: ['driver']}`, No. 6 `{carry: 215, swing: 'three-quarter'}`, where three-quarter means 90% of a club's carry). `clubForCarry()` picks the club from each player's own bag. `{plan}` in a book note renders as that club ("3 Hybrid off the tee, not driver"). `andrew_club` records what Andrew uses, for reference.
- **Club taps are select-then-confirm** (Andrew, 2026-10-04): yellow means "tap to hit". The suggested club is already yellow, so agreeing is still one tap. Tapping any other club turns it yellow ("7i selected · tap it again to log the shot") and moves the target to that club's full carry: along the hole line on the tee, or along the line to the pin on later shots. The margin shows the distance to the target, what's left or how far past center, and any zone. Tapping the yellow club logs the shot.
- **Bag** (`js/clubs.js`): Andrew's **carry** yardages, D 275 · 5W 250 · 3H 235 · 4i 220 · 5i 210 · 6i 195 · 7i 180 · 8i 165 · 9i 155 · PW 145 · AW 135 · 50° 125 · 54° 110 · 58° 95 · putter. He swaps the **5W and 4i** depending on the course; 5W is benched by default (toggle in Settings). Club suggestions use his carry numbers. GPS-measured shot distances are *total* (carry + roll), so they are shown in Settings for reference only and don't override carry.
- **Tees:** Andrew plays the **back tees** on both Balboa courses (the default).
- **Design direction (Andrew):** an elevated modern golf brand / premium social club, not a tech product (references: Manors, Malbon, Bandon Dunes, Rodeo Dunes, Old Barnwell, Cabot Citrus Farms). The hole screen is a **premium yardage book page**: an ink hole drawing (tee at the bottom, green at the top, distance arcs from the green), with the yardages set in the margin. Palette: paper, forest, and ink. Type: Instrument Serif + Jost, self-hosted in `app/fonts/` for offline use. Scorecard uses classic circle and square marks. **Name: Dialed.** Brand accent: **a pop of yellow** (`--yellow`, #f2c230), used sparingly: the wordmark's yellow dot (a golf ball), the suggested club, the player's position on the drawing, birdie marks, and the goal highlight. Icon: italic serif "D" in cream on forest, with the yellow ball as the period (`app/icons/`). **Course crest:** the Balboa Park Golf Course emblem (cut from the city's official scorecard PDF, without the City seal) is stored as a one-colour alpha stencil, `app/courses/balboa-emblem.png`. It's tinted with `--forest` through a CSS mask on the course-picker cards only. It belongs to the course/City of San Diego; that's fine for personal use, but if Dialed ever has other users, get permission or remove it. Brand placement: the wordmark on the home screen and a small "Dialed." maker's mark at the foot of the scorecard only. Hole pages stay unbranded, like a yardage book page.

Importer usage: `python3 tools/import_course.py <overpass_export.geojson> <config.json> <output.json>` (requires `shapely` and `pyproj`).

## Core design decisions (already agreed)

### The shot is the atomic unit
Store raw facts per shot and derive everything else (scores, distances, strokes gained).

### Data model

**Reference data**
- **Player**: name, handicap, dominant hand, home course.
- **Club**: type (driver, 7i, PW…), loft, active flag (his bag).
- **Course**, **Tee**, **Hole**: loaded from the course JSON files (see "Course file format" below).

**Round data**
- **Round**: date, course, tee set, holes played (9 or 18, since 9-hole rounds are common), notes.
- **HoleResult**: round + hole, total strokes, penalties. Derivable from shots but stored for speed.
- **Shot**:
  - start and end GPS position (the end position may be null; "7i, somewhere left" is still valuable data)
  - start lie and end lie: tee, fairway, rough, sand, green, recovery, penalty
  - distance to pin before and after
  - club
  - shot type: full, punch, chip, pitch, putt
  - miss direction: on target, left, right, short, long
  - free-text note (from voice)
- **WeatherSnapshot**: wind speed and direction, temperature, humidity, pressure. Captured **per hole**, not per round.

**Derived data**
- **ClubProfile**: carry, total distance, left/right and long/short dispersion, recalculated after each round. Powers the caddy.
- **StrokesGained**: per shot, then rolled up by category.
- **Baseline**: expected strokes by lie and distance.

### Strokes gained
- Per shot: `SG = expected(start lie, start distance) − expected(end lie, end distance) − 1`. A holed shot has an end expectation of 0.
- Categories: off the tee, approach, around the green, putting. **Tee shots on par 3s count as approach.**
- **Baseline: target scratch-to-2-handicap**, not tour numbers, so negative values show the gap to his goal. Sourcing a credible amateur/low-handicap baseline table is an open task (see below). Mark any placeholder values clearly as placeholders.
- Strokes gained is course-neutral, which lets rounds on different courses be compared directly. This matters because his handicap swings by course.

### Putting
- **Full putt records**, not just a count per hole.
- Phone GPS is too imprecise on the green, so the **first putt distance comes from a one-tap bucket**: Tap-in (stored as 1 ft), 3, 6, 10, 15, 20, 30, 40+ ft. Later putts get a tap each, or can be inferred. **Tap-in** logs the putt *and* holes it in one tap (Andrew's missed putts are almost always tap-ins).

### Shot input (no watch, no sensors)
- The phone does **not** need to be in a pocket. The flow: walk to the ball, tap "here", give the club, hit. **That one tap marks the end of the previous shot and the start of the next.**
- Club entry by **tap or voice** ("7-iron, pulled it left"). Voice notes get parsed into structured fields.
- **Club inference**: suggest the likely club from the distance to the green and his history, and confirm with one tap.
- **Automatic lie detection**: check the ball's GPS point against the course shapes (green, fairway, bunker, tee). Only ask him for the lie when the hole's data is incomplete.
- **Pin position**: default to green center; he taps the pin location once while standing on the green.
- **Speed is the top UX requirement.** If logging a shot takes more than a few seconds, he'll stop logging mid-round.
- GPS accuracy: average several location readings when he taps, and store the accuracy value with each position.

## Course file format (already built; don't change without reason)

Each hole in `data/courses/*.json` includes:
- `number`, `par`, `handicap`, `card_yards`, `measured_yards_to_center`
- `tee` (primary tee box) and `tee_boxes` (all tee boxes, back to forward, each with `yards_to_center`)
- `green`: front, center, and back as `[lon, lat]`, plus `yards_from_tee`, `depth_yards`, `area_sqft`, and a GeoJSON `polygon`
- `hole_line`, `fairways[]`, `bunkers[]`, `water[]`: GeoJSON polygons with an `osm_id` and `source`
- `completeness` flags and `flags` (known data issues)
- `elevation`: currently null; to be filled from USGS terrain data later
- Coordinates are `[longitude, latitude]` (GeoJSON order).

**Yardages are measured along the playing line (following dogleg bends), the way scorecards are.**

Data sources: geometry from OpenStreetMap (ODbL, attribution required); scorecards from OpenGolfAPI.

### Data rules
- Every feature has a `source` field (`osm` or `manual`) and an `osm_id`. **Manual fixes must never be overwritten by an OSM re-sync.**
- The "unassigned green" in the 9-hole export is actually the 18-hole course's 18th green. The two courses share boundaries, so filter by course when importing.

### Verified and open yardage issues
- **18-hole, hole 6**: plays **220** from a new back tee added last year; the printed card still says 210. Confirmed by Andrew.
- **18-hole, hole 15**: back tee is **325 following the dogleg**. Confirmed; the map is correct.
- **Still flagged:** 18-hole holes 7 (450 vs 463 on the card), 17 (187 vs 198), and 18 (298 vs 316); 9-hole holes 3, 4, 5, and 6. Likely unmapped back tees. Andrew will check these on the course.
- **9-hole, hole 3:** Andrew's tee distances are from the back tee, which sits about 32 yds behind the mapped tee (card 395 vs 363). The zone spec uses `tee_offset: 32` for now. When the real back tee is mapped, set `tee_offset` to 0 and re-run `build_zones.py`.
- He plays the back tees on both courses.

## Build plan (in order)

1. **Logging prototype.** A mobile web app that runs in iPhone Safari and is **served over HTTPS**, since Safari only allows location access on secure pages. It should work offline on the course and sync when back online. Store data on the device first. Deploy to a real web address he can bookmark on his home screen.
2. **Logging screen UX.** Build it alongside step 1 with Andrew; he owns the design direction.
3. **Collect 3–5 real rounds.** No caddy yet. Validate the logging flow in real play.
4. **Strokes gained and a post-round report**, measured against the scratch-to-2 baseline.
5. **AI caddy.** Club profiles plus live weather (wind, temperature, humidity) and plays-like distance (elevation). Recommendations should account for his *miss patterns*, not just average distance. On the drivable par 4s, it should weigh driver at the green against a layup to a full wedge.
6. **Cross-round pattern analysis** (examples: par 3s over 170, wind sensitivity, back-nine fade).

## Miss zones (agreed 2026-10-01, in progress)

Caddie-style "where you can't miss" zones per hole, from Andrew's local knowledge (OSM has no OB, slope or trouble data). There are three levels: **dead** (penalty, lost ball, or near-certain double), **trouble** (hard up-and-down or likely bogey), and **safe** (the bailout). Workflow: Andrew describes each hole (via transcription), Claude drafts the zone polygons from the existing geometry, and Andrew verifies them on the course (in-app adjust, plus "zone edge is here" by GPS). Store zones in a **separate manual file** per course (`source: manual`) so an OSM re-import never overwrites them. Uses: zones shaded on the yardage-book page, caddy club/target choice (step 5), and strokes lost to trouble.
- **Source of truth:** `tools/zones/<course>_spec.json` holds Andrew's words (`said`), book `notes`, optional `caddy` rules (e.g. hole 4 `max_landing: pin`), and zones. Zones are boxes measured off the green edges (`along: front-25..back+20`, `side: left-18..right+10`), boxes measured from the tee along the hole line (`from: tee`), or an existing feature (`feature: bunker:0`). Build with `python3 tools/build_zones.py tools/zones/balboa_9_spec.json` (`--describe` lists where bunkers sit). Output goes to `data/courses/balboa_9_zones.json` and is copied to `app/courses/`. The app draws zones on the hole map and lists them in "The book" section; `zoneAt()` in `course.js` is ready for the caddy.
- Status: Balboa 9 holes 1–9 all drafted from Andrew's descriptions, awaiting on-course check. Hole 5 caddy rule: 3H off the tee to 230–245 (fairway narrows from 34 yds at 200 to 16 at 280). Hole 6 caddy: prefers **go** with a three-quarter 3H (allows for a mishit or wind into the face; more birdies than laying back), aiming short of center; layup is 170–210 right; never long or left. A second greenside bunker right at ~220 is unmapped and placed by hand. Hole 7 caddy: 5-iron off the tee with a cut shape (tree ~130 out on the right overhangs the fairway; the uphill tee lie promotes a draw). It usually finishes a little short, which is fine. The left bunker is the only dead spot. OSM shows a bunker pin-high right that Andrew doesn't recall; check on the course. Same on hole 5: OSM shows a bunker pin-high left of the green that Andrew doesn't recall (he knows only the fairway bunker at ~280); it's left unmarked. Hole 8: long is dead. Hole 9 caddy: 3H preferred (leaves a wedge), driver only when driving well (~50 out); fairway cants right to left past 230, so hug the right; OB left; long, left and right of the green are all dead. On 9, the tee bunker right at ~200 is confirmed as trouble. The OSM greenside bunker short-left doesn't exist per Andrew and is left unmarked. Hole 8: far left of the green is dead (swale, bald lies). The zone spec is complete for all nine; what's left is on-course verification (the mystery bunkers on 5, 7 and 9, and the No. 3 back tee). Hole 8 caddy: club down when between clubs. Course-wide note in `course_notes`: greens run back to front, so long is usually dead. `--describe` now also prints tee distances and fairway widths.

## Open tasks and questions

- Find and document the source of a low-handicap/scratch strokes-gained baseline table.
- Verify voice input support in iPhone Safari before relying on it; tap input must work on its own.
- Choose the weather API (per-hole snapshots, including wind direction).
