// THE SHOP — BROWSE cad's DESIGNS, PICK ONE, OPEN IT IN 2bee.cad.
//
// Founder, 2026-08-31: *"have the 1st page (before 2bee.scad) a shop style page
// so the user can 'shop for the designs', select it -> than it goes to
// 2bee.cad"*.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 IT IS A CATALOGUE, NOT A STORE. NOTHING HERE IS PRICED OR FOR SALE.
// ═══════════════════════════════════════════════════════════════════════════
//
// "Shop style" is the BROWSING metaphor — cards, families, a picture, pick one.
// It stops there. No price, no stock, no lead time, no "order" appears on this
// page, and none may be added here: pricing is `business/pricing-model.md` and
// is never quoted outward (root CLAUDE.md), and a number invented to make a card
// look complete would be a fabricated commercial claim on a customer-facing
// surface. If this ever needs commerce it comes from `sales` with real figures.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE CARD SHOWS THE MESHER'S TRUST VERDICT, AND IT IS NOT DECORATION
// ═══════════════════════════════════════════════════════════════════════════
//
// The thumbnail is rendered from OUR mesh (see the generator's header). For a
// `suspect` model the kernel refused constructs and they are MISSING FROM THE
// PICTURE — `2bee_schools_kit/schools_kit_assembly.scad` renders as two solids
// out of a kit. Showing that render under a confident title, with the verdict
// tucked away, would advertise a part the app does not produce. So the verdict
// rides on the card, the incomplete ones are visibly marked, and the default
// sort puts `trusted` first WITHOUT hiding the rest — a catalogue that silently
// omitted them would answer "what can I open?" with a subset and look complete.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  byFamily,
  loadCatalogue,
  loadDesign,
  trustLine,
  type CatalogueState,
  type ShopEntry,
} from './catalogue';
import { requestOpen } from './handoff';

const TRUST_ORDER: Record<string, number> = { trusted: 0, suspect: 1, untrusted: 2, nothing: 3 };

function sizeLabel(e: ShopEntry): string {
  if (!e.sizeMm) return 'size not measured';
  const [x, y, z] = e.sizeMm;
  return `${x} × ${y} × ${z} mm`;
}

export interface ShopTabProps {
  /** Switch to 2bee.cad once a design has been handed over. */
  onOpened: () => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export default function ShopTab({ onOpened, fetchImpl }: ShopTabProps) {
  const [state, setState] = useState<CatalogueState>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<string>('all');
  const [opening, setOpening] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void loadCatalogue(fetchImpl ?? fetch).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, [fetchImpl]);

