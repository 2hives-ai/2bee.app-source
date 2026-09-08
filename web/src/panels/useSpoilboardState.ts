/**
 * useSpoilboardState — custom hook for spoilboard state management.
 *
 * Extracted from App.tsx to reduce component size.
 * Manages spoilboard declaration, position, thickness, and machine reconciliation.
 */

import { useCallback, useMemo, useState } from 'react';
import { spoilboardForMachine } from '../store';
import type { SpoilboardCatalogue } from '../cam';

export interface SpoilboardRestore {
  values: {
    id: string;
    x: string;
    y: string;
    sizeX: string;
    sizeY: string;
    thickness: string;
    name: string;
    pos: 'assumed' | 'entered';
    travels: [number, number, number] | null;
  };
  dropped: { reason: string }[];
  provenance: string | null;
}

export interface SpoilboardState {
  spoilboardId: string;
  spoilboardX: string;
  spoilboardY: string;
  spoilboardSizeX: string;
  spoilboardSizeY: string;
  spoilboardThickness: string;
  spoilboardSaveNote: string | null;
  spoilboardName: string;
  spoilboardPos: 'assumed' | 'entered';
  spoilboardTravels: [number, number, number] | null;
  setSpoilboardTravels: (v: [number, number, number] | null) => void;
  spoilboardMachineNote: { tone: 'note' | 'warn'; text: string } | null;
  setSpoilboardMachineNote: (v: { tone: 'note' | 'warn'; text: string } | null) => void;
  spoilCat: SpoilboardCatalogue | null;

  setSpoilboardId: (v: string) => void;
  setSpoilboardX: (v: string) => void;
  setSpoilboardY: (v: string) => void;
  setSpoilboardSizeX: (v: string) => void;
  setSpoilboardSizeY: (v: string) => void;
  setSpoilboardThickness: (v: string) => void;
  setSpoilboardSaveNote: (v: string | null) => void;
  setSpoilboardName: (v: string) => void;
  setSpoilboardPos: (v: 'assumed' | 'entered') => void;
  setSpoilCat: (v: SpoilboardCatalogue | null) => void;

  spoilboardInPlay: { sizeX: string; sizeY: string; thickness: string };
  stampSpoilboardMachine: () => void;
  reconcileSpoilboardWithMachine: (next: [number, number, number]) => void;
}

export function useSpoilboardState(
  restore: SpoilboardRestore,
  travelX: number,
  travelY: number,
  travelZ: number,
): SpoilboardState {
  const [spoilboardId, setSpoilboardId] = useState(restore.values.id);
  const [spoilboardX, setSpoilboardX] = useState(restore.values.x);
  const [spoilboardY, setSpoilboardY] = useState(restore.values.y);
  const [spoilboardSizeX, setSpoilboardSizeX] = useState(restore.values.sizeX);
  const [spoilboardSizeY, setSpoilboardSizeY] = useState(restore.values.sizeY);
  const [spoilboardThickness, setSpoilboardThickness] = useState(restore.values.thickness);
  const [spoilboardSaveNote, setSpoilboardSaveNote] = useState<string | null>(null);
  const [spoilboardName, setSpoilboardName] = useState(restore.values.name);
  const [spoilboardPos, setSpoilboardPos] = useState<'assumed' | 'entered'>(
    restore.values.pos
  );
  const [spoilboardTravels, setSpoilboardTravels] = useState<[number, number, number] | null>(
    restore.values.travels
  );
  const [spoilboardMachineNote, setSpoilboardMachineNote] = useState<{
    tone: 'note' | 'warn';
    text: string;
  } | null>(
    restore.dropped.length
      ? { tone: 'warn', text: restore.dropped[0].reason }
      : restore.provenance
        ? { tone: 'note', text: restore.provenance }
        : null
  );
  const [spoilCat, setSpoilCat] = useState<SpoilboardCatalogue | null>(null);

  const stampSpoilboardMachine = useCallback(() => {
    setSpoilboardTravels([travelX, travelY, travelZ]);
  }, [travelX, travelY, travelZ]);

  const reconcileSpoilboardWithMachine = useCallback(
    (next: [number, number, number]) => {
      const r = spoilboardForMachine(
        {
          id: spoilboardId,
          x: spoilboardX,
          y: spoilboardY,
          sizeX: spoilboardSizeX,
          sizeY: spoilboardSizeY,
          thickness: spoilboardThickness,
          name: spoilboardName,
          pos: spoilboardPos,
          travels: spoilboardTravels,
        },
        next,
        Date.now()
      );
      setSpoilboardId(r.values.id);
      setSpoilboardX(r.values.x);
      setSpoilboardY(r.values.y);
      setSpoilboardSizeX(r.values.sizeX);
      setSpoilboardSizeY(r.values.sizeY);
      setSpoilboardThickness(r.values.thickness);
      setSpoilboardName(r.values.name);
      setSpoilboardPos(r.values.pos);
      setSpoilboardTravels(r.values.travels);
      setSpoilboardMachineNote(
        r.dropped.length
          ? { tone: 'warn', text: r.dropped[0].reason }
          : r.provenance
            ? { tone: 'note', text: r.provenance }
            : null
      );
    },
    [spoilboardId, spoilboardX, spoilboardY, spoilboardSizeX, spoilboardSizeY,
     spoilboardThickness, spoilboardName, spoilboardPos, spoilboardTravels]
  );

  const spoilboardInPlay = useMemo(() => {
    const row = spoilCat?.spoilboards.find((b) => b.id === spoilboardId) ?? null;
    if (!row) {
      return { sizeX: spoilboardSizeX, sizeY: spoilboardSizeY, thickness: spoilboardThickness };
    }
    return {
      sizeX: String(row.size_x_mm),
      sizeY: String(row.size_y_mm),
      thickness: row.thickness_mm == null ? '' : String(row.thickness_mm),
    };
  }, [spoilCat, spoilboardId, spoilboardSizeX, spoilboardSizeY, spoilboardThickness]);

  return {
    spoilboardId, spoilboardX, spoilboardY,
    spoilboardSizeX, spoilboardSizeY, spoilboardThickness,
    spoilboardSaveNote, spoilboardName, spoilboardPos,
    spoilboardTravels, setSpoilboardTravels,
    spoilboardMachineNote, setSpoilboardMachineNote,
    spoilCat,
    setSpoilboardId, setSpoilboardX, setSpoilboardY,
    setSpoilboardSizeX, setSpoilboardSizeY, setSpoilboardThickness,
    setSpoilboardSaveNote, setSpoilboardName, setSpoilboardPos,
    setSpoilCat,
    spoilboardInPlay, stampSpoilboardMachine, reconcileSpoilboardWithMachine,
  };
}
