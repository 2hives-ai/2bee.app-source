//! Build fingerprint for the CAM core.
//!
//! # Why this file exists
//!
//! Gate I1 proves the browser and the CLI emit the SAME bytes for one program.
//! It does not prove the wasm was built from the CURRENT core. Measured
//! 2026-08-08: a `web/src/wasm` artefact was missing a plant added to the core
//! an hour earlier and **I1 passed anyway** — the change only affects planted
//! runs, so both hosts agreed on identical stale output. *"The two hosts agree"*
//! and *"the wasm is current"* are different claims and only the first was
//! checked.
//!
//! This script hashes the contents of every `.rs` file under `core/src` and
//! bakes the digest in as `twobee_cam::BUILD_ID`. Both hosts export it; gate K3
//! asserts they are equal. A wasm built from an older core carries an older id
//! and cannot agree with a freshly built CLI.
//!
//! # The bug one level down
//!
//! A fingerprint that itself goes stale would be worse than none — it would
//! assert currency it never checked. So this script emits `rerun-if-changed`
//! for **every file it hashed** *and* for the `src` directory itself (cargo
//! scans a directory recursively, which is what catches a file being ADDED or
//! DELETED — a change no per-file watch can see).
//!
//! # What the digest is, honestly
//!
//! FNV-1a/64 with a finalising mix, printed as 12 hex chars. It is a **change
//! detector, not a cryptographic hash**: it answers "was this built from these
//! bytes", not "could someone forge these bytes". Nothing here is defended
//! against an adversary; the failure being guarded is a forgotten rebuild.
//! Deliberately dependency-free — a build-dependency on a hash crate would put
//! a third crate in the trust path of a check whose whole job is to notice that
//! two builds disagree.

use std::path::{Path, PathBuf};

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let src = Path::new(&manifest).join("src");

    let mut files: Vec<PathBuf> = Vec::new();
    collect_rs(&src, &mut files);
    // Sorted by path so the digest does not depend on directory-read order,
    // which is not stable across filesystems. A fingerprint that changes when
    // nothing changed is a false red, and a false red is spent on being ignored.
    files.sort();

    if files.is_empty() {
        // Refuse rather than approximate: an empty file list would hash to a
        // constant, and a constant fingerprint agrees with everything.
        panic!("build.rs found no .rs files under {} — refusing to emit a fingerprint that cannot detect a change", src.display());
    }

    // Watch the directory as well as the files: cargo re-scans a directory
    // recursively, so this is the limb that fires when a module is added or
    // removed rather than edited.
    println!("cargo:rerun-if-changed={}", src.display());
    println!("cargo:rerun-if-changed=build.rs");

    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for f in &files {
        println!("cargo:rerun-if-changed={}", f.display());
        // The NAME is hashed as well as the contents. Renaming a file changes
        // what the crate compiles even when every byte of every file is
        // unchanged, and a contents-only digest would call that identical.
        let rel = f.strip_prefix(&manifest).unwrap_or(f).to_string_lossy().replace('\\', "/");
        h = fnv(h, rel.as_bytes());
        h = fnv(h, b"\0");
        let bytes = std::fs::read(f).unwrap_or_else(|e| panic!("cannot read {}: {e}", f.display()));
        h = fnv(h, &bytes);
        h = fnv(h, b"\0");
    }

    // Finalising mix (splitmix64-style): FNV alone leaves the low bits weakly
    // mixed, and this id is TRUNCATED to 12 hex chars, so the surviving bits
    // have to carry the whole change.
    let mut x = h;
    x ^= x >> 30;
    x = x.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^= x >> 31;

    println!("cargo:rustc-env=TWOBEE_CORE_BUILD_ID={}", &format!("{x:016x}")[..12]);
}

fn collect_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_rs(&p, out);
        } else if p.extension().and_then(|s| s.to_str()) == Some("rs") {
            out.push(p);
        }
    }
}

fn fnv(mut h: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}
