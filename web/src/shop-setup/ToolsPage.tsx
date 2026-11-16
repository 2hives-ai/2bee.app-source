/* ToolsPage — REGISTER THE CUTTERS THIS SHOP HAS, ONCE.
 *
 * Founder, 2026-10-14: *"similar to the tools, have a tools page and I will add /
 * remove, make a photo of all tools what will be registered to the system?"*,
 * *"if measurement needed the system will show what needs to be measured and
 * how"*, *"show it in 3d!"*, and the standing *"simple as possible, no extra
 * buttons"*.
 *
 * One list, one Add button, per cutter a Photo and a Remove. The records are
 * `inventory.ts` entries of kind `'tool'` (see `toolRegistry.ts`); the photos
 * are in IndexedDB (see `toolPhotos.ts`). The planner chooses cutters from this
 * list; the AI must not invent one, which is why a human registers them here.
 *
 * 2026-10-15 (founder: *"able to photo the tool and ai should recognise it"*):
 * "Photo the cutter" asks the AI and FILLS the measured form with its proposal.
 * Later the same day: *"cnc.tools is the same (ai is on the left side, and user
 * should able to add/phot a new tool"* — so the page is `.cad-simple` like
 * cnc.machines: the assistant (`ToolChat.tsx`, words and/or a photo) on the
 * left, the tool view + list + form on the right. 🔴 It never registers: the human checks the
 * fields (each AI-filled one is marked) and presses Register, and the same
 * `validateToolDraft` decides. The photo is kept as the cutter's photo only
 * once it is registered.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import ObjectPicker from '../ObjectPicker';
import { toolLibrary, type ToolLibrary, type ToolRow } from '../cam';
import { readInventory, writeInventory, type InventoryDoc } from '../inventory';
import { useCncStore } from '../store/cncStore';
import Measure3D from './Measure3D';
import { endMillScene } from './measureSpec';
import {
  EMPTY_DRAFT,
  FLUTE_DIRECTIONS,
  TOOL_TYPES,
  catalogueDetail,
  fieldGuide,
  fieldsFor,
  registerCatalogueTool,
  registerShopTool,
  registeredTools,
  removeToolAndPhoto,
  validateToolDraft,
  type FieldProblem,
  type MeasuredField,
  type ToolDraft,
} from './toolRegistry';
import { downscaleImage, indexedDbPhotoStore, type ToolPhotoStore } from './toolPhotos';
import ToolChat from './ToolChat';
import { ToolShape, type ToolShapeTool } from '../toolShape';
import { describeTool3D } from '../tool3d/geometry';
import type { ToolProposal } from './toolPhotoAsk';
import './tools.css';

export interface InventoryIO {
  read(): Promise<{ doc: InventoryDoc }>;
  write(doc: InventoryDoc, now: number): Promise<void>;
}

export interface ToolsPageProps {
  /** Photo storage. Default: IndexedDB in this browser. */
  photos?: ToolPhotoStore;
  /** The core's cutter list. Default: `cam.ts::toolLibrary()`. */
  loadLibrary?: () => Promise<ToolLibrary>;
  /** Where the registry is read and written. Default: `inventory.ts`. */
  inventory?: InventoryIO;
}

const DEFAULT_IO: InventoryIO = {
  read: readInventory,
  write: async (doc, now) => {
    await writeInventory(doc, now);
    /* Keep the app's in-memory copy in step, so a later write from another
     * panel does not overwrite this one with an older document. */
    useCncStore.getState().setInventory(doc);
  },
};

type AddMode = null | 'catalogue' | 'new';

