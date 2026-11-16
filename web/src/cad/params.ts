/**
 * The design's VARIABLES: top-level `name = literal;` lines a user can change
 * without reading the source (founder 2026-11-13: "the cad and 3d should able to
 * handle variables like turn on/off features").
 *
 * What is listed, and why each rule exists:
 *   · ONLY TOP LEVEL (outside every `{}`/`()`/`[]`), at the start of a line. An
 *     assignment inside a module is that module's local, and changing it here
 *     would not do what the control says.
 *   · ONLY A LITERAL VALUE: `true`/`false`, a number, a "string". `w = d * 2;` is
 *     derived; a control for it would be overwritten by its own formula.
 *   · A NAME ASSIGNED MORE THAN ONCE AT TOP LEVEL IS NOT LISTED. OpenSCAD keeps
 *     the LAST value, so editing one line could change nothing; editing the right
 *     one is a guess. It is reported in `skipped` with that reason.
 *   · `_name` is not listed: by this repo's convention (`_controller_pcb_included`)
 *     it is an include guard or internal switch, not a feature.
 *   · OpenSCAD's own Customizer markers are honoured: `/* [Section] *\/` groups
 *     what follows, `/* [Hidden] *\/` hides it, and a trailing `// [0:10]`,
 *     `// [0:0.5:10]` or `// [a, b, c]` gives the allowed values. Any other
 *     trailing comment, or a `//` comment on the line before, is the description.
 *
 * What it does NOT do: OpenSCAD parameter SETS (the JSON file), variables in
 * `use`/`include`d files, `-D` overrides. A change is a REWRITE OF THAT ONE
 * VALUE in the source text, so the source stays the only truth: the AI, the save,
 * the gates and the STL all see exactly what the control shows.
 */

export type ParamValue = boolean | number | string;

export interface Param {
  name: string;
  value: ParamValue;
  kind: 'bool' | 'number' | 'string';
  /** 1-based source line. */
  line: number;
  /** Character offsets of the literal in the source (`[start, end)`). */
  start: number;
  end: number;
  description: string;
  /** The `/* [Section] *\/` it sits under, or '' before any section. */
  section: string;
  /** From a trailing `// [min:max]` or `// [min:step:max]`. */
  range: { min: number; max: number; step: number | null } | null;
  /** From a trailing `// [a, b, c]` (`value:label` items allowed). */
  options: { value: ParamValue; label: string }[] | null;
}

export interface ParamScan {
  params: Param[];
  skipped: { name: string; line: number; why: string }[];
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/;
const LITERAL = /^(true|false|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|"(?:[^"\\\n]|\\.)*")\s*;/;

function literalValue(text: string): { value: ParamValue; kind: Param['kind'] } {
  if (text === 'true' || text === 'false') return { value: text === 'true', kind: 'bool' };
  if (text.startsWith('"')) return { value: JSON.parse(text.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\')) as string, kind: 'string' };
  return { value: Number(text), kind: 'number' };
}

function optionItem(raw: string): { value: ParamValue; label: string } | null {
  const t = raw.trim();
  if (!t) return null;
  const [v, ...rest] = t.split(':');
  const vt = v.trim();
  const value: ParamValue = /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(vt) ? Number(vt) : vt.replace(/^"(.*)"$/, '$1');
  return { value, label: rest.length ? rest.join(':').trim() : String(value) };
}

function hint(comment: string): Pick<Param, 'range' | 'options'> | null {
  const m = /^\[([^\]]*)\]\s*$/.exec(comment.trim());
  if (!m) return null;
  const body = m[1];
  const nums = body.split(':').map((s) => s.trim());
  if (nums.length >= 2 && nums.length <= 3 && nums.every((s) => /^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(s))) {
    const n = nums.map(Number);
    return { range: nums.length === 2 ? { min: n[0], max: n[1], step: null } : { min: n[0], step: n[1], max: n[2] }, options: null };
  }
  const items = body.split(',').map(optionItem).filter((x): x is { value: ParamValue; label: string } => x !== null);
  return items.length ? { range: null, options: items } : null;
}

export function scanParams(src: string): ParamScan {
  const found: Param[] = [];
  const assigned = new Map<string, number>();
  const skipped: ParamScan['skipped'] = [];
  let depth = 0;
  let inBlock = false;
  let section = '';
  let prevLineComment = '';
  let offset = 0;
  const lines = src.split('\n');

  for (let li = 0; li < lines.length; li++) {
    const text = lines[li];
    const lineStart = offset;
    offset += text.length + 1;
    const atTop = depth === 0 && !inBlock;
    const trimmed = text.trimStart();
    const lead = text.length - trimmed.length;

    let lineCommentHere = '';
    if (atTop) {
      const sec = /^\/\*\s*\[([^\]]+)\]\s*\*\/\s*$/.exec(trimmed);
      if (sec) section = sec[1].trim();
      const a = ASSIGN.exec(trimmed);
      if (a) {
        const name = a[1];
        assigned.set(name, (assigned.get(name) ?? 0) + 1);
        const rest = trimmed.slice(a[0].length);
        const lit = LITERAL.exec(rest);
        if (lit && !name.startsWith('_') && section.toLowerCase() !== 'hidden') {
          const start = lineStart + lead + a[0].length;
          const after = rest.slice(lit[0].length);
          const tc = /^\s*\/\/(.*)$/.exec(after);
          const trailing = tc ? tc[1].trim() : '';
          const h = trailing ? hint(trailing) : null;
          const { value, kind } = literalValue(lit[1]);
          found.push({
            name,
            value,
            kind,
            line: li + 1,
            start,
            end: start + lit[1].length,
            description: h ? prevLineComment : trailing || prevLineComment,
            section,
            range: kind === 'number' ? (h?.range ?? null) : null,
            options: h?.options ?? null,
          });
        }
      }
      const lc = /^\/\/(.*)$/.exec(trimmed);
      if (lc) lineCommentHere = lc[1].trim();
    }
    prevLineComment = lineCommentHere;

    /* Depth and block-comment state for the NEXT line: skip strings and comments. */
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inBlock) {
        if (c === '*' && text[i + 1] === '/') {
          inBlock = false;
          i++;
        }
        continue;
      }
      if (c === '/' && text[i + 1] === '/') break;
      if (c === '/' && text[i + 1] === '*') {
        inBlock = true;
        i++;
        continue;
      }
      if (c === '"') {
        for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
        continue;
      }
      if (c === '{' || c === '(' || c === '[') depth++;
      else if ((c === '}' || c === ')' || c === ']') && depth > 0) depth--;
    }
  }

  const params = found.filter((p) => {
    if ((assigned.get(p.name) ?? 0) > 1) {
      skipped.push({ name: p.name, line: p.line, why: 'assigned more than once at top level; OpenSCAD keeps the last one' });
      return false;
    }
    return true;
  });
  return { params, skipped };
}

function literalText(p: Param, v: ParamValue): string {
  if (p.kind === 'bool') return v ? 'true' : 'false';
  if (p.kind === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${p.name}: not a number`);
    return String(n);
  }
  return JSON.stringify(String(v));
}

/**
 * The source with ONE variable's literal replaced. Re-scans first and refuses
 * (throws) if the variable is no longer where `p` says, so a control built from
 * an older source can never write into the wrong place.
 */
export function setParam(src: string, p: Param, v: ParamValue): string {
  const now = scanParams(src).params.find((q) => q.name === p.name);
  if (!now) throw new Error(`${p.name} is no longer a top-level variable in this design`);
  return src.slice(0, now.start) + literalText(now, v) + src.slice(now.end);
}
