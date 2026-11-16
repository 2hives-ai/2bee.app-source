// The name the Save box starts with (founder 2026-11-12: "when I click save in the cad automatically add a name for
// the design (prefill)").
//
// Order: the design's own title (the card it was opened from) -> the file name -> the first comment line of the
// source -> "Design <date>". The prefill is never a name that is already saved: `store.ts::save()` keys on the name
// and REPLACES the old record, so a prefill that collided would turn one click into a silent overwrite. A taken name
// gets " 2", " 3", ... The user can still type a taken name on purpose; the button then says Replace.

const MAX = 120;

function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX).trim();
}

/** `2bee_household/pot_saucer_18cm_3d.scad` -> `Pot saucer 18cm 3d`. */
export function nameFromPath(path: string): string {
  const base = path.split('/').pop() ?? '';
  const words = base.replace(/\.scad$/i, '').replace(/[_-]+/g, ' ').trim();
  return words ? tidy(words.charAt(0).toUpperCase() + words.slice(1)) : '';
}

/** The first `//` comment line, without a leading file name such as `foo.scad —`. */
export function nameFromSource(source: string): string {
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('//')) return '';
    const text = line.replace(/^\/\/+\s*/, '').replace(/^[\w.-]+\.scad\s*[—–:-]\s*/i, '');
    if (text) return tidy(text.replace(/[.;:,]+$/, ''));
  }
  return '';
}

export function suggestSaveName(o: { savedName: string | null; title?: string | null; path?: string; source?: string; now?: Date }): string {
  if (o.savedName) return o.savedName;
  const d = o.now ?? new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    tidy(o.title ?? '') ||
    nameFromPath(o.path ?? '') ||
    nameFromSource(o.source ?? '') ||
    `Design ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`
  );
}

/** `base` if free, else the first free `base 2`, `base 3`, ... */
export function uniqueName(base: string, taken: readonly string[]): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const tail = ` ${i}`;
    const n = base.slice(0, MAX - tail.length) + tail;
    if (!set.has(n)) return n;
  }
}