export default function ToolsPage({ photos: photosProp, loadLibrary = toolLibrary, inventory = DEFAULT_IO }: ToolsPageProps) {
  const photos = useMemo(() => photosProp ?? indexedDbPhotoStore(), [photosProp]);
  const [doc, setDoc] = useState<InventoryDoc | null>(null);
  const [library, setLibrary] = useState<ToolRow[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [add, setAdd] = useState<AddMode>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [draft, setDraft] = useState<ToolDraft>(EMPTY_DRAFT);
  const [problems, setProblems] = useState<FieldProblem[]>([]);
  const [focused, setFocused] = useState<MeasuredField | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Fields the AI filled and the human has not edited since. Marked on screen. */
  const [aiFilled, setAiFilled] = useState<ReadonlySet<keyof ToolDraft>>(new Set());
  /** The photo the AI saw; stored as the cutter's photo if it is registered. */
  const [aiPhoto, setAiPhoto] = useState<Blob | null>(null);
  const [aiPhotoUrl, setAiPhotoUrl] = useState<string | null>(null);
  /** The cutter shown in the tool view when no new one is being added. */
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!aiPhoto) {
      setAiPhotoUrl(null);
      return;
    }
    const u = URL.createObjectURL(aiPhoto);
    setAiPhotoUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [aiPhoto]);

  useEffect(() => {
    let alive = true;
    inventory
      .read()
      .then(({ doc }) => alive && setDoc(doc))
      .catch((e) => alive && setError(`Could not read the registered cutters: ${String(e instanceof Error ? e.message : e)}`));
    loadLibrary()
      .then((lib) => alive && setLibrary(lib.tools))
      .catch((e) => alive && setLibraryError(String(e instanceof Error ? e.message : e)));
    return () => {
      alive = false;
    };
  }, [inventory, loadLibrary]);

  const tools = useMemo(() => (doc ? registeredTools(doc, library ?? []) : []), [doc, library]);

  /* Thumbnails: one object URL per stored photo, revoked when replaced. */
  const ids = tools.map((t) => t.id).join('\n');
  useEffect(() => {
    let alive = true;
    const made: string[] = [];
    (async () => {
      const next: Record<string, string> = {};
      for (const id of ids ? ids.split('\n') : []) {
        try {
          const b = await photos.get(id);
          if (b) {
            const u = URL.createObjectURL(b);
            made.push(u);
            next[id] = u;
          }
        } catch {
          /* An unreadable photo shows as "no photo"; the cutter itself is fine. */
        }
      }
      if (alive) setThumbs(next);
    })();
    return () => {
      alive = false;
      made.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [ids, photos]);

  /** Re-read before every write: another panel may have changed the inventory
   *  (machines, hold-downs) since this page loaded. */
  const commit = useCallback(
    async (change: (current: InventoryDoc) => InventoryDoc | { error: string }) => {
      setBusy(true);
      setError(null);
      try {
        const { doc: current } = await inventory.read();
        const next = change(current);
        if ('error' in next) {
          setError(next.error);
          return false;
        }
        await inventory.write(next, Date.now());
        setDoc(next);
        return true;
      } catch (e) {
        setError(`Not saved: ${String(e instanceof Error ? e.message : e)}`);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [inventory]
  );

  const closeAdd = () => {
    setAdd(null);
    setPick([]);
    setDraft(EMPTY_DRAFT);
    setProblems([]);
    setFocused(null);
    setAiFilled(new Set());
    setAiPhoto(null);
  };

  /** The AI's proposal FILLS the form — the human's name is kept, nothing is
   *  registered, and the form's own validation is shown straight away. */
  const fillFromPhoto = (p: ToolProposal, photo: Blob | null) => {
    /* A SET (several sizes): offer the picker instead of filling one size. */
    setSetOffer(p.set ? { variants: p.set.variants, shared: p.draft, variant: 0, chosen: new Set(p.set.variants[0].diameters) } : null);
    const before = add === 'new' ? draft : EMPTY_DRAFT;
    const next: ToolDraft = { ...p.draft, label: before.label };
    setAdd('new');
    setDraft(next);
    /* Marked = a value the AI put there that the human has not typed over: one it
     * just changed, or one it filled earlier and is still there. */
    setAiFilled((prev) => new Set(p.filled.filter((f) => next[f] !== before[f] || (add === 'new' && prev.has(f)))));
    /* A words-only follow-up keeps the photo of the cutter being added. */
    if (photo) setAiPhoto(photo);
    else if (add !== 'new') setAiPhoto(null);
    setFocused(null);
    const v = validateToolDraft(next);
    setProblems(v.ok ? [] : v.problems);
    setError(null);
  };

  /** The set the AI read, waiting for the human to choose a variant and sizes. */
  const [setOffer, setSetOffer] = useState<{
    variants: { name: string; diameters: number[] }[];
    shared: ToolDraft;
    variant: number;
    chosen: Set<number>;
  } | null>(null);

  /* One write for the whole set; each cutter goes through validateToolDraft via
   * registerShopTool, and ANY refusal writes nothing (the commit returns an error). */
  const registerSet = async () => {
    if (!setOffer) return;
    const v = setOffer.variants[setOffer.variant];
    const sizes = v.diameters.filter((d) => setOffer.chosen.has(d));
    if (!sizes.length) return;
    const ok = await commit((cur) => {
      let doc = cur;
      for (const [i, d] of sizes.entries()) {
        const draftN: ToolDraft = {
          ...setOffer.shared,
          diameter_mm: String(d),
          label: `${setOffer.shared.type || 'Cutter'} ${d} mm (${v.name})`,
        };
        const r = registerShopTool(doc, draftN, Date.now() + i);
        if (!r.ok) return { error: `${d} mm: ${r.problems.map((p) => p.why).join(' ')}` };
        doc = r.doc;
      }
      return doc;
    });
    if (ok) {
      setSetOffer(null);
      closeAdd();
    }
  };

  const registerPicked = async () => {
    const id = pick[0];
    if (!id || !library) return;
    const ok = await commit((cur) => {
      const r = registerCatalogueTool(cur, id, library.map((t) => t.id), Date.now());
      return r.ok ? r.doc : { error: r.why };
    });
    if (ok) closeAdd();
  };

  const registerNew = async () => {
    /* Validate first and name every bad field; nothing is written on a refusal. */
    const v = validateToolDraft(draft);
    if (!v.ok) {
      setProblems(v.problems);
      setError('Not registered — fix the fields marked below.');
      return;
    }
    setProblems([]);
    let newId: string | null = null;
    const ok = await commit((cur) => {
      const r = registerShopTool(cur, draft, Date.now());
      if (r.ok) newId = r.id;
      return r.ok ? r.doc : { error: r.problems.map((p) => p.why).join(' ') };
    });
    if (!ok) return;
    const photo = aiPhoto;
    const id = newId as string | null;
    closeAdd();
    if (id) setSelected(id);
    if (photo && id) await takePhoto(id, photo);
  };

  const remove = async (id: string) => {
    setConfirmRemove(null);
    setBusy(true);
    setError(null);
    try {
      const { doc: current } = await inventory.read();
      const out = await removeToolAndPhoto(current, id, (next) => inventory.write(next, Date.now()), photos);
      setDoc(out.doc);
      if (out.photoError) setError(out.photoError);
    } catch (e) {
      setError(`Not removed: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(false);
    }
  };

  const takePhoto = async (id: string, file: Blob | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const small = await downscaleImage(file);
      await photos.put(id, small);
      const u = URL.createObjectURL(small);
      setThumbs((t) => {
        if (t[id]) URL.revokeObjectURL(t[id]);
        return { ...t, [id]: u };
      });
    } catch (e) {
      setError(`Photo not saved: ${String(e instanceof Error ? e.message : e)}`);
    }
  };

  const problemFor = (f: keyof ToolDraft) => problems.find((p) => p.field === f)?.why;
  const set = (k: keyof ToolDraft) => (e: { target: { value: string } }) => {
    setDraft((d) => ({ ...d, [k]: e.target.value }));
    /* Edited by the human: no longer the AI's value. */
    if (aiFilled.has(k)) setAiFilled((s) => new Set([...s].filter((x) => x !== k)));
  };
  const aiMark = (k: keyof ToolDraft) =>
    aiFilled.has(k) ? (
      <em className="tools-field__ai" data-testid={`ai-filled-${k}`}>
        from the photo — check it
      </em>
    ) : null;

  const pickerItems = useMemo(
    () => (library ?? []).map((t) => ({ id: t.id, name: t.id, detail: catalogueDetail(t), facet: t.category })),
    [library]
  );

  /* The tool view: the cutter being added (from the form's own numbers), else
   * the selected one. Drawn to scale by ToolShape from numbers that exist; a
   * missing number is a missing feature, never a default. */
  const num = (v: string): number | null => {
    const n = Number(v.trim().replace(',', '.'));
    return v.trim() && Number.isFinite(n) && n > 0 ? n : null;
  };
  const shown: { title: string; note: string; photo: string | null; shape: ToolShapeTool } | null =
    add === 'new' && (aiPhotoUrl || Object.values(draft).some((v) => v.trim()))
      ? {
          title: draft.label.trim() || `${draft.type || 'Type not chosen'}${num(draft.diameter_mm) ? ` ${num(draft.diameter_mm)} mm` : ''}`,
          note: 'Being added — not registered. Drawn from the form as it stands; measure before you register.',
          photo: aiPhotoUrl,
          shape: {
            category: draft.type || null,
            diameter_mm: num(draft.diameter_mm),
            flutes: num(draft.flutes),
            cutting_length_mm: num(draft.cutting_length_mm),
            shank_mm: num(draft.shank_mm),
            included_angle_deg: num(draft.included_angle_deg),
            flute_type: draft.flute_type || null,
            overall_length_mm: num(draft.overall_length_mm),
          },
        }
      : (() => {
          const t = tools.find((x) => x.id === selected) ?? null;
          if (!t) return null;
          const f = t.entry.fields;
          const c = (library ?? []).find((r) => r.id === t.id);
          const shape: ToolShapeTool =
            f && Object.keys(f).length
              ? {
                  category: typeof f.category === 'string' ? f.category : null,
                  diameter_mm: typeof f.diameter_mm === 'number' ? f.diameter_mm : null,
                  flutes: typeof f.flutes === 'number' ? f.flutes : null,
                  cutting_length_mm: typeof f.cutting_length_mm === 'number' ? f.cutting_length_mm : null,
                  shank_mm: typeof f.shank_mm === 'number' ? f.shank_mm : null,
                  included_angle_deg: typeof f.included_angle_deg === 'number' ? f.included_angle_deg : null,
                  flute_type: typeof f.flute_type === 'string' ? f.flute_type : null,
                  overall_length_mm: typeof f.overall_length_mm === 'number' ? f.overall_length_mm : null,
                }
              : (c ?? {});
          return { title: t.name, note: t.detail, photo: thumbs[t.id] ?? null, shape };
        })();

  return (
    <div className="cad-simple tools-simple" data-testid="tools-tab">
      <ToolChat current={add === 'new' ? draft : null} onProposal={fillFromPhoto} disabled={busy || doc === null} />
      <div className="cad-simple-view">
    <section className="tools-page" aria-labelledby="tools-page-title">
      <h2 id="tools-page-title">Tools</h2>
      {setOffer ? (
        <div className="tools-set" data-testid="tools-set">
          <strong>A set of {setOffer.shared.type || 'cutters'}{setOffer.shared.material ? ` · ${setOffer.shared.material}` : ''}</strong>
          <p className="note">Pick the set you have, untick sizes you do not own, then register them. Every size is a separate cutter; lengths and shank stay "not measured" until you measure them.</p>
          <div className="tools-set__variants">
            {setOffer.variants.map((v, i) => (
              <button
                key={v.name + i}
                type="button"
                aria-pressed={setOffer.variant === i}
                onClick={() => setSetOffer({ ...setOffer, variant: i, chosen: new Set(v.diameters) })}
              >
                {v.name}
              </button>
            ))}
          </div>
          <div className="tools-set__sizes">
            {setOffer.variants[setOffer.variant].diameters.map((d) => (
              <label key={d} className="tools-set__size">
                <input
                  type="checkbox"
                  checked={setOffer.chosen.has(d)}
                  onChange={() => {
                    const c = new Set(setOffer.chosen);
                    if (c.has(d)) c.delete(d);
                    else c.add(d);
                    setSetOffer({ ...setOffer, chosen: c });
                  }}
                />
                {d} mm
              </label>
            ))}
          </div>
          <div className="tools-set__actions">
            <button type="button" className="primary" disabled={busy || setOffer.chosen.size === 0} onClick={() => void registerSet()} data-testid="tools-set-register">
              Register {setOffer.chosen.size} cutter{setOffer.chosen.size === 1 ? '' : 's'}
            </button>
            <button type="button" onClick={() => setSetOffer(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      <div className="tools-view" data-testid="tools-view">
        {shown ? (
          <>
            {shown.photo ? <img className="tools-view__photo" src={shown.photo} alt={`Photo of ${shown.title}`} /> : null}
            <div className="tools-view__shape">
              <div className="tools-view__title">{shown.title}</div>
              <ToolShape tool={shown.shape} size="pane" />
              {/* What the view shows and what it refuses to — the same words
                  the solid's accessible name carries. */}
              <div className="tools-view__note" data-testid="tools-view-caption">
                {(() => {
                  const d = describeTool3D(shown.shape);
                  return d.drawn.join(' · ') + (d.notDrawn.length ? ` — not drawn: ${d.notDrawn.join('; ')}` : '');
                })()}
              </div>
              <div className="tools-view__note">{shown.note}</div>
            </div>
          </>
        ) : (
          <p className="tools-page__muted">Choose a cutter in the list to see it here — or describe or photograph a new one in the assistant on the left.</p>
        )}
      </div>
      <p className="tools-page__lead">
        The cutters you own. The planner chooses only from this list — nothing here is guessed for you.
      </p>
      <ul className="tools-page__honesty">
        <li>Photos stay in this browser only (IndexedDB). They are not uploaded and do not appear on your other devices. Clearing site data deletes them.</li>
        <li>Exporting your saved data carries this list of cutters, but not the photos.</li>
        <li>Measure diameter and lengths with calipers. A registered cutter's photo is only for recognising it; nothing reads it.</li>
        <li>The assistant on the left is different: what you type or photograph there is sent to your AI, which proposes the cutter and fills the form. It never registers anything, and a size read from a photo is not a measurement.</li>
        <li>Once one cutter is registered, any cutter not on this list counts as not owned.</li>
      </ul>

      {error ? (
        <p className="tools-page__error" role="alert">
          {error}
        </p>
      ) : null}

      {doc === null && !error ? <p className="tools-page__muted">Reading registered cutters…</p> : null}

      {doc !== null ? (
        <ul className="tools-list" aria-label="Registered cutters">
          {tools.length === 0 ? <li className="tools-page__muted">No cutters registered yet.</li> : null}
          {tools.map((t) => (
            <li key={t.id} className={`tools-row${selected === t.id ? ' is-selected' : ''}`} data-testid="tool-row">
              <button
                type="button"
                className="tools-row__thumb"
                aria-pressed={selected === t.id}
                title={`Show ${t.name}`}
                onClick={() => setSelected(t.id)}
              >
                {thumbs[t.id] ? <img src={thumbs[t.id]} alt={`Photo of ${t.name}`} /> : <span className="tools-row__nophoto">no photo</span>}
              </button>
              <div className="tools-row__body" onClick={() => setSelected(t.id)}>
                <div className="tools-row__name">
                  <span className="tools-row__tag">{t.origin === 'catalogue' ? 'FROM LIST' : 'MEASURED BY YOU'}</span> {t.name}
                </div>
                <div className="tools-row__detail">{t.detail}</div>
                {t.unresolved ? <div className="tools-row__warn">{t.unresolved}</div> : null}
                {confirmRemove === t.id ? (
                  <div className="tools-row__confirm" role="group" aria-label={`Confirm removing ${t.name}`}>
                    <span>Remove {t.name}{thumbs[t.id] ? ' and its photo' : ''}?</span>
                    <button type="button" className="tools-btn tools-btn--bad" disabled={busy} onClick={() => void remove(t.id)}>
                      Remove
                    </button>
                    <button type="button" className="tools-btn" onClick={() => setConfirmRemove(null)}>
                      Keep
                    </button>
                  </div>
                ) : (
                  <div className="tools-row__actions">
                    <label className="tools-btn">
                      Photo
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="tools-row__file"
                        onChange={(e) => {
                          void takePhoto(t.id, e.target.files?.[0]);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <button type="button" className="tools-btn" disabled={busy} onClick={() => setConfirmRemove(t.id)}>
                      Remove
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {add === null ? (
        <button type="button" className="tools-btn tools-btn--primary" disabled={doc === null} onClick={() => setAdd(library && library.length ? 'catalogue' : 'new')}>
          Add
        </button>
      ) : (
        <div className="tools-add">
          <div className="tools-add__choice" role="radiogroup" aria-label="How to add">
            <label>
              <input type="radio" name="tools-add-mode" checked={add === 'catalogue'} disabled={!library?.length} onChange={() => setAdd('catalogue')} />{' '}
              From the list this app ships
            </label>
            <label>
              <input type="radio" name="tools-add-mode" checked={add === 'new'} onChange={() => setAdd('new')} /> Not in the list — I will measure it
            </label>
          </div>
          {libraryError ? <p className="tools-page__muted">The app's cutter list could not be loaded ({libraryError}). You can still measure and add your own.</p> : null}

          {add === 'catalogue' ? (
            <>
              <ObjectPicker label="Cutter" mode="single" items={pickerItems} selectedIds={pick} onChange={setPick} placeholder="Choose a cutter" />
              <p className="tools-page__muted">
                These numbers are the list's. Check your cutter matches them with calipers before you register it; if it does not, measure it instead.
              </p>
            </>
          ) : (
            <div className="tools-form">
              <label className="tools-field">
                <span>Type *</span>
                <select value={draft.type} onChange={set('type')} aria-invalid={!!problemFor('type')} data-testid="tool-field-type">
                  <option value="">— choose —</option>
                  {TOOL_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {aiMark('type')}
                {problemFor('type') ? <em className="tools-field__err">{problemFor('type')}</em> : null}
              </label>
              {fieldsFor(draft.type).map((k) => {
                const g = fieldGuide(k);
                const required = k === 'diameter_mm' || k === 'included_angle_deg';
                return (
                  <div key={k} className="tools-field-row">
                    <label className="tools-field">
                      <span>
                        {g.label}
                        {g.unit === 'count' ? '' : ` (${g.unit})`}
                        {required ? ' *' : ''}
                      </span>
                      <input
                        inputMode={k === 'flutes' ? 'numeric' : 'decimal'}
                        value={draft[k]}
                        onChange={set(k)}
                        onFocus={() => setFocused(k)}
                        aria-invalid={!!problemFor(k)}
                        placeholder={required ? 'required' : 'leave blank if not measured'}
                        data-testid={`tool-field-${k}`}
                      />
                      {aiMark(k)}
                      {problemFor(k) ? <em className="tools-field__err">{problemFor(k)}</em> : null}
                    </label>
                    {focused === k ? (
                      <div className="tools-guide" data-testid="measure-guide">
                        <p className="tools-guide__what">{g.what}</p>
                        <p className="tools-guide__how">
                          <strong>How:</strong> {g.how}
                        </p>
                        <Measure3D scene={endMillScene(k)} label={`Where to measure: ${g.label}`} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
              <label className="tools-field">
                <span>Flute direction</span>
                <select value={draft.flute_type} onChange={set('flute_type')} onFocus={() => setFocused(null)}>
                  <option value="">not stated</option>
                  {FLUTE_DIRECTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {aiMark('flute_type')}
                {problemFor('flute_type') ? <em className="tools-field__err">{problemFor('flute_type')}</em> : null}
              </label>
              <label className="tools-field">
                <span>Cutter material</span>
                <input value={draft.material} onChange={set('material')} onFocus={() => setFocused(null)} placeholder="e.g. carbide (optional)" data-testid="tool-field-material" />
                {aiMark('material')}
              </label>
              <label className="tools-field">
                <span>Name</span>
                <input value={draft.label} onChange={set('label')} onFocus={() => setFocused(null)} placeholder="optional — built from type and diameter" />
              </label>
            </div>
          )}

          <div className="tools-add__actions">
            <button
              type="button"
              className="tools-btn tools-btn--primary"
              disabled={busy || (add === 'catalogue' && !pick[0])}
              onClick={() => void (add === 'catalogue' ? registerPicked() : registerNew())}
            >
              Register
            </button>
            <button type="button" className="tools-btn" onClick={closeAdd}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
      </div>
    </div>
  );
}
