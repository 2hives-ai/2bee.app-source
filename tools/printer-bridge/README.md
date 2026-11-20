# printer-bridge — upload a job to the X2D, then start, pause, resume or stop it

Product scope step 3, *"send it to the printer"* (founder 2026-10-14). Asked for in `pnp`'s
handover `2026-10-14-17-41-06`. A small Node server with no npm dependencies. It takes G-code
text from the app, wraps it in a `.gcode.3mf`, and copies it to the Bambu Lab X2D's storage over
the LAN with implicit FTPS. Then it reads back the file's size from the printer.

## 🔴 Print commands — founder 2026-10-20

*"add remote start"*, then *"remote pause, remote stop"*. This supersedes 2026-10-14 *"Upload only"*.
The bridge now speaks the printer's LAN MQTT (port 8883, user `bblp`, the access code) on
`device/<serial>/request|report`. Starting the bridge with `--serial` turns it on. Without that flag
every print route answers 409 and nothing connects.

It can publish exactly four print commands: `project_file`, `pause`, `resume` and `stop`
(`MQTT_COMMANDS`). It can also send the `pushall` status request and the five controls in the
section below (light, `set_fan`, `set_airduct`, `print_speed`, `skip_objects`), each in one exact
shape. Anything else throws before a byte is written. Every command:
- reads the printer's state first and refuses the wrong state with a 409. Start needs
  `IDLE`/`FINISH`/`FAILED`, pause needs `RUNNING`/`PREPARE`, resume needs `PAUSE`, and stop needs an
  active print;
- for start, also checks the filament type the printer reports in each mapped AMS slot against
  `expectTypes`. It also refuses a `remote` this bridge run did not upload and size-confirm;
- answers with the state the printer reports **after** the command. If the printer does not reach
  the expected state within 30 s, the answer is 504, never 200.

Start and resume need `"confirm": "at-printer"` in the body. The page sends it for start only after a
person ticks "I am at the printer", and for resume only after a confirm dialog. Pause and stop need
no confirm, because they are the safe direction.

The start shape (`url: ftp:///<file>`, `param: Metadata/plate_1.gcode`, `ams_mapping`, `md5` = the
lowercase MD5 of the uploaded `.gcode.3mf` FILE) is the one `pnp`'s prototype ran on this X2D on
2026-10-14. There it was accepted the first time.
🔴 **2026-10-20, first real start from this bridge:** the bridge sent `md5: ""`. The X2D took the
job name and went `FAILED`, `print_error` 83902534 = **HMS 0500-4046**, on both tries. The
bridge now sends the file MD5, as the prototype did. ⚠ The MD5 is the most likely cause, but it is
**not proven**: Bambu's public wiki page for 0500-4046 was not readable (HTTP 402). If the
retry fails the same way, the next suspect is this bridge's smaller package (no mesh, no
thumbnails, no `project_settings.config`), since the prototype uploaded an Orca-built one. **Pause,
resume and stop had not been run against the real X2D when this landed.**

**Camera** (founder 2026-10-20, *"can I see the video stream in 3d?"*): `POST /v1/camera.jpg`
returns the latest JPEG of the X2D's live view (RTSPS, port 322). One `ffmpeg` runs only while
someone is asking, at about 2 frames a second, and stops 20 s after the last request. The stream
URL carries the access code, so it is never on ffmpeg's command line, where every user on the
machine can read it. It goes into a 0600 file in a fresh 0700 directory, and that file is deleted
once ffmpeg has read it, or when the bridge stops. Flags: `--ffmpeg PATH`, `--camera-port N`.

The FTP side stays upload-only. Its client can only send the ten verbs in `FTP_VERBS`
(`USER PASS PBSZ PROT TYPE EPSV PASV STOR SIZE QUIT`).

## Fans — founder 2026-11-13

