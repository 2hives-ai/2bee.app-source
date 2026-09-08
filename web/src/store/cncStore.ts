/**
 * CNC Tab Zustand Store
 *
 * Replaces the 95 useState calls in App.tsx with a centralized store.
 * Each panel reads what it needs directly from the store — no prop drilling.
 *
 * Migration strategy: incrementally move state from App.tsx into this store.
 * Start with machine + operation state, then expand.
 */

import { create } from 'zustand';
import { readSession, readSessionSpoilboard, type SessionValues, type DroppedField } from '../store';
import { storedCncUnit, storedCncProjection } from '../panels/viewPersistence';
// 🔴 `layers` MUST open on LAYER_DEFAULTS, not `{}`: every consumer reads a
// missing key as *undefined*, and the sidebar layer rows bind
// `aria-pressed={layers[k]}` — with `{}` every layer renders "hidden" (the
// attribute is absent and the title says HIDDEN) until it is toggled twice,
// while the canvas draws it. The 2026-08-20 Zustand migration dropped the
// defaults and the two read opposite meanings from the same undefined.
import { LAYER_DEFAULTS } from '../Viewport';
import type { Unit } from '../units';
import type { Projection } from '../projection';
import type { Report, ClampCfg, Clearance, ToolRow, ToolLibrary } from '../cam';
import type { InventoryDoc, InventoryParseReport, InventoryKind } from '../inventory';
import type { RunProgram } from '../RunTab';
import type { StreamingSignal } from '../RunTab';
import type { LoadedDrawing, Workpiece } from '../cncTypes';
import type { LoadedRecord } from '../savedSelection';

// Restore session data once at module load
const RESTORED = readSession();
const R: Partial<SessionValues> = RESTORED.status === 'ok' ? RESTORED.values : {};

const DEFAULT_TRAVEL_MM: [number, number, number] = [600, 900, 100];

/* 🔴 The spoilboard read runs HERE as well as in `App.tsx`, because the restore
 * banner's drop list is initialised from it. A stored board corner is a MACHINE
 * coordinate: if the travels it was measured against did not come back, the
 * corner is dropped BY NAME — and that drop belongs on the banner beside every
 * other named drop, not only on the spoilboard panel. The 2026-08-20 Zustand
 * migration reset `dropped` to `[]`, so only the library-bound second pass
 * (tools, material) was ever reported; the base-pass drops (entry, workholding,
 * spoilboard corner, …) were silently lost. See `readSessionSpoilboard`. */
const SPOILBOARD_RESTORE = readSessionSpoilboard(
  R,
  [R.travelX ?? DEFAULT_TRAVEL_MM[0], R.travelY ?? DEFAULT_TRAVEL_MM[1], R.travelZ ?? DEFAULT_TRAVEL_MM[2]],
  (RESTORED.status === 'ok' ? RESTORED.savedAt : null) ?? Date.now()
);

// ── Machine state ──────────────────────────────────────────────────────────

export interface MachineState {
  travelX: number;
  travelY: number;
  travelZ: number;
  safeZ: number;
  colletMm: number;
  spindleMax: number;
  probeEnabled: boolean;
  touchPlateMm: string;
  supportsArcs: boolean;
  touchPlateId: string;
}

export interface MachineActions {
  setTravelX: (v: number) => void;
  setTravelY: (v: number) => void;
  setTravelZ: (v: number) => void;
  setSafeZ: (v: number) => void;
  setColletMm: (v: number) => void;
  setSpindleMax: (v: number) => void;
  setProbeEnabled: (v: boolean) => void;
  setTouchPlateMm: (v: string) => void;
  setSupportsArcs: (v: boolean) => void;
  setTouchPlateId: (v: string) => void;
}

// ── Operation state ────────────────────────────────────────────────────────

export interface OperationState {
  depthPerPass: number;
  rpm: number;
  entry: string;
  direction: string;
  dogbone: string;
  tabsEnabled: boolean;
  tabHeight: number;
  tabWidth: number;
  tabSpacing: number;
  finishAllowance: number;
  leadMm: number;
  probeAfterChange: boolean;
  useWorkpieceEdge: boolean;
  workpieceEdgeTol: string;
}