  const entries = state.kind === 'ready' ? state.index.entries : [];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries
      .filter((e) => family === 'all' || e.family === family)
      .filter(
        (e) =>
          q === '' ||
          e.title.toLowerCase().includes(q) ||
          e.path.toLowerCase().includes(q) ||
          e.family.toLowerCase().includes(q),
      )
      .slice()
      .sort((a, b) => TRUST_ORDER[a.trust] - TRUST_ORDER[b.trust] || a.title.localeCompare(b.title));
  }, [entries, query, family]);

  const families = useMemo(() => byFamily(entries).map((f) => f.family), [entries]);

  const open = useCallback(
    async (e: ShopEntry) => {
      setOpening(e.id);
      setFailed(null);
      try {
        const d = await loadDesign(e.id, fetchImpl ?? fetch);
        requestOpen({
          id: e.id,
          title: e.title,
          path: d.path,
          source: d.sources[d.path],
          files: d.sources,
        });
        onOpened();
      } catch (err) {
        /* Reported on the card, not swallowed: a click that silently does
         * nothing is indistinguishable from a click that was not registered. */
        setFailed(`${e.title} could not be opened — ${String(err)}`);
      } finally {
        setOpening(null);
      }
    },
    [fetchImpl, onOpened],
  );

  if (state.kind === 'loading') {
    return <div className="shop-note" data-testid="shop-loading">Loading the catalogue…</div>;
  }

  if (state.kind === 'absent') {
    return (
      <div className="shop-note shop-note-warn" data-testid="shop-absent">
        <h2>The catalogue has not been built</h2>
        <p>{state.why}</p>
        <p>
          This is a <strong>build step, not an empty design library</strong>. The catalogue is
          generated from <code>hardware/cad/</code> at build time and is deliberately not committed,
          so a fresh checkout has none until <code>npm run shop</code> has run.
        </p>
      </div>
    );
  }

  const { index } = state;

  return (
    <div className="shop" data-testid="shop">
      <header className="shop-head">
        <h1>Designs</h1>
        <p className="shop-sub">
          {index.listed} design{index.listed === 1 ? '' : 's'} from <code>{index.cadRoot}</code>.
          Pick one and it opens in <strong>2bee.cad</strong>, with its imports.
        </p>
        <p className="shop-caveat">
          Listed only if <strong>this reader opens it</strong> — {index.dropped} of{' '}
          {index.listed + index.dropped} candidates were dropped, almost always an OpenSCAD feature
          2bee.cad has not implemented rather than a fault in the design. Nothing here is priced or
          for sale, and <strong>nothing here has ever been cut</strong>.
        </p>
        <p className="shop-caveat shop-caveat-loud" data-testid="shop-no-oracle">
          🔴 <strong>No design on this page has been checked against OpenSCAD.</strong> The badge on
          each card describes its <em>mesh</em> — closed, manifold, nothing refused — which is not
          the same claim as “this is the shape the source describes”, and the two can disagree
          silently. Measured 2026-08-31 against OpenSCAD 2026.08.07:{' '}
          <strong>10 of 47 designs whose mesh was clean still differed</strong>, one of them a flat
          part cut on the CNC, rendered at a tenth of its real size. Read the picture as{' '}
          <em>what this app builds</em>, never as what the part is.
        </p>
      </header>

      <div className="shop-controls">
        <input
          className="shop-search"
          type="search"
          placeholder="Search designs…"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          aria-label="Search designs"
          data-testid="shop-search"
        />
        <select
          className="shop-family"
          value={family}
          onChange={(ev) => setFamily(ev.target.value)}
          aria-label="Filter by family"
          data-testid="shop-family"
        >
          <option value="all">All families</option>
          {families.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>

      {failed ? (
        <p className="shop-failed" role="alert" data-testid="shop-failed">
          {failed}
        </p>
      ) : null}

      {shown.length === 0 ? (
        <p className="shop-empty" data-testid="shop-no-match">
          No design matches that filter. {entries.length} are in the catalogue.
        </p>
      ) : (
        <ul className="shop-grid" data-testid="shop-grid">
          {shown.map((e) => (
            <li key={e.id} className={`shop-card shop-trust-${e.trust}`} data-testid="shop-card">
              <button
                className="shop-card-btn"
                onClick={() => void open(e)}
                disabled={opening !== null}
                data-testid={`shop-open-${e.id}`}
                title={`Open ${e.title} in 2bee.cad`}
              >
                <span className="shop-thumb">
                  {e.thumb ? (
                    <img src={`shop/${e.thumb}`} alt={`${e.title} — rendered by 2bee.cad`} loading="lazy" />
                  ) : (
                    <span className="shop-thumb-none">no render</span>
                  )}
                </span>
                <span className="shop-card-body">
                  <span className="shop-card-title">{e.title}</span>
                  <span className="shop-card-family">{e.family} · {e.kind}</span>
                  <span className="shop-card-stats">
                    {sizeLabel(e)} · {e.parts} part{e.parts === 1 ? '' : 's'} ·{' '}
                    {e.triangles.toLocaleString()} triangles
                  </span>
                  <span className={`shop-badge shop-badge-${e.trust}`} data-testid={`shop-trust-${e.id}`}>
                    {/* 🔴 'mesh closed', NOT 'complete render' — ruled by ceo
                        2026-09-02. `trusted` is a statement about the MESH
                        (watertight, manifold, nothing refused or altered); it is
                        NOT a statement that the shape matches the source, and no
                        design here has been checked against an oracle. The old
                        word asserted a correctness nobody had verified, on cut
                        files we render wrongly — see the standing note below the
                        heading. A positive assurance becomes available only when
                        `OSCAD` can confirm one. */}
                    {e.trust === 'trusted' ? 'mesh closed' : e.trust}
                  </span>
                  <span className="shop-card-trust" title={e.trustDetail}>
                    {trustLine(e)}
                  </span>
                  {/* cad's sentence, shown verbatim. An undescribed design
                      renders NOTHING here — no placeholder, no "description
                      coming", no title restated as prose. An empty space is a
                      visible gap; a generated sentence is an invisible claim. */}
                  {(e.describes ?? []).map((d) => (
                    <span className="shop-card-desc" key={d.part}>
                      {(e.describes ?? []).length > 1 && (
                        <span className="shop-card-desc-part">{d.part}</span>
                      )}
                      {d.text}
                    </span>
                  ))}
                  <span className="shop-card-path">{e.path}</span>
                </span>
                <span className="shop-card-cta">
                  {opening === e.id ? 'Opening…' : 'Open in 2bee.cad →'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <footer className="shop-foot">
        <p>
          Generated {new Date(index.generatedAt).toLocaleString()} · scanned {index.scanned}{' '}
          <code>.scad</code> files.
        </p>
        {index.unlistedFamilies && index.unlistedFamilies.length > 0 ? (
          <p data-testid="shop-unlisted">
            ⚠ {index.unlistedFamilies.reduce((n, u) => n + u.count, 0)} design(s) this reader CAN
            open are in {index.unlistedFamilies.length} director
            {index.unlistedFamilies.length === 1 ? 'y' : 'ies'} this catalogue does not offer (
            {index.unlistedFamilies.map((u) => `${u.dir} ×${u.count}`).join(', ')}). That is a
            curation choice, not a reader limit — it is stated so it stays a decision rather than
            becoming a gap.
          </p>
        ) : null}
        {index.droppedReasons.length > 0 ? (
          <details data-testid="shop-dropped">
            <summary>{index.dropped} candidate(s) this reader could not open</summary>
            <ul>
              {index.droppedReasons.map((d) => (
                <li key={d.path}>
                  <code>{d.path}</code> — {d.why}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </footer>
    </div>
  );
}
