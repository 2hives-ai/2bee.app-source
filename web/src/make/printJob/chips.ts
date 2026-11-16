// The print job's predefined questions and their answer chips — the founder's
// "is skirt needed? is support needed? thick walls? stringing?" with predefined
// answers. Tapping an answer applies its overrides, after
// `validateOverrides` (./allowlist.ts), never before.
//
// 🔴 SOURCE OF TRUTH: pnp's `/home/gbacs/build/web-slicer/chips.json` (contract
// `CONTRACT-chat-job.md` §2, handed over 2026-10-14). Ported VERBATIM by a
// script from the file at sha256
// d01137a4d2236a162c04b20d36cfce9dbd4c31261ecc7602e349df178095c986 (mtime
// 2026-10-14 20:53 +1100). pnp checked every key/value by slicing with the real
// Orca (their test/chat_orca_keys.js); this app has not re-run that.
// Measured population: **9 questions, 30 answers** (the contract prose says 29).
//
// ⚠ `rel` answers (stringing: "-5 C", "-10 C and more retraction") change a
// value RELATIVE to the filament profile. The app has no filament profile, so
// `applyAnswer` refuses them whole, by name, rather than guessing a baseline or
// applying only their absolute half (a change nobody proposed).

export interface Answer {
  id: string;
  label: string;
  /** Absolute values, applied through validateOverrides. */
  overrides?: Readonly<Record<string, string | number>>;
  /** Changes relative to the filament profile's value. Not resolvable in the app. */
  rel?: Readonly<Record<string, number>>;
  why: string;
  risk: string;
}

export interface Question {
  id: string;
  title: string;
  ask: string;
  help: string;
  answers: readonly Answer[];
}