export interface OperationActions {
  setDepthPerPass: (v: number) => void;
  setRpm: (v: number) => void;
  setEntry: (v: string) => void;
  setDirection: (v: string) => void;
  setDogbone: (v: string) => void;
  setTabsEnabled: (v: boolean) => void;
  setTabHeight: (v: number) => void;
  setTabWidth: (v: number) => void;
  setTabSpacing: (v: number) => void;
  setFinishAllowance: (v: number) => void;
  setLeadMm: (v: number) => void;
  setProbeAfterChange: (v: boolean) => void;
  setUseWorkpieceEdge: (v: boolean) => void;
  setWorkpieceEdgeTol: (v: string) => void;
}

// ── Workpiece state ────────────────────────────────────────────────────────

export interface WorkpieceState {
  stockX: number;
  stockY: number;
  thickness: number;
  zZeroTop: boolean;
  originX: number;
  originY: number;
  rotation: number;
  material: string;
  workpieceMaterialFacet: string;
}

export interface WorkpieceActions {
  setStockX: (v: number) => void;
  setStockY: (v: number) => void;
  setThickness: (v: number) => void;
  setZZeroTop: (v: boolean) => void;
  setOriginX: (v: number) => void;
  setOriginY: (v: number) => void;
  setRotation: (v: number) => void;
  setMaterial: (v: string) => void;
  setWorkpieceMaterialFacet: (v: string) => void;
}

// ── Tool state ─────────────────────────────────────────────────────────────

export interface ToolState {
  toolIds: string[];
  extraTools: ToolRow[] | null;
}

export interface ToolActions {
  setToolIds: (v: string[]) => void;
  setExtraTools: (v: ToolRow[] | null) => void;
}

// ── Clamp state ────────────────────────────────────────────────────────────

export interface ClampState {
  clamps: ClampCfg[];
  confirmedClear: boolean;
  workholdingIds: string[];
}

export interface ClampActions {
  setClamps: (v: ClampCfg[]) => void;
  setConfirmedClear: (v: boolean) => void;
  setWorkholdingIds: (v: string[]) => void;
}

// ── Simulation state ───────────────────────────────────────────────────────

export interface SimulationState {
  progress: number;
  playing: boolean;
  speed: number;
  clockShown: number;
  simCell: number;
  report: Report | null;
  showGcode: boolean;
  reportW: number;
  adviceFilter: string;
  drawingFitFilter: string;
}

export interface SimulationActions {
  setProgress: (v: number) => void;
  setPlaying: (v: boolean) => void;
  setSpeed: (v: number) => void;
  setClockShown: (v: number) => void;
  setSimCell: (v: number) => void;
  setReport: (v: Report | null) => void;
  setShowGcode: (v: boolean) => void;
  setReportW: (v: number) => void;
  setAdviceFilter: (v: string) => void;
  setDrawingFitFilter: (v: string) => void;
}

// ── Drawing state ──────────────────────────────────────────────────────────

export interface DrawingState {
  drawings: LoadedDrawing[];
  selected: number;
  sectionZ: number | null;
  plannedFrom: string | null;
  meshLoadError: string;
  drawingNote: string;
  sampleNote: string;
  busy: boolean;
  placement: { dx: number; dy: number; describe: string } | { willNotFit: true; describe: string } | null;
  sheetFits: Record<string, { fits: boolean; turn: number | null }>;
  clearance: Clearance | null;
}

export interface DrawingActions {
  setDrawings: (v: LoadedDrawing[]) => void;
  setSelected: (v: number) => void;
  setSectionZ: (v: number | null) => void;
  setPlannedFrom: (v: string | null) => void;
  setMeshLoadError: (v: string) => void;
  setDrawingNote: (v: string) => void;
  setSampleNote: (v: string) => void;
  setBusy: (v: boolean) => void;
  setPlacement: (v: DrawingState['placement']) => void;
  setSheetFits: (v: Record<string, { fits: boolean; turn: number | null }>) => void;
  setClearance: (v: Clearance | null) => void;
}

// ── Workpiece advanced state ───────────────────────────────────────────────

export interface WorkpieceAdvState {
  workpieces: Workpiece[];
  activeWorkpiece: number;
  pickedWorkpiece: { name: string; material: string | undefined } | null;
}

export interface WorkpieceAdvActions {
  setWorkpieces: (v: Workpiece[]) => void;
  setActiveWorkpiece: (v: number) => void;
  setPickedWorkpiece: (v: { name: string; material: string | undefined } | null) => void;
}

// ── App-level state ────────────────────────────────────────────────────────

