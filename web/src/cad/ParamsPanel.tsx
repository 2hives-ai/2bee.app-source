// The design's variables as controls (founder 2026-11-13: "the cad and 3d should
// able to handle variables like turn on/off features", then "Add variables to the
// design as well (preview)"). One component for cad, the design preview and 3d.
//
// On/off switches (`true`/`false`) are shown first, always. Numbers and text sit
// behind "Sizes and values", because a design typically has many of them and they
// are not what "turn a feature on or off" means. See `params.ts` for what counts as
// a variable and what is deliberately not listed.

import { useEffect, useMemo, useState } from 'react';
import { scanParams, type Param, type ParamValue } from './params';

const pretty = (name: string) => name.replace(/_+/g, ' ').trim();

function NumberField({ p, disabled, onChange }: { p: Param; disabled: boolean; onChange: (v: ParamValue) => void }) {
  const [text, setText] = useState(String(p.value));
  useEffect(() => setText(String(p.value)), [p.value]);
  /* Committed on Enter or leaving the field, not per keystroke: each change rebuilds the model. */
  const commit = () => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) {
      setText(String(p.value));
      return;
    }
    if (n !== p.value) onChange(n);
  };
  return (
    <input
      type="number"
      value={text}
      min={p.range?.min}
      max={p.range?.max}
      step={p.range?.step ?? 'any'}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      data-testid={`param-${p.name}`}
    />
  );
}

function Field({ p, disabled, onChange }: { p: Param; disabled: boolean; onChange: (v: ParamValue) => void }) {
  if (p.options) {
    const at = p.options.findIndex((o) => o.value === p.value);
    return (
      <select
        value={at < 0 ? '' : String(at)}
        disabled={disabled}
        onChange={(e) => onChange(p.options![Number(e.target.value)].value)}
        data-testid={`param-${p.name}`}
      >
        {at < 0 ? <option value="">{String(p.value)}</option> : null}
        {p.options.map((o, i) => (
          <option key={i} value={i}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (p.kind === 'number') return <NumberField p={p} disabled={disabled} onChange={onChange} />;
  return (
    <input
      type="text"
      defaultValue={String(p.value)}
      key={String(p.value)}
      disabled={disabled}
      onBlur={(e) => e.target.value !== p.value && onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      data-testid={`param-${p.name}`}
    />
  );
}

export function ParamsPanel({
  source,
  onChange,
  busy = false,
  note,
}: {
  /** The design's main file. */
  source: string;
  /** One variable changed; the caller rewrites the source (`setParam`) and rebuilds. */
  onChange: (p: Param, v: ParamValue) => void;
  /** A rebuild is running: controls are disabled so changes cannot pile up. */
  busy?: boolean;
  /** One line under the title, e.g. what a change does in this tab. */
  note?: string;
}) {
  const scan = useMemo(() => scanParams(source), [source]);
  const switches = scan.params.filter((p) => p.kind === 'bool');
  const values = scan.params.filter((p) => p.kind !== 'bool');
  if (scan.params.length === 0) return null;
  return (
    <section className="params" aria-label="Design variables" data-testid="params-panel" data-busy={busy || undefined}>
      <header className="params-head">
        <strong>Variables</strong>
        {busy ? <span className="params-busy">Rebuilding…</span> : null}
      </header>
      {note ? <p className="params-note">{note}</p> : null}
      {switches.length ? (
        <div className="params-switches">
          {switches.map((p) => (
            <label key={p.name} className="params-switch" title={p.description || `${p.name}, line ${p.line}`}>
              <input
                type="checkbox"
                checked={p.value === true}
                disabled={busy}
                onChange={(e) => onChange(p, e.target.checked)}
                data-testid={`param-${p.name}`}
              />
              <span>{pretty(p.name)}</span>
            </label>
          ))}
        </div>
      ) : null}
      {values.length ? (
        <details className="params-values">
          <summary>Sizes and values ({values.length})</summary>
          <div className="params-grid">
            {values.map((p) => (
              <label key={p.name} className="params-row" title={p.description || `${p.name}, line ${p.line}`}>
                <span className="params-name">
                  {pretty(p.name)}
                  {p.section ? <span className="params-section"> · {p.section}</span> : null}
                </span>
                <Field p={p} disabled={busy} onChange={(v) => onChange(p, v)} />
              </label>
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}