export const QUESTIONS: readonly Question[] = [
  {
    "id": "skirt_brim",
    "title": "Skirt or brim?",
    "ask": "Does the print need a skirt or a brim around the first layer?",
    "help": "A skirt only primes the nozzle. A brim is a wide flat ring that holds small, tall or warping parts to the plate.",
    "answers": [
      {
        "id": "none",
        "label": "Neither",
        "overrides": {
          "skirt_loops": 0,
          "brim_type": "no_brim"
        },
        "why": "Nothing is printed around the part. Fine for a part with a large flat base.",
        "risk": "A small or tall part can lift or fall over."
      },
      {
        "id": "skirt",
        "label": "Skirt (prime the nozzle)",
        "overrides": {
          "skirt_loops": 2,
          "skirt_distance": 3,
          "brim_type": "no_brim"
        },
        "why": "Two lines 3 mm away from the part prime the nozzle so the part starts with an even flow.",
        "risk": "None for adhesion: a skirt does not hold the part down."
      },
      {
        "id": "brim",
        "label": "Brim (small or tall part)",
        "overrides": {
          "skirt_loops": 0,
          "brim_type": "outer_only",
          "brim_width": 6,
          "brim_object_gap": 0.1
        },
        "why": "A 6 mm wide flat ring around the outside of the first layer holds the part to the plate. Cut it off afterwards.",
        "risk": "Costs a little time and needs cleaning off the edge."
      }
    ]
  },
  {
    "id": "support",
    "title": "Support?",
    "ask": "Does the part need support structures under overhangs?",
    "help": "Overhangs flatter than about 30 degrees from horizontal sag without support. If unsure, ask for the check from the model (Proposals).",
    "answers": [
      {
        "id": "none",
        "label": "No support",
        "overrides": {
          "enable_support": 0
        },
        "why": "Nothing is printed under overhangs. Fastest and cleanest.",
        "risk": "Overhangs and bridges may sag or fail."
      },
      {
        "id": "tree",
        "label": "Auto tree support",
        "overrides": {
          "enable_support": 1,
          "support_type": "tree(auto)",
          "support_threshold_angle": 30
        },
        "why": "Thin tree-shaped supports only where the model needs them (overhang steeper than 30 degrees). Easy to remove, little material.",
        "risk": "Leaves marks on the surface it touches."
      },
      {
        "id": "plate",
        "label": "Support from the plate only",
        "overrides": {
          "enable_support": 1,
          "support_type": "normal(auto)",
          "support_on_build_plate_only": 1
        },
        "why": "Straight support columns that only start on the plate, never on top of the part. Cleaner inside the part.",
        "risk": "An overhang that has part below it is left unsupported."
      },
      {
        "id": "everywhere",
        "label": "Support everything",
        "overrides": {
          "enable_support": 1,
          "support_type": "normal(auto)",
          "support_threshold_angle": 55,
          "support_on_build_plate_only": 0
        },
        "why": "A low overhang limit: even gentle slopes get support. Safest surface under overhangs.",
        "risk": "Uses the most material and time; harder to clean."
      }
    ]
  },
  {
    "id": "strength",
    "title": "Wall strength",
    "ask": "How strong must the walls be?",
    "help": "Walls carry most of the load of a printed part. More walls = stronger, heavier and slower.",
    "answers": [
      {
        "id": "thin",
        "label": "Light (2 walls)",
        "overrides": {
          "wall_loops": 2,
          "top_shell_layers": 4,
          "bottom_shell_layers": 3
        },
        "why": "Two walls and thin top and bottom skins. Quick and light, for display parts.",
        "risk": "Not for parts that carry load."
      },
      {
        "id": "normal",
        "label": "Normal (3 walls)",
        "overrides": {
          "wall_loops": 3,
          "top_shell_layers": 5,
          "bottom_shell_layers": 4
        },
        "why": "Three walls: a good balance for everyday parts.",
        "risk": "None specific."
      },
      {
        "id": "thick",
        "label": "Thick (4 walls)",
        "overrides": {
          "wall_loops": 4,
          "top_shell_layers": 6,
          "bottom_shell_layers": 5
        },
        "why": "Four walls and thicker skins: much stiffer, for brackets and holders.",
        "risk": "Slower, uses more filament."
      },
      {
        "id": "heavy",
        "label": "Very thick (6 walls)",
        "overrides": {
          "wall_loops": 6,
          "top_shell_layers": 8,
          "bottom_shell_layers": 6
        },
        "why": "Six walls: nearly solid for small parts that take real load.",
        "risk": "Slow; small parts become almost solid."
      }
    ]
  },
  {
    "id": "infill",
    "title": "Infill",
    "ask": "How much infill inside the part?",
    "help": "Infill is the grid inside the walls. Past about 40 percent the extra strength is small.",
    "answers": [
      {
        "id": "d10",
        "label": "10 percent",
        "overrides": {
          "sparse_infill_density": 10
        },
        "why": "Sparse inside, saves time and filament.",
        "risk": "Top surfaces over large gaps can look slightly rough."
      },
      {
        "id": "d20",
        "label": "20 percent",
        "overrides": {
          "sparse_infill_density": 20
        },
        "why": "The usual default for functional parts.",
        "risk": "None specific."
      },
      {
        "id": "d40",
        "label": "40 percent",
        "overrides": {
          "sparse_infill_density": 40
        },
        "why": "Dense inside for parts under load.",
        "risk": "Noticeably longer print."
      },
      {
        "id": "gyroid",
        "label": "Gyroid 20 percent (even strength)",
        "overrides": {
          "sparse_infill_density": 20,
          "sparse_infill_pattern": "gyroid"
        },
        "why": "Gyroid is equally strong in every direction and prints without sharp corners.",
        "risk": "Slightly slower than grid."
      }
    ]
  },
  {
    "id": "quality",
    "title": "Quality or speed",
    "ask": "Quality or speed?",
    "help": "Thinner layers look smoother but take many more layers. This printer's range with the 0.4 mm nozzle is 0.08 to 0.28 mm.",
    "answers": [
      {
        "id": "quick",
        "label": "Quick (0.28 mm)",
        "overrides": {
          "layer_height": 0.28
        },
        "why": "Thick layers: about 30 percent fewer layers than 0.20 mm. Layer lines are visible.",
        "risk": "Rougher curves and slopes."
      },
      {
        "id": "normal",
        "label": "Normal (0.20 mm)",
        "overrides": {
          "layer_height": 0.2
        },
        "why": "The standard balance.",
        "risk": "None specific."
      },
      {
        "id": "fine",
        "label": "Fine (0.12 mm)",
        "overrides": {
          "layer_height": 0.12
        },
        "why": "Smooth curves and small detail.",
        "risk": "About 70 percent more layers, much slower."
      },
      {
        "id": "vfine",
        "label": "Very fine (0.08 mm)",
        "overrides": {
          "layer_height": 0.08
        },
        "why": "Finest layers this printer offers, for small display parts.",
        "risk": "2.5 times the layers of 0.20 mm: very slow."
      }
    ]
  },
  {
    "id": "stringing",
    "title": "Stringing and oozing",
    "ask": "Does it leave thin strings or blobs between parts?",
    "help": "Hot, wet or under-retracted filament oozes while the nozzle travels.",
    "answers": [
      {
        "id": "cooler5",
        "label": "A little cooler (-5 C)",
        "rel": {
          "nozzle_temperature": -5
        },
        "why": "Cooler plastic is thicker and oozes less. Try this first.",
        "risk": "Layers may bond slightly less."
      },
      {
        "id": "cooler10",
        "label": "Much less (-10 C and more retraction)",
        "rel": {
          "nozzle_temperature": -10,
          "filament_retraction_length": 0.3
        },
        "overrides": {
          "filament_wipe": 1
        },
        "why": "Ten degrees cooler, 0.3 mm more retraction and a wipe while retracting.",
        "risk": "Weaker layer bonding; too much retraction can cause gaps."
      },
      {
        "id": "travel",
        "label": "Keep the nozzle over the part",
        "overrides": {
          "reduce_crossing_wall": 1,
          "filament_z_hop": 0.2
        },
        "why": "Travel moves avoid crossing outer walls, where strings show, and lift 0.2 mm.",
        "risk": "A little longer travel time."
      },
      {
        "id": "dry",
        "label": "Dry the filament first (no setting)",
        "overrides": {},
        "why": "Wet filament is the most common cause of stringing and cannot be fixed by settings. Dry it (PETG about 65 C for 6 h) and print again.",
        "risk": "None."
      }
    ]
  },
  {
    "id": "plate",
    "title": "Plate and adhesion",
    "ask": "Which plate, and does the first layer need help sticking?",
    "help": "Textured plate gives a rough, matte underside and strong grip. A smooth plate gives a glossy underside.",
    "answers": [
      {
        "id": "textured",
        "label": "Textured PEI plate",
        "overrides": {
          "curr_bed_type": "Textured PEI Plate"
        },
        "why": "Strong grip, matte underside. The default for PETG.",
        "risk": "Rough bottom surface."
      },
      {
        "id": "engineering",
        "label": "Engineering plate",
        "overrides": {
          "curr_bed_type": "Engineering Plate"
        },
        "why": "Smooth bottom, for materials such as ABS/ASA/PA.",
        "risk": "PETG can stick too hard to some plates: use glue stick as a release layer."
      },
      {
        "id": "help",
        "label": "Help the first layer stick",
        "overrides": {
          "brim_type": "outer_only",
          "brim_width": 5,
          "initial_layer_speed": 30
        },
        "why": "A 5 mm brim and a slow (30 mm/s) first layer so the first lines press into the plate.",
        "risk": "Slightly longer print; brim to remove."
      }
    ]
  },
  {
    "id": "time_vs_strength",
    "title": "Time versus strength",
    "ask": "What matters more, a short print or a strong part?",
    "help": "Three ready-made trade-offs that change layer height, walls and infill together.",
    "answers": [
      {
        "id": "fast",
        "label": "Short print time",
        "overrides": {
          "layer_height": 0.28,
          "wall_loops": 2,
          "sparse_infill_density": 8,
          "top_shell_layers": 4,
          "bottom_shell_layers": 3
        },
        "why": "Thick layers, two walls, 8 percent infill: the shortest print that still closes the top.",
        "risk": "Weak and rough: display only."
      },
      {
        "id": "balanced",
        "label": "Balanced",
        "overrides": {
          "layer_height": 0.2,
          "wall_loops": 3,
          "sparse_infill_density": 15,
          "top_shell_layers": 5,
          "bottom_shell_layers": 4
        },
        "why": "Standard layers, three walls, 15 percent infill.",
        "risk": "None specific."
      },
      {
        "id": "strong",
        "label": "Strongest",
        "overrides": {
          "layer_height": 0.16,
          "wall_loops": 5,
          "sparse_infill_density": 40,
          "sparse_infill_pattern": "gyroid",
          "top_shell_layers": 6,
          "bottom_shell_layers": 6
        },
        "why": "Fine layers bond better, five walls, 40 percent gyroid infill.",
        "risk": "Roughly 2 to 3 times longer than the short setting."
      }
    ]
  },
  {
    "id": "quick",
    "title": "Make it quick",
    "ask": "Just make it as quick as sensible?",
    "help": "One press. The printer's flow limit caps the real speed, so the main saving comes from thicker layers and less infill.",
    "answers": [
      {
        "id": "quick",
        "label": "Make it quick",
        "overrides": {
          "layer_height": 0.28,
          "wall_loops": 2,
          "sparse_infill_density": 8,
          "top_shell_layers": 4,
          "bottom_shell_layers": 3,
          "reduce_crossing_wall": 0
        },
        "why": "0.28 mm layers, 2 walls, 8 percent infill. Speeds above the filament's flow limit do nothing, so they are left alone.",
        "risk": "Visible layer lines and a weaker part."
      }
    ]
  }
];