*"able to change the fan options on the 3d printer"*. `POST /v1/fan {id, percent}` sets ONE fan to
0–100 % in steps of 10, as one `set_fan {fan_index, speed}`. The X2D reports its fans in
`device.airduct` (Bambu's newer protocol). The shape comes from Bambu Studio's
`DeviceCore/DevFan.cpp` (`command_control_fan_new`, `ParseV3_0`) and `Widgets/FanControl.cpp`. Fan
names per mode come from `resources/printers/N6.json` (the X2D).

- Only a fan the current mode lists in `ctrl` is settable. The others are `auto` (the printer runs
  them) and are refused with 409. In **Heating** mode, Left (Heating) is `auto`.
- The answer is the fan value the printer reports **after** the command, or 504.
- `MqttClient.publish` accepts `set_fan` only with exactly the keys `sequence_id, command,
  fan_index, speed`, `fan_index` in 1/2/3/10, `speed` a multiple of 10 in 0–100.
- The fan MODE (Strong Cooling / Heating, `set_airduct`) is switched only by `/v1/fanmode` (see
  the next section). It moves the duct doors, so the page asks for a confirm first. ⚠ This line
  said *"NOT sent"* until 2026-11-14, after `/v1/fanmode` had landed.
- The page asks for a confirm when a print is running, the same warning Bambu Studio gives: a fan
  change mid-print can change the print.

**Run on the real X2D, 2026-11-13, mid-print in Heating mode:** Exhaust 70 → 80 → 70, each answered
200 with the value read back from the printer. Parts, Right (Filter) and Strong Cooling mode were
not run.

## Speed, fan mode, skip objects, messages — founder 2026-11-13 ("add all")

Each one has ONE published shape, checked in `MqttClient.publish` (`*CommandValid`), and each
answer is the value the printer reports **after** the command, or 504. Shapes are Bambu Studio's
(`DeviceManager.cpp`, `DeviceCore/DevFan.cpp`).

| Route | Sends | Refuses |
|---|---|---|
| `/v1/speed {level: 1-4}` | `print_speed {param:"1".."4"}` (Silent, Standard, Sport, Ludicrous) | 409 when no print is running |
| `/v1/fanmode {mode}` | `set_airduct {modeId, submode:-1}` | 409 for a mode the printer does not list |
| `/v1/skip {ids, confirm:"skip"}` | `skip_objects {obj_list}` | 400 without the confirm · 409 when no print, when the running file was not uploaded by this bridge run, for an id the file does not name, and for a skip that leaves no object (that is Stop) |

Read only, in `/v1/status`:
- `hms`: the printer's HMS messages with Bambu's text, from `hms_en_20P.json.gz` here: Bambu
  Studio `resources/hms/hms_en_20P.json` (AGPL-3.0, table version 202511162200), 20P = the X2D's
  serial prefix. A code Bambu's table does not describe is shown as a code, `text: null`.
  ⚠ The X2D reports one such code right now (`0500-0600-0002-0070`, empty in Bambu's own table).
- `errorText`: `print_error` from the same file's `device_error` table.
- `stage`: `stg_cur` named from Bambu Studio's `get_stage_string` (0-77); 255 = none.
- `speed`, `fanModeId`, `fanModes`, `skipped` (`s_obj`), and `objects` of the running file when
  this bridge uploaded it. Each object carries `hull`: its top-view footprint in plate mm, the convex
  hull of its EXTRUDING moves inside its label lines (G2/G3 arcs sampled from I/J; travel, retracts
  and unlabelled lines excluded), read at upload by `objectFootprints`. `printableArea` is the file's
  own `printable_area`. The printer card draws the plate from these, so the outline beside Skip is
  the file that prints; an object with no extrusion read has no `hull`, never a guessed one.

**Objects in the package.** The upload reads the label lines in the G-code (`; printing object
<name> …` / `; start printing object, unique label id: N`, written by 2bee.fdm and Orca) and now
writes `label_object_enabled = true` when there are any, and one `<object identify_id name
skipped>` per object when there are two or more. That is Orca's shape: its single-object X2D
package `pnp_blinds` (printed) has `true` and no `<object>` line; its multi-object package
`~/build/web-slicer/test/fixtures/now-printing.gcode.3mf` has the lines after the metadata.
🔴 **No package from THIS bridge with these lines has been started on the X2D yet.** If the next
start of a labelled file fails with HMS 0500-4046 ("3MF file is invalid"), this change is the
first suspect.

**Run on the real X2D, 2026-11-13, mid-print:** speed Standard → Silent → Standard, each 200 with
`spd_lvl` read back. Status read there: `hms` (one code, no Bambu text), stage "Printing", fan
modes Strong Cooling/Heating. **Not run on the real X2D:** fan mode switch and skip (the running
print was a personal part, not ours to change, and not uploaded by this bridge).

The page also shows a browser notification with one camera frame when a print goes from active to
FINISH or FAILED. Only while the page is open, and only after the browser's permission (asked on
Start).

## Run it

```bash
X2D_ACCESS_CODE='<code>' node tools/printer-bridge/bridge.mjs --printer 192.168.50.151
node tools/printer-bridge/bridge.mjs --printer 192.168.50.151 --code-file ~/.config/2bee/x2d.code \
  --serial <serial> --token-file ~/.config/2bee/printer.token
```

**On this machine it runs as a systemd user service** (founder 2026-10-20, *"use systemd"*). The
unit is `~/.config/systemd/user/2bee-printer-bridge.service` and lingering is on, so it starts at
boot. `systemctl --user restart 2bee-printer-bridge` · `journalctl --user -u 2bee-printer-bridge`.
⚠ A restart forgets which files this run uploaded, so upload a plate again before you start it.

`--printer <ip>` is **required**. Without it the bridge exits **2** with a message. The value must
be an **IP literal** on a private or loopback network (10/8, 172.16/12, 192.168/16, 169.254/16,
127/8, `::1`, `fc00::/7`, `fe80::/10`). A hostname or a public IP exits 2. The access code is only
ever sent to a printer on the LAN, and the certificate exception below is tied to an address that
DNS cannot re-point.

Every flag: `--printer IP` · `--printer-port N` (default 990; exists for the tests and for port
forwarding) · `--serial SERIAL` or env `X2D_SERIAL` (turns on the print routes; prefer the env — a command-line value is in `ps` for every local user; the banner prints only that it is set) · `--mqtt-port N` (default 8883) · `--printer-cert-sha256 HEX` (optional pin, see below) · `--code-file PATH` ·
`--port N` (default 8788) · `--host 127.0.0.1` (the only accepted value) · `--allow-origin URL`
(repeatable) · `--token-file PATH` · `--timeout SECONDS` (default 120) · `--max-body BYTES`
(default 64 MiB). Any other flag exits **2**.

Env: `X2D_ACCESS_CODE` (the printer's LAN access code) · `PRINTER_BRIDGE_TOKEN` (this bridge's
bearer token).

## API

Every route is `POST`, need `Authorization: Bearer <bridge token>`, and answer JSON.

| Route | Body | Answer |
|---|---|---|
| `/v1/progress` | anything (ignored) | `{upload: {remote, phase, sent, total} \| null, queued}`. The upload on the printer link now, from the bridge's own counter: `sent` is bytes handed to the FTPS data socket (64 KB steps), `confirming` = all sent, waiting on the printer's 226 + SIZE. Never contacts the printer, takes no lock. The page draws the Upload button as a bar from it (founder 2026-11-20). |
| `/v1/check` | anything (ignored) | `{reachable, haveCode, printer}`. `reachable` is a plain TCP connect to the printer's port 990. No TLS, no login, no FTP command. |
| `/v1/upload` | `{"name": "feeder lid", "gcode": "<G-code text>"}` | 200 `{ok:true, remote, bytes, remoteBytes, md5, started:false}` |
| `/v1/status` | anything | `{ok, state, task, percent, layer, layers, remainMin, nozzle, nozzleTarget, bed, bedTarget, error, slots, light, fanMode, fans}`, read from the printer. Absent values are `null` |
| `/v1/start` | `{remote, amsMapping:[tray], expectTypes:[type], bedType, confirm:"at-printer"}` | 200 `{ok, started:true, remote, state, …}` once the printer reports `PREPARE`/`RUNNING`/`SLICING` |
| `/v1/pause` | anything | 200 `{ok, state, …}` once the printer reports `PAUSE` |
| `/v1/resume` | `{confirm:"at-printer"}` | 200 `{ok, state, …}` once the printer reports `RUNNING` |
| `/v1/stop` | anything | 200 `{ok, state, …}` once the printer reports no active print |
| `/v1/light` | `{on: true\|false}` | 200 status once the printer reports the chamber light in that mode |
| `/v1/speed`, `/v1/fanmode`, `/v1/skip` | see the section above | 200 status, read back |
| `/v1/fan` | `{id: 1\|2\|3\|10, percent: 0..100 step 10}` | 200 status (`fanMode`, `fans:[{id, name, percent, control}]`) once the printer reports that fan at that value. 409 for a fan the mode runs itself |

`remote` is the file name on the printer: the caller's `name`, with extensions stripped, every
character outside `[A-Za-z0-9_-]` turned into `_`, cut to 64 characters, then `_` + the first 8 hex
digits of the G-code's MD5 + `.gcode.3mf`. So the same G-code always gets the same name, and an
upload of the same G-code **overwrites** that one file. `bytes` is the size of the package built
here. `remoteBytes` is what the printer's `SIZE` reply says.

Failures carry `{ok:false, started:false, error:{message, code}}`:

| Status | When |
|---|---|
| 400 | body is not JSON, `gcode` is missing, blank or contains NUL, or `name` is not a string |
| 401 / 403 | wrong or missing token / Origin not allowed / Host not loopback |
| 409 | the bridge was started without an access code |
| 413 | body over `--max-body` |
| 429 | 4 uploads already queued · a printer command other than pause/stop while another one runs (the page's status read included) · pause/stop still waiting after 60 s — pause and stop WAIT for the running command rather than being refused |
| 502 | the printer refused (login, STOR, TLS…). **Also returned when the upload finished but `SIZE` does not equal `bytes`.** That case is never a 200 |
| 504 | the whole upload took longer than `--timeout` |

One upload runs at a time. If the client disconnects mid-upload, the upload is **not** aborted:
a half-written file on the printer is worse than a finished one nobody saw.

## The access code

- From `--code-file PATH` (first line, trimmed), else env `X2D_ACCESS_CODE`. **Never** from
  OrcaSlicer's config files, which is where the prototype `web-slicer/server.js` read it.
- It must be 4–64 printable ASCII characters with no spaces. It goes on the FTP control line, so a
  CR/LF in it would be command injection; the bridge refuses to start (exit 2) and does not echo
  it.
- Without a code the bridge still starts: `/v1/check` says `haveCode:false` and uploads get a 409.
- The code is never logged or echoed. Every error text and every JSON response is passed through
  a redactor that replaces the code with `***`. The fake printer in the tests **echoes the password
  in its 530 reply** to show the redactor catches a printer that leaks it.

## The printer's certificate (self-signed)

The X2D presents a self-signed certificate on port 990, so normal verification cannot pass.
`tlsOptionsFor(host, printerIp)` turns verification off **only when the host is the exact
`--printer` IP**. The data connection always goes to that same IP: an EPSV/PASV reply that names
another address is ignored, not followed (tested with a PASV reply naming `10.99.99.99`).

⚠ **What that leaves open:** without a pin, a device on the LAN that takes over the printer's IP
could accept the TLS connection and receive the access code. If that matters, pin the
certificate:

```bash
openssl s_client -connect 192.168.50.151:990 </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256
node tools/printer-bridge/bridge.mjs --printer 192.168.50.151 --printer-cert-sha256 AB:CD:...
```

With a pin, a mismatched certificate is refused **before** `USER`/`PASS` are sent.

## The FTPS conversation

Implicit TLS from the first byte on port 990, using only `node:tls`:

```
220 ← greeting
USER bblp → 331 · PASS <code> → 230 · PBSZ 0 → 200 · PROT P → 200 · TYPE I → 200
EPSV → 229 (or 5xx → PASV → 227)
TLS data connection to the printer IP, REUSING the control TLS session
STOR <remote> → 150 · data · 226
SIZE <remote> → 213 <n>
QUIT → 221
```

**Session reuse:** vsftpd-style servers refuse a data connection that does not resume the
control connection's TLS session (`522 … session reuse required`), and the fake printer does the
same. A planted client that omits the session fails four tests (red run (c) below).

## The `.gcode.3mf`

Built in memory with `node:zlib` (`deflateRawSync`, `crc32`). It is a plain ZIP: DEFLATE, no
ZIP64, and a fixed 1980-01-01 timestamp, so the same G-code gives the same bytes. It holds the
G-code-carrying subset of an OrcaSlicer 2.5.0-dev export
(`/tmp/web-slicer-jobs/771285bc4e89e141/job.gcode.3mf`, `unzip -l`, 13 entries), in Orca's order:

| Entry | Content |
|---|---|
| `[Content_Types].xml` | verbatim from the Orca export |
| `Metadata/plate_1.json` | `version 2`, `nozzle_diameter`, `filament_colors` / `filament_ids` **only where the G-code's own `; key = value` comments state them** |
| `Metadata/plate_1.gcode.md5` | MD5 of `plate_1.gcode`, **upper-case hex**, as Orca writes it |
| `Metadata/plate_1.gcode` | the G-code, byte for byte |
| `Metadata/_rels/model_settings.config.rels` | the bambulab `gcode` relationship to `/Metadata/plate_1.gcode` (as Orca) |
| `Metadata/model_settings.config` | one `<plate>` with `gcode_file = Metadata/plate_1.gcode`, and no objects |
| `Metadata/slice_info.config` | client header + `prediction` (from `total estimated time:`), `nozzle_diameters`, `<filament type color>`, again only where the G-code states them |
| `_rels/.rels` | **empty**. Orca's points at `3D/3dmodel.model` and plate PNGs, none of which exist here, and a relationship to a missing part is worse than none |

**Left out on purpose:** `3D/3dmodel.model` + `3D/Objects/*` (the mesh), `3D/_rels/*`,
`Metadata/project_settings.config`, `Metadata/filament_sequence.json`, and the plate thumbnails.
`bed_type` is not derived either: Orca maps `curr_bed_type = Textured PEI Plate` to
`textured_plate` through its own table, and a guessed mapping would show a wrong plate name on
the printer's screen.

**Checked 2026-10-14 against the Orca export's own G-code:** the built package passes `unzip -t`.
Its `plate_1.gcode.md5` is `B775C31B28E06DE495EEA73A4736F646`, equal to Orca's, and its
`prediction` is `4614`, equal to Orca's.

## 🔴 Not verified

- **No upload by this bridge has reached the real X2D.** No access code was supplied, and it is
  deliberately not read from Orca's config. `/v1/check` against `192.168.50.151` answered
  `{"reachable":true,"haveCode":false}` on 2026-10-14, which is a TCP connect only. The prototype's
  upload of an **Orca-built** package (1,084,720 bytes, size-confirmed) is `pnp`'s evidence, not
  this code's.
- **Whether the X2D's screen will list and start this smaller package is unknown.** It lacks the
  mesh, the thumbnails and `project_settings.config`. The printer may want some of them. Find out at
  the printer before anyone relies on it.
- **Session reuse against the real printer** is shown only against a fake that enforces it.
- **TLS version / EPSV support of the X2D** is not known. The client sets TLS ≥ 1.2 and falls back
  from EPSV to PASV.

**Measured 2026-10-20:** with the code from 1Password, `/v1/check` answered
`{"reachable":true,"haveCode":true}`. The app uploaded `Mouse_bait_box-plate1_4e1626cb.gcode.3mf`
(531,946 bytes, size confirmed), and an FTPS listing showed it in the printer's root. Neither the
upload nor the listing shows whether the printer's screen will START it.

## Tests

```bash
node --test tools/printer-bridge/printer-bridge.test.mjs
```

46 tests (`node --test tools/printer-bridge/printer-bridge.test.mjs`, 2026-11-13). The HTTP tests run the **real `bridge.mjs` as a subprocess**, pointed at a **fake
implicit-FTPS printer** on 127.0.0.1. The fake uses a throwaway self-signed certificate generated
at test time with `openssl`. It records every command and the stored bytes, enforces TLS session
reuse, and echoes the password on a failed login. **Without `openssl` the printer-dependent tests
are SKIPPED with a `PENDING:` reason.** They then show in the `# skipped` count and are never
counted as passed.

Covered: 401 (no/wrong token, printer never contacted) · 403 (Origin, preflight, Host) · OPTIONS
+ PNA · start refusals (no printer, hostname, public IP, `--host`, CR/LF code) · 127.0.0.1-only
bind · 400/405/409/413 with no printer contact · `/v1/check` (no FTP command sent) · the full upload
(stored bytes == built 3mf, entry list, G-code verbatim, MD5, metadata, the exact verb sequence,
`PASS` carries the code once, SIZE after STOR, data session reused, code absent from response, log
and stderr, log has no body or token) · PASV fallback ignoring a foreign host · SIZE mismatch → 502
· wrong code → 502 with the echoed code redacted · one upload at a time · the FTP upload-only
construction · file-name sanitising · the self-signed exception keyed to the printer IP · code
precedence. Print routes, against a **fake Bambu MQTT broker**: 409 without `--serial` (no
login) · status read from the report, subscribed to `device/<serial>/report`, `pushall` only · start
refused without `at-printer` and for a file this run did not upload (no login) · upload → start →
`PREPARE` with the X2D command shape · start refused when the printer is busy or the slot holds
another filament (no `project_file` sent) · a printer that ignores the start is 504, never 200 ·
pause/resume/stop read back, wrong-state 409 · MQTT wrong code → 502, redacted · the MQTT command
allowlist · `set_fan` refused in any shape but fanCommand's · fans parsed from the X2D's real
airduct block · fan set + read back, `auto` fan 409, bad percent 400 with nothing published, a
printer that ignores `set_fan` → 504.

Fan plant (2026-11-13): `fanCommandValid` made to `return true ||…` → `set_fan only in the exact
shape` **fail 1**; restored → 40 pass.
Plants 2026-11-13, each sed-applied, its test run, file restored and `cmp`-checked: skip-every-object
guard off → `skip:` fail 1 · HMS key with code before attr → `status texts` fail 1 · `<object>`
lines dropped → `objects:` fail 1 · speed always sent as level 4 → `speed:` fail 1. Restored → 46 pass.

**Red runs** (2026-10-14; each plant was sed-applied to `bridge.mjs`, the suite run, then the file
restored, and `cmp` confirmed it was byte-identical):

| Plant | Result |
|---|---|
| (a) token check skipped (`if (false && !tokenMatches…`) | `not ok 1 - 401 without a token…` · pass 15 fail 1 |
| (b) `plate_1.gcode.md5` written reversed | `not ok 8 - upload…` *"plate_1.gcode.md5 must be the MD5 of plate_1.gcode"* · pass 15 fail 1 |
| (c) data connection without the control TLS session | `not ok 8, 9, 10, 12` with `522 SSL connection failed: session reuse required` · pass 12 fail 4 |
| restored | 16 pass, 0 fail, 0 skipped |

⚠ As with `claude-bridge`, name the **file**. `node --test tools/printer-bridge/` (a directory)
does not work on Node 22.