export interface AppState {
  tab: string;
  cadSeen: boolean;
  ready: boolean;
  loadError: string | null;
  ver: { core: string; gcode_contract: string };
  dark: boolean;
  aboutOpen: boolean;
  ctxMenu: { x: number; y: number; object: 'stock' | 'ghost-workpiece' | 'clamp' | 'tool' | 'drawing' | 'background'; workpieceIndex?: number; clampName?: string } | null;
  jobNote: { tone: 'note' | 'bad'; text: string } | null;
  job: string;
  plant: string;
  heldProgram: RunProgram | null;
  streamSignal: StreamingSignal | null;
  restoreDismissed: boolean;
  restored: string[];
  dropped: DroppedField[];
  saveError: string | null;
  loadedMachine: LoadedRecord;
  loadedWorkpiece: LoadedRecord;
  showRapids: boolean;
}

export interface AppActions {
  setTab: (v: string) => void;
  setCadSeen: (v: boolean) => void;
  setReady: (v: boolean) => void;
  setLoadError: (v: string | null) => void;
  setVer: (v: { core: string; gcode_contract: string }) => void;
  setDark: (v: boolean) => void;
  setAboutOpen: (v: boolean) => void;
  setCtxMenu: (v: AppState['ctxMenu']) => void;
  setJobNote: (v: { tone: 'note' | 'bad'; text: string } | null) => void;
  setJob: (v: string) => void;
  setPlant: (v: string) => void;
  setHeldProgram: (v: RunProgram | null) => void;
  setStreamSignal: (v: StreamingSignal | null) => void;
  setRestoreDismissed: (v: boolean) => void;
  setRestored: (v: string[]) => void;
  setDropped: (v: DroppedField[]) => void;
  setSaveError: (v: string | null) => void;
  setLoadedMachine: (v: LoadedRecord) => void;
  setLoadedWorkpiece: (v: LoadedRecord) => void;
}

// ── Library/Inventory state ────────────────────────────────────────────────

export interface LibraryState {
  jobs: { name: string; detail: string }[];
  plants: { name: string; detail: string }[];
  lib: ToolLibrary | null;
  inventory: InventoryDoc | null;
  inventoryDropped: string[];
  inventoryError: string | null;
  inventoryImport: { report: InventoryParseReport; dropped: { kind: InventoryKind; id: string }[]; kept: number } | null;
  inventoryImportRefused: string | null;
  inventoryWriteError: string | null;
}

export interface LibraryActions {
  setJobs: (v: LibraryState['jobs']) => void;
  setPlants: (v: LibraryState['plants']) => void;
  setLib: (v: ToolLibrary | null) => void;
  setInventory: (v: InventoryDoc | null) => void;
  setInventoryDropped: (v: string[]) => void;
  setInventoryError: (v: string | null) => void;
  setInventoryImport: (v: LibraryState['inventoryImport']) => void;
  setInventoryImportRefused: (v: string | null) => void;
  setInventoryWriteError: (v: string | null) => void;
}

// ── View preferences ───────────────────────────────────────────────────────

export interface ViewState {
  unit: Unit;
  projection: Projection;
  layers: Record<string, boolean>;
}

export interface ViewActions {
  setUnit: (v: Unit) => void;
  setProjection: (v: Projection) => void;
  setLayers: (v: Record<string, boolean>) => void;
}

// ── Combined store ──────────────────────────────────────────────────────────

export type CncStore = MachineState & MachineActions &
                       OperationState & OperationActions &
                       WorkpieceState & WorkpieceActions &
                       ToolState & ToolActions &
                       ClampState & ClampActions &
                       SimulationState & SimulationActions &
                       DrawingState & DrawingActions &
                       WorkpieceAdvState & WorkpieceAdvActions &
                       AppState & AppActions &
                       LibraryState & LibraryActions &
                       ViewState & ViewActions;

