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

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  byFamily,
  loadCatalogue,
  loadDesign,
  trustLine,
  trustShort,
  type CatalogueState,
  type ShopEntry,
} from './catalogue';
import { requestOpenIn, type HandoffTarget, type OpenTarget } from './handoff';
import { BLANK_MODEL } from '../cad/blank';
import { designToCnc, designToStl } from './toCnc';
import { MineShelf, useMine } from './MineShelf';
import { PcbShelf, usePcbBoards, type PcbState } from './PcbShelf';
import { ArchivedShelf } from './ArchivedShelf';
import { ARCHIVE_TITLE, archiveKeyOfEntry, archiveKeyOfMine, archiveKeyOfPcb, useArchive } from './archive';
import { machineFor } from '../make/setup';
import './shopCard.css';
import { catalogueSubject, DesignViewer, ThumbButton } from './DesignViewer';
import { ShopChat } from './ShopChat';
import { SHOW_VALUES, type ShopAction, type ShopAskContext, type ShowFilter } from './shopAsk';
import './shopChat.css';
import {
  loadExternal,
  statusLine as externalStatusLine,
  statusOf,
  type ExternalState,
} from './external';

const SHOW_ORDER: readonly ShowFilter[] = SHOW_VALUES;
const SHOW_LABEL: Record<ShowFilter, string> = { all: 'All', '3d': '3d', cad: 'cad', pcb: 'pcb', mine: 'Mine', archived: 'Archived' };

const TRUST_ORDER: Record<string, number> = { trusted: 0, suspect: 1, untrusted: 2, nothing: 3 };

function sizeLabel(e: ShopEntry): string {
  if (!e.sizeMm) return 'size not measured';
  const [x, y, z] = e.sizeMm;
  return `${x} × ${y} × ${z} mm`;
}

