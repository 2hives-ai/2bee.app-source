// What the Upload button says while a plate is on its way to the printer.
//
// Founder 2026-11-20: "When it is Uploading... can the button became a progress bar?"
//
// The numbers come from the printer bridge's POST /v1/progress: bytes the bridge has
// handed to the printer's FTPS data socket. That is bytes SENT. The printer's own word
// comes after: the 226 reply and the SIZE check, which the bridge reports as the
// "confirming" phase. So the bar never reads 100 % until the bridge is waiting on the
// printer, and the button never says "done". The upload's own reply does that.
//
// A bridge that does not have /v1/progress (started before this landed) gives no
// numbers. The button then shows "Uploading…" with no bar, as it did before. It does
// not invent a percentage.

export type UploadPhase = 'connecting' | 'sending' | 'confirming';
export interface UploadProgress { remote?: string; phase: UploadPhase; sent: number; total: number }
export interface ProgressReply { upload: UploadProgress | null; queued?: number }

export interface ProgressView {
  /** Button text. */
  label: string;
  /** 0-100 for the bar, or null for no bar. */
  pct: number | null;
}

const mb = (n: number) => (n / 1e6).toFixed(n < 10e6 ? 1 : 0);

/** `reply` is the last /v1/progress answer, or null when none has arrived (or the bridge has no such route). */
export function uploadProgressView(reply: ProgressReply | null): ProgressView {
  const u = reply?.upload ?? null;
  if (!u || !(u.total > 0)) {
    // Still fetching the G-code / handing it to the bridge, or waiting behind another upload.
    if (reply && !u && (reply.queued ?? 0) > 0) return { label: 'Waiting for the upload before this one…', pct: 0 };
    return { label: 'Uploading…', pct: null };
  }
  const sent = Math.max(0, Math.min(u.sent, u.total));
  const pct = Math.floor((sent / u.total) * 100);
  if (u.phase === 'connecting') return { label: 'Connecting to the printer…', pct: 0 };
  if (u.phase === 'confirming') return { label: 'Sent. The printer is checking the file…', pct: 100 };
  return { label: `Uploading ${pct} % (${mb(sent)} of ${mb(u.total)} MB)`, pct: Math.min(pct, 99) };
}
