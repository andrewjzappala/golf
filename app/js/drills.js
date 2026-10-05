// Practice drills, each tied to the strokes-gained category it moves. The Workshop surfaces the
// ones for the player's biggest leak (and any pattern it spotted, e.g. a left miss).

export const DRILLS = [
  // Putting
  { id: 'clock-4', cat: 'putt', name: 'Around the clock', time: '15 min',
    how: 'Four balls at 3, 4, 5 and 6 ft around one hole on a breaking putt. Make all four before moving to the next spot. Four spots around the clock.',
    measure: 'Track how many rounds of the clock it takes.' },
  { id: 'ladder', cat: 'putt', name: 'Lag ladder', time: '15 min',
    how: 'Putt from 20, 30 and 40 ft. Every ball has to finish inside a putter length (or past the hole and inside tap-in range).',
    measure: 'Out of 15 balls, how many finish in tap-in range.' },
  { id: 'gate', cat: 'putt', name: 'Start-line gate', time: '10 min',
    how: 'Two tees just wider than the ball, 1 ft in front of it on a straight 6-footer. Roll 20 through the gate without touching.',
    measure: 'Gates cleared out of 20.' },
  // Around the green
  { id: 'up-down-9', cat: 'short', name: 'Up-and-down 9', time: '30 min',
    how: 'Nine spots around a practice green: fringe, rough, bunker, uphill, downhill, short-sided. One ball each, chip or pitch and hole out.',
    measure: 'Saves out of 9. A 2-handicap gets about 5.' },
  { id: 'landing-towel', cat: 'short', name: 'Landing-spot towel', time: '15 min',
    how: 'Lay a towel where you want the chip to land. Chip ten each with your 54 and 58 and note how far each one releases.',
    measure: 'Landings on the towel out of 20, and your release ratios.' },
  { id: 'bunker-line', cat: 'short', name: 'Bunker line', time: '10 min',
    how: 'Draw a line in the sand. Make swings that enter the sand just behind the line, then add a ball 2 in. in front of it.',
    measure: 'Clean entries out of 15.' },
  // Approach
  { id: 'wedge-ladder', cat: 'approach', name: 'Wedge ladder', time: '20 min',
    how: 'Three balls each to 50, 75 and 100 yds, then back down. Use the same club for 50 and 75 with different swing lengths.',
    measure: 'Balls inside 15 ft (or within 5 yds of the number on a range).' },
  { id: 'three-quarter', cat: 'approach', name: 'Three-quarter stock shots', time: '15 min',
    how: 'Hit 10 three-quarter shots with each of PW, 9 and 8 iron. Hold the finish at chest height. Learn the carry of each.',
    measure: 'Write down the carry; Dialed can use it.' },
  { id: 'nine-ball', cat: 'approach', name: 'Nine-ball', time: '20 min',
    how: 'With a 7 iron: low, mid and high trajectories, each as a draw, straight and fade. Call the shot before each ball.',
    measure: 'Shots that matched the call out of 9.' },
  // Off the tee
  { id: 'fairway-finder', cat: 'tee', name: 'Fairway finder', time: '15 min',
    how: 'Pick two targets 25 yds apart on the range as a fairway. Ten hybrids and ten drivers at your on-course tempo, full pre-shot routine each time.',
    measure: 'Fairways hit out of 20.' },
  { id: 'anti-hook', cat: 'tee', tags: ['left-miss'], name: 'Anti-hook gate', time: '15 min',
    how: 'Alignment stick in the ground a club-length in front of the ball, just left of your target line. Start every ball right of the stick and hold the face through impact.',
    measure: 'Balls that start right of the stick and finish on target, out of 15.' },
  { id: 'tempo-80', cat: 'tee', name: '80% tempo', time: '10 min',
    how: 'Hit ten drivers at what feels like 80% speed, focusing on center contact rather than distance. Then ten at full speed with the same rhythm.',
    measure: 'Center strikes (impact spray or sound) out of 20.' },
];

// The drills to show: biggest leak first, a pattern-specific drill if one applies, then the next leak.
export function pickDrills(analysis, max = 4) {
  if (!analysis.rounds.length) return DRILLS.filter((d) => ['up-down-9', 'clock-4', 'wedge-ladder', 'fairway-finder'].includes(d.id));
  const order = Object.entries(analysis.cats).sort((a, b) => a[1] - b[1]).map(([k]) => k);
  const tags = analysis.patterns.some((p) => p.text.startsWith('Left is the miss') || p.text.includes('misses lean left')) ? ['left-miss'] : [];
  const picked = DRILLS.filter((d) => d.tags?.some((t) => tags.includes(t))); // pattern-specific first
  const take = (cat, n) => DRILLS.filter((d) => d.cat === cat && !picked.includes(d)).slice(0, n).forEach((d) => picked.push(d));
  take(order[0], 2); // biggest leak
  take(order[1], 1); // next leak
  for (const cat of order) take(cat, max - picked.length);
  return picked.slice(0, max);
}