export interface ShopTabProps {
  /**
   * Switch to the tab the design was handed to. `target` is `'cad'`, `'cnc'` or
   * `'3d'` (founder 2026-10-15: *"open every item in cad , cnc or 3d"*), or
   * `'pnp'` for a PCB card (the board id goes through `pnp/pnpHandoff.ts`). The
   * receiving tab claims it with `claimPendingFor(target)` /
   * `subscribeHandoffFor(target, …)` from `./handoff`.
   */
  onOpened: (target: OpenTarget) => void;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

export default function ShopTab({ onOpened, fetchImpl }: ShopTabProps) {
  const [state, setState] = useState<CatalogueState>({ kind: 'loading' });
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<string>('all');
  /** Founder 2026-10-15: "filter to see only my designs what I changed and saved". */
  /* Founder 2026-10-15: "able to filter designs by 3d, cad, pcb". 3d = printed on the X2D
   * (`_3d`), cad = cut on the router (`_wcnc`), pcb = pnp's boards. Assemblies and other
   * kinds are neither, and appear under All only. */
  const [show, setShow] = useState<ShowFilter>('all');
  const mine = useMine();
  const pcbs = usePcbBoards();
  /* Founder 2026-10-16: "in the design able to archive". A per-browser hide-list (`archive.ts`);
   * archived cards leave every list below and appear only under Archived. Nothing is deleted. */
  const archive = useArchive();
  const archivedSet = useMemo(() => new Set(archive.keys), [archive.keys]);
  const liveEntries = useMemo(
    () => (state.kind === 'ready' ? state.index.entries : []).filter((e) => !archivedSet.has(archiveKeyOfEntry(e))),
    [state, archivedSet],
  );
  const liveMine = useMemo(() => (mine.items ? mine.items.filter((m) => !archivedSet.has(archiveKeyOfMine(m))) : null), [mine.items, archivedSet]);
  /* The PCB shelf is handed a list with the archived boards already taken out. */
  const livePcbs: PcbState = useMemo(
    () => (pcbs.kind === 'ready' ? { ...pcbs, boards: pcbs.boards.filter((b) => !archivedSet.has(archiveKeyOfPcb(b.id))) } : pcbs),
    [pcbs, archivedSet],
  );
  /** `${id}:${target}` while a card's action is running. */
  const [opening, setOpening] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** The design whose 3D view is open, if any. */
  const [viewing, setViewing] = useState<ShopEntry | null>(null);
  /* Memoised: the viewer rebuilds when its subject's IDENTITY changes, so a fresh object per render would restart it forever. */
  const viewingSubject = useMemo(() => (viewing ? catalogueSubject(viewing, fetchImpl) : null), [viewing, fetchImpl]);
  const [ext, setExt] = useState<ExternalState>({ kind: 'loading' });
  /**
   * Progress for the one slow thing this tab does.
   *
   * 🔴 THE PHASES ARE REAL AND THE BAR IS DETERMINATE OVER THEM. Opening a
   * design fetches its whole import closure and then hands it to a reader that
   * parses and meshes it synchronously — seconds, on a big part, with the UI
   * frozen for the second half. A spinner would say "something is happening";
   * this says WHICH thing, so a stall is attributable.
   *
   * ⚠ IT DOES NOT CLAIM TO MEASURE THE PARSE. The parse and mesh run inside
   * `CadTab`, on the main thread, and nothing can sample them from here. The
   * last phase is named `handing over` and the bar stops there rather than
   * inventing a percentage for work this component cannot see — an invented
   * number would be exactly the "describes the plan, not the output" defect this
   * lane keeps finding, on a progress bar.
   */
  const [progress, setProgress] = useState<{ phase: string; step: number; steps: number } | null>(null);

  useEffect(() => {
    let live = true;
    void loadCatalogue(fetchImpl ?? fetch).then((s) => {
      if (live) setState(s);
    });
    // The external shelf is loaded SEPARATELY and its absence is not the
    // catalogue's absence: a tree with no `external.json` still has cad's
    // designs, and rendering one missing file as "no designs" would repeat the
    // defect `catalogue.ts` exists to avoid, one shelf along.
    void loadExternal(fetchImpl ?? fetch).then((s) => {
      if (live) setExt(s);
    });
    return () => {
      live = false;
    };
  }, [fetchImpl]);

  /** Every catalogue entry, archived or not: the assistant and the Archived shelf name them all. */
  const entries = state.kind === 'ready' ? state.index.entries : [];

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return liveEntries
      .filter((e) => family === 'all' || e.family === family)
      .filter((e) => show !== '3d' || machineFor(e.path) === 'printer')
      .filter((e) => show !== 'cad' || machineFor(e.path) === 'router')
      .filter(
        (e) =>
          q === '' ||
          e.title.toLowerCase().includes(q) ||
          e.path.toLowerCase().includes(q) ||
          e.family.toLowerCase().includes(q),
      )
      .slice()
      .sort((a, b) => TRUST_ORDER[a.trust] - TRUST_ORDER[b.trust] || a.title.localeCompare(b.title));
  }, [liveEntries, query, family, show]);

  /** Per-filter counts, over the whole catalogue (not the search). `null` = still loading; a 0 is shown as 0. */
  const showCount: Record<ShowFilter, number | null> = {
    all: liveEntries.length,
    '3d': liveEntries.filter((e) => machineFor(e.path) === 'printer').length,
    cad: liveEntries.filter((e) => machineFor(e.path) === 'router').length,
    pcb: livePcbs.kind === 'ready' ? livePcbs.boards.length : livePcbs.kind === 'absent' ? 0 : null,
    mine: liveMine ? liveMine.length : mine.error ? 0 : null,
    /* The length of the list, including keys whose item is gone — the shelf lists those too. */
    archived: archive.keys.length,
  };

  const families = useMemo(() => byFamily(entries).map((f) => f.family), [entries]);

  const open = useCallback(
    /** Resolves to the failure sentence, or null when the design was handed over. */
    async (e: ShopEntry, target: HandoffTarget = 'cad'): Promise<string | null> => {
      const where = target === 'cad' ? '2bee.cad' : target;
      setOpening(`${e.id}:${target}`);
      setFailed(null);
      const steps = target === 'cad' ? 3 : 4;
      setProgress({ phase: `fetching ${e.title} and its imports`, step: 1, steps });
      try {
        const d = await loadDesign(e.id, fetchImpl ?? fetch);
        const design = { id: e.id, title: e.title, path: d.path, source: d.sources[d.path], files: d.sources };
        if (target === 'cnc') {
          /* 🔴 The CNC tab plans from the DRAWINGS list, so the design is meshed and saved
           * there first, through 2bee.cad's own Save route (toCnc.ts) — refusals included. */
          setProgress({ phase: `${Object.keys(d.sources).length} file(s) read — building the solid and saving it to the drawings list`, step: 2, steps });
          const r = await designToCnc(design, { parts: e.parts });
          if (!r.ok) throw new Error(`it was NOT sent to cnc: ${r.why}`);
          setProgress({ phase: `saved as "${r.cnc.drawingName}" — handing over to cnc`, step: 3, steps });
          requestOpenIn('cnc', { id: e.id, title: e.title, cnc: r.cnc });
        } else if (target === '3d') {
          /* The 3d tab slices STL; the design is meshed off the page and handed over as one. */
          setProgress({ phase: `${Object.keys(d.sources).length} file(s) read — building the solid as an STL`, step: 2, steps });
          const r = await designToStl(design, { parts: e.parts });
          if (!r.ok) throw new Error(`it was NOT sent to 3d: ${r.why}`);
          requestOpenIn('3d', { ...design, stl: r.stl });
        } else {
          setProgress({ phase: `${Object.keys(d.sources).length} file(s) read — handing over to ${where}`, step: 2, steps });
          requestOpenIn(target, design);
        }
        setProgress({ phase: `opening in ${where}`, step: steps, steps });
        onOpened(target);
        return null;
      } catch (err) {
        /* Reported on the card, not swallowed: a click that silently does
         * nothing is indistinguishable from a click that was not registered. */
        const why = `${e.title} could not be opened in ${where} — ${String(err)}`;
        setFailed(why);
        return why;
      } finally {
        setOpening(null);
        setProgress(null);
      }
    },
    [fetchImpl, onOpened],
  );

  /* ── The assistant column (founder 2026-10-16). It sees what the cards show
   *    and acts only through the page's own setters and `open()`. ── */
  const boards = useMemo(() => (pcbs.kind === 'ready' ? pcbs.boards.map((b) => ({ id: b.id, name: b.name, detail: b.detail })) : []), [pcbs]);
  /** Ids (not keys) of archived designs and boards, so the assistant can name them. */
  const archivedIds = useMemo(
    () => [
      ...entries.filter((e) => archivedSet.has(archiveKeyOfEntry(e))).map((e) => e.id),
      ...boards.filter((b) => archivedSet.has(archiveKeyOfPcb(b.id))).map((b) => b.id),
    ],
    [entries, boards, archivedSet],
  );
  const askCtx: ShopAskContext = useMemo(
    () => ({ entries, boards, families, view: { search: query, show, family }, machineOf: machineFor, archivedIds }),
    [entries, boards, families, query, show, family, archivedIds],
  );
  const onActions = useCallback(
    async (actions: ShopAction[]): Promise<string[]> => {
      const failures: string[] = [];
      for (const a of actions) {
        if (a.type === 'search') setQuery(a.text);
        else if (a.type === 'show') setShow(a.value);
        else if (a.type === 'family') setFamily(a.value);
        else if (a.type === 'view') {
          const e = entries.find((x) => x.id === a.id);
          if (e) setViewing(e);
          else failures.push(`No design "${a.id}" to view.`);
        } else if (a.type === 'archive' || a.type === 'restore') {
          /* readShopReply has already checked the id is a design or board, and its archived state. */
          const e = entries.find((x) => x.id === a.id);
          const key = e ? archiveKeyOfEntry(e) : archiveKeyOfPcb(a.id);
          if (a.type === 'archive') archive.archive(key);
          else archive.restore(key);
        } else if (a.type === 'open') {
          if (a.target === 'pnp') {
            if (pcbs.kind === 'ready' && pcbs.boards.some((b) => b.id === a.id)) {
              pcbs.open(a.id);
              onOpened('pnp');
            } else failures.push(`The PCB "${a.id}" is not in the board list, so nothing was opened.`);
          } else {
            const e = entries.find((x) => x.id === a.id);
            if (!e) failures.push(`No design "${a.id}", so nothing was opened.`);
            else if (opening !== null) failures.push('Another design is still opening; try again in a moment.');
            else {
              const why = await open(e, a.target);
              if (why) failures.push(why);
            }
          }
        }
      }
      return failures;
    },
    [entries, pcbs, onOpened, open, opening, archive],
  );
  const withChat = (main: ReactNode) => (
    <div className="shop-ai" data-testid="shop-ai">
      <ShopChat ctx={askCtx} onActions={onActions} ready={state.kind === 'ready'} />
      <div className="shop-ai-main">{main}</div>
    </div>
  );

  if (state.kind === 'loading') {
    return withChat(<div className="shop-note" data-testid="shop-loading">Loading the catalogue…</div>);
  }

  if (state.kind === 'absent') {
    return withChat(
      <div className="shop-note shop-note-warn" data-testid="shop-absent">
        <h2>The catalogue has not been built</h2>
        <p>{state.why}</p>
        <p>
          This is a <strong>build step, not an empty design library</strong>. The catalogue is
          generated from <code>hardware/cad/</code> at build time and is deliberately not committed,
          so a fresh checkout has none until <code>npm run shop</code> has run.
        </p>
      </div>,
    );
  }

  const { index } = state;

  return withChat(
    <div className="shop" data-testid="shop">
      <header className="shop-head">
        <h1>Designs</h1>
        <p className="shop-sub">
          {index.listed} design{index.listed === 1 ? '' : 's'} from <code>{index.cadRoot}</code>. Pick
          one to open it in <strong>2bee.cad</strong>.
        </p>
        {/* Founder 2026-10-12, "too many words": these two paragraphs were ~110
            words. Every fact is kept; the explanation of WHY a clean mesh can
            still be the wrong shape moved to the title tooltip. */}
        <p className="shop-caveat">
          {index.dropped} of {index.listed + index.dropped} candidates are not listed because this
          reader cannot open them. Not for sale. <strong>Nothing here has been cut.</strong>
        </p>
        <p
          className="shop-caveat shop-caveat-loud"
          data-testid="shop-no-oracle"
          title={
            'The badge describes the MESH (closed, manifold, nothing refused). That is not the claim ' +
            '"this is the shape the source describes", and the two can disagree silently. Measured ' +
            '2026-08-31 against OpenSCAD 2026.08.07: 10 of 47 clean-mesh designs still differed, one ' +
            'of them a CNC flat part rendered at a tenth of its real size.'
          }
        >
          🔴 <strong>Not checked against OpenSCAD</strong> — 10 of 47 clean meshes still differed.
          The picture is what this app builds, not the part.
        </p>
      </header>

      <div className="shop-controls">
        {/* Founder 2026-11-13: "how can I create a new cad design? where is the new button?"
            cad stays disabled until something is loaded into it, so the empty design starts here. */}
        <button
          type="button"
          className="primary"
          data-testid="shop-new-design"
          title="Open an empty design in 2bee.cad; describe it to the AI or write it"
          onClick={() => {
            requestOpenIn('cad', { id: 'new', title: 'New design', path: 'new.scad', source: BLANK_MODEL, files: { 'new.scad': BLANK_MODEL } });
            onOpened('cad');
          }}
        >
          New design
        </button>
        <div className="shop-show" role="group" aria-label="Show">
          {SHOW_ORDER.map((v) => (
            <button
              key={v}
              type="button"
              className="shop-show-btn"
              aria-pressed={show === v}
              onClick={() => setShow(v)}
              data-testid={`shop-show-${v}`}
            >
              {SHOW_LABEL[v]} <span className="shop-show-n">{showCount[v] ?? '…'}</span>
            </button>
          ))}
        </div>
        <input
          className="shop-search"
          type="search"
          placeholder="Search designs…"
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          aria-label="Search designs"
          data-testid="shop-search"
        />
        {show !== 'mine' && show !== 'pcb' && show !== 'archived' ? (
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
        ) : null}
      </div>

      {progress ? (
        <div className="shop-progress" role="status" aria-live="polite" data-testid="shop-progress">
          <progress value={progress.step} max={progress.steps} aria-label="Opening a design" />
          <span className="shop-progress-phase" data-testid="shop-progress-phase">
            {progress.phase} ({progress.step}/{progress.steps})
          </span>
          {/* ⚠ Said on screen, not only in the code: the last stretch is not
              measurable from here, so the bar stops rather than creeping. */}
          <span className="shop-progress-note" title="The last step parses and meshes on this thread, so this bar cannot sample it.">
            The last step can take a few seconds.
          </span>
        </div>
      ) : null}

      {failed ? (
        <p className="shop-failed" role="alert" data-testid="shop-failed">
          {failed}
        </p>
      ) : null}

      {archive.writeFailed ? (
        <p className="shop-failed" role="alert" data-testid="shop-archive-write-failed">
          This browser refused to remember the archive list, so the change lasts only until the page reloads.
        </p>
      ) : null}

      {show === 'archived' ? (
        <ArchivedShelf
          keys={archive.keys}
          entries={entries}
          mine={mine.items ?? (mine.error ? [] : null)}
          boards={pcbs.kind === 'ready' ? pcbs.boards : pcbs.kind === 'absent' ? [] : null}
          query={query}
          onRestore={archive.restore}
        />
      ) : show === 'mine' ? (
        <MineShelf items={liveMine} error={mine.error} query={query} onOpened={onOpened} onArchive={(m) => archive.archive(archiveKeyOfMine(m))} />
      ) : show === 'pcb' ? (
        <PcbShelf state={livePcbs} query={query} onOpened={onOpened} onArchive={(id) => archive.archive(archiveKeyOfPcb(id))} />
      ) : shown.length === 0 ? (
        <p className="shop-empty" data-testid="shop-no-match">
          No design matches that filter. {entries.length} are in the catalogue
          {entries.length > liveEntries.length ? `, ${entries.length - liveEntries.length} of them archived` : ''}.
        </p>
      ) : (
        <ul className="shop-grid" data-testid="shop-grid">
          {shown.map((e) => (
            <li key={e.id} className={`shop-card shop-card-split shop-trust-${e.trust}`} data-testid="shop-card">
              {/* Founder 2026-10-15: clicking the picture opens the 3D view. It is
                  its own button, beside (not inside) the card's open action. */}
              <ThumbButton entry={e} onView={setViewing} />
              <div className="shop-card-body">
                <span className="shop-card-title">{e.title}</span>
                <span className="shop-card-family">{e.family} · {e.kind}</span>
                <span className="shop-card-stats">
                  {sizeLabel(e)} · {e.parts} part{e.parts === 1 ? '' : 's'}
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
                {trustShort(e) ? (
                  <span className="shop-card-trust" title={trustLine(e)}>
                    {trustShort(e)}
                  </span>
                ) : null}
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
                <button
                  type="button"
                  className="shop-card-archive"
                  onClick={() => archive.archive(archiveKeyOfEntry(e))}
                  title={ARCHIVE_TITLE}
                  data-testid={`shop-archive-${e.id}`}
                >
                  Archive
                </button>
              </div>
              <div className="shop-card-actions" role="group" aria-label={`Open ${e.title} in`}>
                {(['cad', 'cnc', '3d'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="shop-card-act"
                    onClick={() => void open(e, t)}
                    disabled={opening !== null}
                    data-testid={t === 'cad' ? `shop-open-${e.id}` : `shop-open-${t}-${e.id}`}
                    title={
                      t === 'cad'
                        ? `Open ${e.title} in 2bee.cad`
                        : t === 'cnc'
                          ? `Send ${e.title} to cnc — it is cut as ONE flat section at one height`
                          : `Open ${e.title} in 3d`
                    }
                  >
                    {opening === `${e.id}:${t}` ? 'Opening…' : `Open in ${t}`}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {viewingSubject && viewing ? (
        <DesignViewer
          entry={viewingSubject}
          onClose={() => setViewing(null)}
          onOpenInCad={() => onOpened('cad')}
          onArchive={() => archive.archive(archiveKeyOfEntry(viewing))}
        />
      ) : null}

      {show === 'all' ? <ExternalShelf state={ext} /> : null}

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
    </div>,
  );
}


/**
 * THE SECOND SHELF — designs that are NOT ours.
 *
 * 🔴 EVERY CARD NAMES ITS AUTHOR AND ITS LICENCE, AND LINKS OUT. Nothing here is
 * republished by us and nothing here opens in 2bee.cad: the collector stores
 * metadata, the verifier opens the design LOCALLY to find out whether this app
 * can read it, and the card reports that answer. A visitor who could not tell
 * these from the company's own designs would have been misled about what this
 * company has built.
 *
 * 🔴 THREE STATES, NEVER TWO. `opens`, `refused-by-reader` and `untested` are
 * different facts and the third is the one most likely to be read as a pass — it
 * is what a collect-only run leaves behind. `statusOf`/`statusLine` compute them
 * in one place so this component cannot collapse them.
 */
function ExternalShelf({ state }: { state: ExternalState }) {
  if (state.kind === 'loading') {
    return <p className="shop-note" data-testid="shop-external-loading">Loading the external shelf…</p>;
  }
  if (state.kind === 'absent') {
    // ⚠ A BUILD FACT, and deliberately quiet: the cad catalogue above is the
    // product surface, and a missing external shelf must not read as an error in
    // it. It says what to run and stops.
    return (
      <p className="shop-note" data-testid="shop-external-absent">
        No external design shelf in this build. {state.why}
      </p>
    );
  }

  const { index } = state;
  const opens = index.entries.filter((d) => statusOf(d) === 'opens');
  const untested = index.entries.filter((d) => statusOf(d) === 'untested');
  const refused = index.entries.filter((d) => statusOf(d) === 'refused-by-reader');
  // Openable first, then untested, then the ones this reader could not open —
  // sorted by fact, not by stars, so the shelf leads with what a visitor can use.
  const shown = [...opens, ...untested, ...refused];

  return (
    <section className="shop-external" data-testid="shop-external">
      <h2>From the wider world — not ours</h2>
      <p className="shop-sub">
        {index.listed} openly-licensed design{index.listed === 1 ? '' : 's'} found on public GitHub.{' '}
        <strong>None of these are 2bee designs</strong>, none are hosted by us, and each card links to its
        source and names its author and licence.
      </p>
      <p className="shop-caveat">
        {opens.length} opened in this app when last tested · {refused.length} this reader could not open ·{' '}
        {untested.length} <strong>not tested</strong>, which is neither. {index.refused} candidate
        {index.refused === 1 ? ' was' : 's were'} refused before listing (no licence, non-commercial, or a
        licence nobody here has reviewed) and {index.unchecked} could not be decided this run.
      </p>

      {shown.length === 0 ? (
        <p className="shop-empty" data-testid="shop-external-empty">
          The shelf is built and holds nothing. That is a real measurement, not a missing file: see the
          refused and unchecked counts above.
        </p>
      ) : (
        <ul className="shop-grid shop-grid-external" data-testid="shop-external-grid">
          {shown.map((d) => (
            <li key={d.id} className={`shop-card shop-card-external shop-ext-${statusOf(d)}`} data-testid="shop-external-card">
              <a
                className="shop-card-btn"
                href={d.url}
                target="_blank"
                rel="noopener noreferrer"
                data-testid={`shop-external-${d.id}`}
                title={`Open ${d.repo} on GitHub — this design is not hosted here`}
              >
                <span className="shop-card-body">
                  <span className="shop-card-title">{d.title}</span>
                  <span className="shop-card-family">{d.repo}</span>
                  {d.description ? <span className="shop-card-desc">{d.description}</span> : null}
                  <span className={`shop-badge shop-badge-ext-${statusOf(d)}`} data-testid={`shop-external-status-${d.id}`}>
                    {statusOf(d) === 'opens' ? 'opens in this app' : statusOf(d) === 'untested' ? 'not tested' : 'this reader refused it'}
                  </span>
                  <span className="shop-card-trust">{externalStatusLine(d)}</span>
                  {/* The licence obligation this lane can actually meet, rendered
                      rather than stored: an attribution nobody sees discharges
                      nothing. */}
                  <span className="shop-card-licence" data-testid={`shop-external-licence-${d.id}`}>
                    {d.licence}
                    {d.shareAlike ? ' · share-alike' : ''} — {d.attribution}
                  </span>
                  <span className="shop-card-path">{d.verified?.entry ?? `${d.files.length} openable file(s)`}</span>
                </span>
                <span className="shop-card-cta">View source on GitHub →</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {index.refusedReasons.length > 0 ? (
        <details data-testid="shop-external-refused">
          <summary>{index.refused} candidate(s) refused before listing</summary>
          <ul>
            {index.refusedReasons.map((r) => (
              <li key={r.repo}>
                <code>{r.repo}</code> — {r.why}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
