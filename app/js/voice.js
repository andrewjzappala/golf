// Turn a spoken/dictated note ("7-iron, pulled it left") into structured fields.

const NUM = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const n = (s) => (NUM[s] ?? parseInt(s, 10));
const NUMS = '(\\d|two|three|four|five|six|seven|eight|nine)';

export function parseNote(text, bag) {
  const t = ' ' + text.toLowerCase().replace(/[-–]/g, ' ') + ' ';
  const out = {};
  const has = (id) => bag.some((c) => c.id === id);
  const pickWedge = (...ids) => ids.find(has);
  let m;

  if (/\bdriver\b/.test(t)) out.club = 'D';
  else if ((m = t.match(new RegExp(`\\b${NUMS}\\s*(wood|w)\\b`)))) out.club = `${n(m[1])}W`;
  else if ((m = t.match(new RegExp(`\\b${NUMS}\\s*(hybrid|h|rescue)\\b`)))) out.club = `${n(m[1])}H`;
  else if ((m = t.match(new RegExp(`\\b${NUMS}\\s*(iron|i)\\b`)))) out.club = `${n(m[1])}i`;
  else if (/\b(pitching wedge|pw|p wedge)\b/.test(t)) out.club = 'PW';
  else if (/\b(a wedge|aw|approach wedge)\b/.test(t)) out.club = 'AW';
  else if ((m = t.match(/\b(4[6-9]|5\d|6[0-4])\s*(degree|°)?\b/))) out.club = m[1];
  else if (/\bgap wedge\b/.test(t)) out.club = pickWedge('50', '52', '48');
  else if (/\bsand wedge\b/.test(t)) out.club = pickWedge('54', '56');
  else if (/\blob wedge\b/.test(t)) out.club = pickWedge('58', '60');
  else if (/\bputter\b/.test(t)) out.club = 'P';
  if (out.club && !has(out.club)) delete out.club;

  if (/\b(pull(ed)?|hook(ed)?|left)\b/.test(t)) out.miss = 'left';
  else if (/\b(push(ed)?|slic(e|ed)|right|shank(ed)?)\b/.test(t)) out.miss = 'right';
  else if (/\b(short|chunk(ed)?|fat|heavy)\b/.test(t)) out.miss = 'short';
  else if (/\b(long|flew( it)?|over( the green)?)\b/.test(t)) out.miss = 'long';
  else if (/\b(pure(d)?|flush(ed)?|perfect|stiff|on target|pin high|great|good)\b/.test(t)) out.miss = 'on_target';

  if (/\bpunch(ed)?\b/.test(t)) out.shotType = 'punch';
  else if (/\bchip(ped)?\b/.test(t)) out.shotType = 'chip';
  else if (/\bpitch(ed)?\b/.test(t)) out.shotType = 'pitch';

  return out;
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const speechAvailable = !!Recognition;

// One-shot speech capture. Falls back to keyboard dictation if unavailable.
export function listen(onText, onEnd) {
  if (!Recognition) return null;
  const r = new Recognition();
  r.lang = 'en-US';
  r.interimResults = false;
  r.maxAlternatives = 1;
  r.onresult = (e) => onText(e.results[0][0].transcript);
  r.onend = onEnd;
  r.onerror = onEnd;
  r.start();
  return r;
}
