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

  // Ignore conditions ("wind off the left", "breeze from the right") when reading the miss
  const tm = t.replace(/\b(wind|breeze|gust|downwind|into the wind)\b[^,.;]*/g, ' ');
  if (/\b(pull(ed)?|hook(ed)?)\b/.test(tm)) out.miss = 'left';
  else if (/\b(push(ed)?|slic(e|ed)|shank(ed)?)\b/.test(tm)) out.miss = 'right';
  else if (/\bleft\b/.test(tm)) out.miss = 'left';
  else if (/\bright\b/.test(tm)) out.miss = 'right';
  else if (/\b(short|chunk(ed)?|fat|heavy)\b/.test(tm)) out.miss = 'short';
  else if (/\b(long|flew( it)?|over( the green)?)\b/.test(tm)) out.miss = 'long';
  else if (/\b(pure(d)?|flush(ed)?|perfect|stiff|on target|pin high|great|good)\b/.test(tm)) out.miss = 'on_target';

  if (/\bpunch(ed)?\b/.test(t)) out.shotType = 'punch';
  else if (/\bchip(ped)?\b/.test(t)) out.shotType = 'chip';
  else if (/\bpitch(ed)?\b/.test(t)) out.shotType = 'pitch';

  return out;
}

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const speechAvailable = !!Recognition;

// One-shot speech capture via Safari's speech recognition. This is unreliable in
// home-screen web apps, so every failure is reported to the caller (never silent).
// The always-works fallback is the microphone key on the iPhone keyboard.
export function listen({ onText, onError, onEnd }) {
  if (!Recognition) { onError?.('unsupported'); onEnd?.(); return null; }
  let heard = false;
  try {
    const r = new Recognition();
    r.lang = 'en-US';
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => { heard = true; onText(e.results[0][0].transcript); };
    r.onerror = (e) => onError?.(e.error || 'error');
    r.onend = () => { if (!heard) onError?.('no-speech'); onEnd?.(); };
    r.start();
    return r;
  } catch {
    onError?.('start-failed');
    onEnd?.();
    return null;
  }
}
