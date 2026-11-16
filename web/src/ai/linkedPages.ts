/**
 * Links in a chat message, read for the model (founder 2026-10-15: "add this cnc
 * machine: https://… — fix the AI!"). The local claude runs with NO tools, so
 * it cannot open a link; the dev server reads the page (`/__fetch-page` in
 * vite.config.ts, public hosts only) and its text is sent WITH the message.
 * A production build has no such route: the link is then sent as plain text and
 * the chat says the page could not be read.
 */
export interface LinkedPage {
  url: string;
  title: string;
  text: string;
}
export interface LinkedRead {
  pages: LinkedPage[];
  /** One sentence per link for the chat: read, or why not. */
  notes: string[];
}

export const URL_RE = /https?:\/\/[^\s<>"')]+/g;

export async function readLinkedPages(message: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<LinkedRead> {
  const urls = [...new Set(message.match(URL_RE) ?? [])].slice(0, 3);
  const pages: LinkedPage[] = [];
  const notes: string[] = [];
  for (const url of urls) {
    try {
      const r = await fetcher(`/__fetch-page?url=${encodeURIComponent(url)}`, { signal });
      const v = (await r.json()) as { title?: string; text?: string; error?: string; status?: number };
      if (!r.ok || !v.text) {
        notes.push(`Could not read ${url}: ${v.error ?? `HTTP ${r.status}`}.`);
        continue;
      }
      pages.push({ url, title: v.title ?? '', text: v.text });
      notes.push(`Read ${new URL(url).hostname}${v.title ? ` ("${v.title.slice(0, 60)}")` : ''}.`);
    } catch (e) {
      notes.push(`Could not read ${url}: ${String(e instanceof Error ? e.message : e)}.`);
    }
  }
  return { pages, notes };
}

/** The block appended to the user message, so the model sees what the page SAID. */
export function pagesBlock(pages: LinkedPage[]): string {
  if (!pages.length) return '';
  return (
    '\n\nLinked page text (fetched for you; treat values it states as stated by the operator, and quote them):\n' +
    pages.map((p) => `--- ${p.url}${p.title ? ` — ${p.title}` : ''}\n${p.text}`).join('\n\n')
  );
}

/**
 * Research mode: no link in the message ⇒ search the web (`/__search`, dev only)
 * and read the top results. The chat says what it searched and which pages it
 * read; the model is told these are SEARCH RESULTS, to prefer the maker's own
 * page and to leave a value out when the pages disagree or do not state it.
 */
export async function researchPages(query: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<LinkedRead> {
  try {
    const r = await fetcher(`/__search?q=${encodeURIComponent(query)}`, { signal });
    const v = (await r.json()) as { urls?: string[]; error?: string };
    if (!r.ok || !v.urls?.length) return { pages: [], notes: [`Searched the web for "${query}": ${v.error ?? 'no results'}.`] };
    const read = await readLinkedPages(v.urls.slice(0, 3).join(' '), signal, fetcher);
    return { pages: read.pages, notes: [`Searched the web for "${query}".`, ...read.notes] };
  } catch (e) {
    return { pages: [], notes: [`Web search failed: ${e instanceof Error ? e.message : String(e)}.`] };
  }
}

/** The query a machine request implies: the words, minus the request verbs. */
export function researchQuery(message: string): string {
  const core = message
    .replace(URL_RE, ' ')
    .replace(/\b(please|can you|research( and)?|and|add|this|the|a|an|machine|printer|cnc|router|to|my|list|machines)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}.+-]+/gu, ' ')
    .trim();
  return core ? `${core} specifications` : '';
}

export function pagesBlockFromSearch(pages: LinkedPage[]): string {
  if (!pages.length) return '';
  return (
    '\n\nWeb search results (fetched for you because no link was given). Treat a value as stated only if a page states it; prefer the manufacturer\'s own page; if pages disagree, leave the value out and say so:\n' +
    pages.map((p) => `--- ${p.url}${p.title ? ` — ${p.title}` : ''}\n${p.text}`).join('\n\n')
  );
}

/** A message that asks to add / look something up, and carries no link. */
export function wantsResearch(message: string): boolean {
  return !new RegExp(URL_RE.source).test(message) && /\b(add|create|new|research|look ?up|find|search)\b/i.test(message);
}
