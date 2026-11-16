// "Save thumbnail" for a board's 3D view (the Designs page's PCB viewer and the
// pcb tab). It reads the `BoardView` canvas inside `scope` — BoardView renders
// with `preserveDrawingBuffer`, so the last frame is still there to read — and
// stores it under `pcb:<boardId>` (`pcbThumb.ts`). The PCB card then shows it.

import { useState } from 'react';
import { captureCanvas } from '../cnc/thumbnail';
import { savePcbPicture } from './pcbThumb';

export function PcbSaveThumb({
  boardId,
  scope,
  disabled,
  testId = 'pcb-save-thumb',
}: {
  boardId: string;
  /** CSS selector of the ancestor that holds the board canvas. */
  scope: string;
  disabled?: boolean;
  testId?: string;
}) {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        disabled={disabled || !boardId}
        title="Store this 3D view as the board's picture on the design page"
        onClick={(e) => {
          const host = (e.currentTarget as HTMLElement).closest(scope);
          const cv = host?.querySelector<HTMLCanvasElement>('[data-testid="pnp-board-canvas"]');
          const url = cv ? captureCanvas(cv) : null;
          const ok = !!url && savePcbPicture(boardId, url);
          setNote(
            ok
              ? { ok, text: 'Thumbnail saved. The design page shows it on this board.' }
              : { ok, text: 'Thumbnail NOT saved: this browser refused to store it, or nothing was drawn yet.' }
          );
        }}
      >
        Save thumbnail
      </button>
      {note ? (
        <span className={note.ok ? 'note' : 'note bad'} role="status" data-testid={`${testId}-note`}>
          {note.text}
        </span>
      ) : null}
    </>
  );
}
