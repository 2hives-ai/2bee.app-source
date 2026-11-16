/**
 * Every component on the selected board — founder 2026-10-15: *"list each
 * components and when I hover the mouse highlight it in the pcb same when I point
 * a component in the pcb highlight it in the list"*.
 *
 * Rows are EVERY BOM part (`parts.ts`), positioned from the CPL or, for the parts
 * the CPL leaves out (hand-fitted, fab-placed), from the .kicad_pcb, each tagged
 * by who fits it. Hover or keyboard focus on a row makes it `hot`;
 * the 3D view highlights the same part. When the 3D makes a part hot, its row is
 * highlighted and scrolled into view.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardModel } from './boardModel';
import { BY_LABEL, type BoardParts, type By, type SequenceGroup } from './parts';

const byOf = (p: object): By => ((p as { by?: By }).by ?? 'machine');

/** The list's two facets (founder: "pnp: able to filter by side or 'by'"). */
export type SideFilter = 'all' | 'top' | 'bottom';
export type ByFilter = 'all' | 'machine' | 'hand' | 'other';
export interface PartFilter {
  side: SideFilter;
  by: ByFilter;
}
export const NO_FILTER: PartFilter = { side: 'all', by: 'all' };

/** `hand` = fitted by a person (THT or not); `other` = the fab, DNP, not placed, unknown tier. */
export function byGroup(b: By): Exclude<ByFilter, 'all'> {
  return b === 'machine' ? 'machine' : b === 'hand' || b === 'hand-tht' ? 'hand' : 'other';
}
export function passes(p: { side: 'top' | 'bottom' }, f: PartFilter): boolean {
  return (f.side === 'all' || p.side === f.side) && (f.by === 'all' || byGroup(byOf(p)) === f.by);
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function ComponentList({
  model,
  parts,
  countLine,
  partOf,
  hot,
  onHot,
  scrollToHot,
  filter = NO_FILTER,
  onFilter,
  sequence,
}: {
  model: BoardModel | null;
  /** Every BOM part with who fits it (`parts.ts`); null = CPL only. */
  parts?: BoardParts | null;
  /** "14 parts: 5 by machine (bottom), 9 by hand". */
  countLine?: string;
  /** Mfr_PN by reference, from the BOM. */
  partOf: ReadonlyMap<string, string>;
  hot: string | null;
  onHot(ref: string | null): void;
  /** True when `hot` came from the 3D: bring its row into view. */
  scrollToHot: boolean;
  /** Side / By facets — owned by the tab, because the 3D dims what they hide. */
  filter?: PartFilter;
  onFilter?(f: PartFilter): void;
  /** The assembly order (`assemblySequence`): rows are listed in it, numbered,
   *  under their group headers. Absent: by reference. */
  sequence?: SequenceGroup[];
}) {
  const [query, setQuery] = useState('');
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const parts = [...(model?.parts ?? [])].filter((p) => passes(p, filter)).sort((a, b) => natural.compare(a.ref, b.ref));
    return q
      ? parts.filter((p) => [p.ref, p.value, p.pkg, partOf.get(p.ref) ?? ''].some((t) => t.toLowerCase().includes(q)))
      : parts;
  }, [model, partOf, query, filter]);
  /* Rows in assembly order, with group headers; a step number is the part's
   * place in the WHOLE sequence, so it does not change when a filter hides
   * others. Parts the sequence does not name (none, today) go last. */
  const ordered = useMemo(() => {
    const shown = new Map(rows.map((p) => [p.ref, p]));
    if (!sequence?.length) return rows.map((p) => ({ p, step: undefined as number | undefined }));
    const out: ({ group: SequenceGroup } | { p: (typeof rows)[number]; step: number | undefined })[] = [];
    let n = 0;
    const named = new Set<string>();
    for (const g of sequence) {
      const inG = g.refs.map((ref) => ({ ref, step: ++n })).filter((x) => shown.has(x.ref));
      g.refs.forEach((r) => named.add(r));
      if (!inG.length) continue;
      out.push({ group: g });
      for (const x of inG) out.push({ p: shown.get(x.ref)!, step: x.step });
    }
    for (const p of rows) if (!named.has(p.ref)) out.push({ p, step: undefined });
    return out;
  }, [rows, sequence]);
  // A render FUNCTION, not a component defined in here: a component type made
  // anew each render remounts every row, and a focused row loses its focus.
  const renderRow = (p: (typeof rows)[number], step?: number) => (
    <tr
                      key={p.ref}
                      data-ref={p.ref}
                      data-testid={`pnp-comp-${p.ref}`}
                      className={p.ref === hot ? 'hot' : undefined}
                      aria-selected={p.ref === hot}
                      tabIndex={0}
                      onMouseEnter={() => onHot(p.ref)}
                      onFocus={() => onHot(p.ref)}
                      onBlur={() => onHot(null)}
                    >
                      <td className="pnp-step">{step ?? ''}</td>
                      <td>
                        <strong>{p.ref}</strong>
                      </td>
                      <td>
                        <span className={`pnp-by ${byOf(p)}`}>{BY_LABEL[byOf(p)]}</span>
                      </td>
                      <td>{p.value}</td>
                      <td>{partOf.get(p.ref) ?? ''}</td>
                      <td title={p.pkg}>{p.pkg}</td>
                      <td>{p.side}</td>
                      <td>{p.x.toFixed(2)}</td>
                      <td>{p.y.toFixed(2)}</td>
                      <td>{p.rot}</td>
                    </tr>
  );

  /* Counts per option, under the OTHER facet's current choice (so a number is
   * what clicking it would show); 0 is shown, never hidden. */
  const all = model?.parts ?? [];
  const sideCount = (v: SideFilter) => all.filter((p) => passes(p, { ...filter, side: v })).length;
  const byCount = (v: ByFilter) => all.filter((p) => passes(p, { ...filter, by: v })).length;
  const pill = <T extends string>(group: 'side' | 'by', v: T, label: string, n: number) => {
    const on = filter[group] === v;
    return (
      <button
        key={v}
        type="button"
        className={`pnp-pill${on ? ' on' : ''}`}
        aria-pressed={on}
        data-testid={`pnp-filter-${group}-${v}`}
        onClick={() => onFilter?.({ ...filter, [group]: v })}
      >
        {label} <span className="pnp-pill-n">{n}</span>
      </button>
    );
  };
  const body = useRef<HTMLTableSectionElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hot || !scrollToHot) return;
    const el = body.current?.querySelector<HTMLElement>(`[data-ref="${CSS.escape(hot)}"]`);
    const sc = scroller.current;
    if (!el || !sc) return;
    /* Scroll the LIST only. `scrollIntoView` also scrolls every scrollable
     * ancestor — the tab panel — which moves the 3D under a still pointer, and
     * the browser's hover update then picks a different part: the highlight
     * jumped away from what the user was pointing at. */
    const head = (sc.querySelector('thead') as HTMLElement | null)?.offsetHeight ?? 0;
    const r = el.getBoundingClientRect();
    const c = sc.getBoundingClientRect();
    if (r.top < c.top + head) sc.scrollTop += r.top - (c.top + head);
    else if (r.bottom > c.bottom) sc.scrollTop += r.bottom - c.bottom;
  }, [hot, scrollToHot]);

  return (
    <section className="pnp-card pnp-components" data-testid="pnp-components" aria-label="Components">
      <header className="pnp-card-head">
        <strong>Components</strong>
        <span className="pnp-card-note" data-testid="pnp-components-count">
          {countLine || (model ? `${model.parts.length} placed` : '')}
        </span>
      </header>
      {!model ? (
        <p className="pnp-card-note">Choose a board to list its components.</p>
      ) : (
        <>
          <input
            type="search"
            className="pnp-board-search"
            placeholder="Filter by ref, value, package, part…"
            aria-label="Filter components"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="pnp-filters" data-testid="pnp-filters">
            <span className="pnp-filter-group" role="group" aria-label="Side">
              <span className="pnp-filter-label">Side</span>
              {pill('side', 'all', 'All', sideCount('all'))}
              {pill('side', 'top', 'Top', sideCount('top'))}
              {pill('side', 'bottom', 'Bottom', sideCount('bottom'))}
            </span>
            <span className="pnp-filter-group" role="group" aria-label="By">
              <span className="pnp-filter-label">By</span>
              {pill('by', 'all', 'All', byCount('all'))}
              {pill('by', 'machine', 'Machine', byCount('machine'))}
              {pill('by', 'hand', 'Hand', byCount('hand'))}
              {all.some((p) => byGroup(byOf(p)) === 'other') ? pill('by', 'other', 'Fab / DNP', byCount('other')) : null}
            </span>
          </div>
          <div className="pnp-components-scroll" ref={scroller}>
            <table className="pnp-lanes pnp-comp-table">
              <thead>
                <tr>
                  {['#', 'Ref', 'By', 'Value', 'Part', 'Package', 'Side', 'X', 'Y', 'Rot'].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody ref={body} onMouseLeave={() => onHot(null)}>
                {ordered.map((item) =>
                  'group' in item ? (
                    <tr key={`g-${item.group.title}`} className="pnp-seq-head" data-testid="pnp-seq-group">
                      <td colSpan={10}>
                        <strong>{item.group.title}</strong> <span className="pnp-seq-basis">{item.group.basis}</span>
                      </td>
                    </tr>
                  ) : (
                    renderRow(item.p, item.step)
                  )
                )}
              </tbody>
            </table>
          </div>
                    {parts?.unplaced.length ? (
            <p className="pnp-card-note bad" data-testid="pnp-components-unplaced">
              In the BOM with no position (no CPL row, no footprint): {parts.unplaced.map((u) => `${u.ref} (${BY_LABEL[u.by]})`).join(', ')}
            </p>
          ) : null}
          {parts && parts.nonParts ? (
            <p className="pnp-card-note">{parts.nonParts} footprint(s) on the board are not parts (fiducials, holes, test points) and are not listed.</p>
          ) : null}
          {model.unreadable.length ? (
            <p className="pnp-card-note bad">No position in the CPL: {model.unreadable.join(', ')}</p>
          ) : null}
        </>
      )}
    </section>
  );
}

export default ComponentList;