export const useCncStore = create<CncStore>((set) => ({
  // Machine
  travelX: R.travelX ?? DEFAULT_TRAVEL_MM[0],
  travelY: R.travelY ?? DEFAULT_TRAVEL_MM[1],
  travelZ: R.travelZ ?? DEFAULT_TRAVEL_MM[2],
  safeZ: R.safeZ ?? 5,
  colletMm: R.colletMm ?? 6,
  spindleMax: R.spindleMax ?? 24000,
  probeEnabled: R.probeEnabled ?? false,
  touchPlateMm: R.touchPlateMm ?? '',
  supportsArcs: R.supportsArcs ?? true,
  touchPlateId: R.touchPlateId ?? '',

  setTravelX: (v) => set({ travelX: v }),
  setTravelY: (v) => set({ travelY: v }),
  setTravelZ: (v) => set({ travelZ: v }),
  setSafeZ: (v) => set({ safeZ: v }),
  setColletMm: (v) => set({ colletMm: v }),
  setSpindleMax: (v) => set({ spindleMax: v }),
  setProbeEnabled: (v) => set({ probeEnabled: v }),
  setTouchPlateMm: (v) => set({ touchPlateMm: v }),
  setSupportsArcs: (v) => set({ supportsArcs: v }),
  setTouchPlateId: (v) => set({ touchPlateId: v }),

  // Operation
  depthPerPass: R.depthPerPass ?? 4,
  rpm: R.rpm ?? 18000,
  entry: R.entry ?? 'Ramp',
  direction: R.direction ?? 'Climb',
  dogbone: R.dogbone ?? 'Corner',
  tabsEnabled: R.tabsEnabled ?? true,
  tabHeight: R.tabHeight ?? 3,
  tabWidth: R.tabWidth ?? 8,
  tabSpacing: R.tabSpacing ?? 150,
  finishAllowance: R.finishAllowance ?? 0,
  leadMm: R.leadMm ?? 0,
  probeAfterChange: R.probeAfterChange ?? true,
  useWorkpieceEdge: false,
  workpieceEdgeTol: '0.1',

  setDepthPerPass: (v) => set({ depthPerPass: v }),
  setRpm: (v) => set({ rpm: v }),
  setEntry: (v) => set({ entry: v }),
  setDirection: (v) => set({ direction: v }),
  setDogbone: (v) => set({ dogbone: v }),
  setTabsEnabled: (v) => set({ tabsEnabled: v }),
  setTabHeight: (v) => set({ tabHeight: v }),
  setTabWidth: (v) => set({ tabWidth: v }),
  setTabSpacing: (v) => set({ tabSpacing: v }),
  setFinishAllowance: (v) => set({ finishAllowance: v }),
  setLeadMm: (v) => set({ leadMm: v }),
  setProbeAfterChange: (v) => set({ probeAfterChange: v }),
  setUseWorkpieceEdge: (v) => set({ useWorkpieceEdge: v }),
  setWorkpieceEdgeTol: (v) => set({ workpieceEdgeTol: v }),

  // Workpiece
  stockX: R.stockX ?? 600,
  stockY: R.stockY ?? 900,
  thickness: R.thickness ?? 18,
  zZeroTop: R.zZeroTop ?? true,
  originX: R.originX ?? 0,
  originY: R.originY ?? 0,
  rotation: R.rotation ?? 0,
  material: 'Plywood',
  workpieceMaterialFacet: '',

  setStockX: (v) => set({ stockX: v }),
  setStockY: (v) => set({ stockY: v }),
  setThickness: (v) => set({ thickness: v }),
  setZZeroTop: (v) => set({ zZeroTop: v }),
  setOriginX: (v) => set({ originX: v }),
  setOriginY: (v) => set({ originY: v }),
  setRotation: (v) => set({ rotation: v }),
  setMaterial: (v) => set({ material: v }),
  setWorkpieceMaterialFacet: (v) => set({ workpieceMaterialFacet: v }),

  // Tools
  toolIds: ['End Mill - Down-cut 6mm 2F'],
  extraTools: null,

  setToolIds: (v) => set({ toolIds: v }),
  setExtraTools: (v) => set({ extraTools: v }),

  // Clamps
  clamps: R.clamps ?? [],
  confirmedClear: false,
  workholdingIds: R.workholdingIds ?? [],

  setClamps: (v) => set({ clamps: v }),
  setConfirmedClear: (v) => set({ confirmedClear: v }),
  setWorkholdingIds: (v) => set({ workholdingIds: v }),

  // Simulation
  progress: 1,
  playing: false,
  speed: 1,
  clockShown: 0,
  simCell: R.simCell ?? 0.6,
  report: null,
  showGcode: false,
  reportW: 260,
  adviceFilter: '',
  drawingFitFilter: '',

  setProgress: (v) => set({ progress: v }),
  setPlaying: (v) => set({ playing: v }),
  setSpeed: (v) => set({ speed: v }),
  setClockShown: (v) => set({ clockShown: v }),
  setSimCell: (v) => set({ simCell: v }),
  setReport: (v) => set({ report: v }),
  setShowGcode: (v) => set({ showGcode: v }),
  setReportW: (v) => set({ reportW: v }),
  setAdviceFilter: (v) => set({ adviceFilter: v }),
  setDrawingFitFilter: (v) => set({ drawingFitFilter: v }),

  // Drawing
  drawings: [],
  selected: 0,
  sectionZ: null,
  plannedFrom: null,
  meshLoadError: '',
  drawingNote: '',
  sampleNote: '',
  busy: false,
  placement: null,
  sheetFits: {},
  clearance: null,

  setDrawings: (v) => set({ drawings: v }),
  setSelected: (v) => set({ selected: v }),
  setSectionZ: (v) => set({ sectionZ: v }),
  setPlannedFrom: (v) => set({ plannedFrom: v }),
  setMeshLoadError: (v) => set({ meshLoadError: v }),
  setDrawingNote: (v) => set({ drawingNote: v }),
  setSampleNote: (v) => set({ sampleNote: v }),
  setBusy: (v) => set({ busy: v }),
  setPlacement: (v) => set({ placement: v }),
  setSheetFits: (v) => set({ sheetFits: v }),
  setClearance: (v) => set({ clearance: v }),

  // Workpiece advanced
  workpieces: [],
  activeWorkpiece: R.activeWorkpiece ?? 0,
  pickedWorkpiece: null,

  setWorkpieces: (v) => set({ workpieces: v }),
  setActiveWorkpiece: (v) => set({ activeWorkpiece: v }),
  setPickedWorkpiece: (v) => set({ pickedWorkpiece: v }),

  // App-level
  tab: 'cnc',
  cadSeen: false,
  ready: false,
  loadError: null,
  ver: { core: '', gcode_contract: '' },
  dark: typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches,
  aboutOpen: false,
  ctxMenu: null,
  jobNote: null,
  job: 'plate',
  plant: '',
  heldProgram: null,
  streamSignal: null,
  restoreDismissed: false,
  restored: [],
  /* 🔴 Seeded from the restore read, not `[]` — every drop the base validation
   * pass named must reach the banner. `[]` here was the migration defect that
   * reported 2 drops where 4 values had failed (only the library-bound pass
   * survived, appended later by `addDropped`). */
  dropped:
    RESTORED.status === 'ok'
      ? [...RESTORED.dropped, ...SPOILBOARD_RESTORE.dropped]
      : [...SPOILBOARD_RESTORE.dropped],
  saveError: null,
  loadedMachine: null,
  loadedWorkpiece: null,
  showRapids: true,

  setTab: (v) => set({ tab: v }),
  setCadSeen: (v) => set({ cadSeen: v }),
  setReady: (v) => set({ ready: v }),
  setLoadError: (v) => set({ loadError: v }),
  setVer: (v) => set({ ver: v }),
  setDark: (v) => set({ dark: v }),
  setAboutOpen: (v) => set({ aboutOpen: v }),
  setCtxMenu: (v) => set({ ctxMenu: v }),
  setJobNote: (v) => set({ jobNote: v }),
  setJob: (v) => set({ job: v }),
  setPlant: (v) => set({ plant: v }),
  setHeldProgram: (v) => set({ heldProgram: v }),
  setStreamSignal: (v) => set({ streamSignal: v }),
  setRestoreDismissed: (v) => set({ restoreDismissed: v }),
  setRestored: (v) => set({ restored: v }),
  setDropped: (v) => set({ dropped: v }),
  setSaveError: (v) => set({ saveError: v }),
  setLoadedMachine: (v) => set({ loadedMachine: v }),
  setLoadedWorkpiece: (v) => set({ loadedWorkpiece: v }),

  // Library/Inventory
  jobs: [],
  plants: [],
  lib: null,
  inventory: null,
  inventoryDropped: [],
  inventoryError: null,
  inventoryImport: null,
  inventoryImportRefused: null,
  inventoryWriteError: null,

  setJobs: (v) => set({ jobs: v }),
  setPlants: (v) => set({ plants: v }),
  setLib: (v) => set({ lib: v }),
  setInventory: (v) => set({ inventory: v }),
  setInventoryDropped: (v) => set({ inventoryDropped: v }),
  setInventoryError: (v) => set({ inventoryError: v }),
  setInventoryImport: (v) => set({ inventoryImport: v }),
  setInventoryImportRefused: (v) => set({ inventoryImportRefused: v }),
  setInventoryWriteError: (v) => set({ inventoryWriteError: v }),

  // View
  unit: storedCncUnit(),
  projection: storedCncProjection(),
  layers: { ...LAYER_DEFAULTS },

  setUnit: (v) => set({ unit: v }),
  setProjection: (v) => set({ projection: v }),
  setLayers: (v) => set({ layers: v }),
}));
