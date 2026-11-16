/**
 * The pcb tab's assistant — it ANSWERS questions about the selected board from
 * the data the tab loaded (BOM, CPL, nets/parts from the .kicad_pcb, the gates
 * and the DRC/ERC records). It changes nothing: `pcb` owns hardware/pcb, and
 * there is no path from a reply to a file. The reply is shown as text.
 *
 * Everything that leaves is built in `buildPcbRequest`, from the context string
 * `pcbContext` returns, so what is sent can be tested byte for byte.
 */
import { readReply, type AskConfig, type AskFailure, type AskRequest, type AskTransportResult } from '../cad/ask';
import type { PcbGate } from './pcbGates';

export const PCB_SYSTEM_INSTRUCTION = [
  'You answer questions about ONE printed circuit board for the pcb tab of 2bee.app.',
  'Use ONLY the board data below (BOM, placement, nets and the parts on them, gate results, DRC/ERC records). If the data does not say, say that it does not; never guess a value, a part number or a rating.',
  'You cannot change anything: you have no tools, no files, and you cannot run a gate. If asked to change the board, say which file or gate the pcb lane would have to change, and stop.',
  'Gates have three states: PASS, FAIL, PENDING. PENDING means not checked or the record is stale — it is NOT a pass; never describe a PENDING gate as passing.',
  'Name the source (file or gate id) for every fact you state. Answer in plain short sentences, no JSON, no code blocks unless asked.',
].join('\n');

/** Net → "REF.pad" list, from the .kicad_pcb's footprints. Unconnected ("") nets dropped. */
export function netsFromKicad(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const chunks = text.split(/\(footprint "/).slice(1);
  for (const c of chunks) {
    const ref = /\(property "Reference" "([^"]*)"/.exec(c)?.[1] ?? /\(fp_text reference "([^"]*)"/.exec(c)?.[1] ?? '?';
    for (const p of c.split(/\(pad "/).slice(1)) {
      const pad = p.slice(0, p.indexOf('"'));
      const net = /\(net (?:\d+ )?"([^"]*)"\)/.exec(p)?.[1];
      if (!net) continue;
      const l = out.get(net) ?? [];
      l.push(`${ref}.${pad}`);
      out.set(net, l);
    }
  }
  return out;
}

/** CSV text with long free-text columns cut, so a 30-row BOM stays readable. */
function trimCsv(csv: string, maxCell = 80): string {
  return csv
    .split('\n')
    .map((line) => line.replace(/"([^"]{80,})"/g, (_m, s: string) => `"${s.slice(0, maxCell)}…"`))
    .join('\n');
}

export const CONTEXT_CAP = 60_000;

export function pcbContext(i: {
  boardId: string;
  paths: string[];
  bom: string;
  cpl: string;
  countLine: string;
  nets: Map<string, string[]> | null;
  gates: readonly PcbGate[];
  records: string[];
}): { text: string; cut: boolean } {
  const g = i.gates.map((x) => `- [${x.state}] ${x.id} ${x.name}: ${x.why}`).join('\n');
  const nets = i.nets
    ? [...i.nets.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([n, pads]) => `${n}: ${pads.join(' ')}`)
        .join('\n')
    : '(the .kicad_pcb did not load, so no nets)';
  const parts = [
    `BOARD: ${i.boardId}`,
    `FILES: ${i.paths.join(' · ')}`,
    `PARTS: ${i.countLine}`,
    `GATES (${i.gates.length}):\n${g || '(none yet)'}`,
    `RECORDS:\n${i.records.join('\n') || '(none)'}`,
    `BOM (CSV):\n${trimCsv(i.bom)}`,
    `PLACEMENT / CPL (CSV):\n${i.cpl}`,
    `NETS (net: REF.pad …):\n${nets}`,
  ];
  let text = parts.join('\n\n');
  const cut = text.length > CONTEXT_CAP;
  if (cut) text = `${text.slice(0, CONTEXT_CAP)}\n…(cut at ${CONTEXT_CAP} characters; the rest of the nets list was not sent)`;
  return { text, cut };
}

export function buildPcbRequest(cfg: AskConfig, question: string, context: string, history: { role: 'user' | 'ai'; text: string }[] = []): AskRequest {
  const prior = history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Question' : 'Your answer'}: ${m.text}`)
    .join('\n');
  return {
    url: cfg.endpoint,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: {
      model: cfg.model,
      messages: [
        { role: 'system', content: PCB_SYSTEM_INSTRUCTION },
        { role: 'user', content: `${context}\n\n${prior ? `EARLIER IN THIS CHAT:\n${prior}\n\n` : ''}QUESTION: ${question}` },
      ],
      temperature: 0,
      stream: false,
    },
  };
}

/** The reply as text. `readReply` is for SCAD (it strips prose); this keeps the prose. */
export function readTextReply(r: AskTransportResult): { ok: true; text: string } | { ok: false; failure: AskFailure } {
  if (r.ok) {
    try {
      const c = (JSON.parse(r.text) as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content;
      if (typeof c === 'string' && c.trim()) return { ok: true, text: c.trim() };
    } catch {
      /* fall through to readReply's sentence for the same failure */
    }
  }
  const rr = readReply(r);
  return rr.ok ? { ok: true, text: rr.raw } : rr;
}
