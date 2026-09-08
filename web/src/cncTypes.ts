/**
 * Shared CNC types used by both App.tsx and cncStore.ts.
 *
 * Extracted from App.tsx to enable proper typing in the Zustand store.
 * These types describe the data model for drawings, workpieces, and
 * related state that flows between the CAD and CNC tabs.
 */

import type { DrawingOrigin } from './store';
import type { CadPayload } from './cad/record';

/**
 * A drawing that has been loaded into the CNC tab — either from the
 * drawing picker (samples, saved, mesh) or from a file import.
 *
 * `instance` is a unique, readable id for THIS COPY of the drawing.
 * Two copies of one file are two instances with two placements.
 */
export interface LoadedDrawing {
  instance: string;
  bytes?: Uint8Array;
  text?: string;
  format: 'dxf' | 'svg' | 'stl' | 'auto';
  name: string;
  origin: DrawingOrigin;
  cad?: CadPayload;
  /** Delta from as-drawn, sheet mm. */
  offset: [number, number];
  /** Degrees anticlockwise about this drawing's own lower-left corner. */
  rotation: number;
}

/**
 * A workpiece on the table — stock size, placement, material, and
 * the drawings placed on it.
 */
export interface Workpiece {
  stockX: number;
  stockY: number;
  originX: number;
  originY: number;
  rotation: number;
  drawings: LoadedDrawing[];
}
