# claude-bridge — the app's "Ask a model" through your local `claude` CLI

Founder 2026-10-14: *"local ai bridge is claude-cli"* · *"use the claude executable (I will
update the token manually)"*.

A small Node server (no npm dependencies) that lets the 2bee.app Ask features — the 2bee.cad
edit, the CNC job ask, and the three-step **Change** step — use the `claude` CLI already logged
in on this machine. It speaks the OpenAI chat-completions shape `web/src/cad/ask.tsx` already
sends, and answers every request by running **one** `claude -p` with **no tools**.

## Run it

```bash
node tools/claude-bridge/bridge.mjs                  # 127.0.0.1:8787, token generated + printed
node tools/claude-bridge/bridge.mjs --port 8790
CLAUDE_BRIDGE_TOKEN='<your token>' node tools/claude-bridge/bridge.mjs
node tools/claude-bridge/bridge.mjs --token-file ~/.config/claude-bridge.token
node tools/claude-bridge/bridge.mjs --allow-origin http://localhost:4173   # repeatable
node tools/claude-bridge/bridge.mjs --timeout 300    # seconds per request (default 120)
```

Every flag: `--port N` · `--host 127.0.0.1` (the only accepted value) · `--allow-origin URL`
(repeatable, adds to the defaults) · `--token-file PATH` · `--timeout SECONDS` ·
`--max-body BYTES` (default 2 MiB) · `--no-caveman` (replies use the caveman style by default: terse prose, formats and exact values kept; founder 2026-10-16). Anything else exits **2** with a message, as does
`--host` with any other value.

Env: `CLAUDE_BRIDGE_TOKEN` (the bridge token, see below) · `CLAUDE_BIN` (path to the `claude`
executable; default `claude` on `PATH`. **This exists for the tests** — it lets them put a fake
in place of the CLI).

**On this machine it runs as a systemd user service**, like the printer bridge (founder
2026-11-22: *"It should be automatically connected via bridge like the printer?"*). The unit is
`~/.config/systemd/user/2bee-claude-bridge.service`: port 8787, `--token-file
~/.config/claude-bridge.token` (the same file the dev server's `/__claude` proxy reads, so there is
one key), `--timeout 180`, `Nice=10`. `systemctl --user restart 2bee-claude-bridge` ·
`journalctl --user -u 2bee-claude-bridge`.

## Found by the app: `GET /v1/hello`

`GET /v1/hello` needs no token and returns `{ ok, bridge: "2bee.claude-bridge", api, needsToken,
models, peers }`. It never contains the token. A page whose Origin is not allowed gets 403. The bridge
also records itself in `tools/bridge-registry.mjs`, so the printer and slicer bridges list it in their
own hellos.

When no AI address is stored in the browser, 2bee.app (`web/src/ai/aiBridge.ts`, run once in
`main.tsx` before the app renders) asks `127.0.0.1:8787/v1/hello`. If that gets no answer, it asks
the peers the printer and slicer bridges list. It believes only a hello naming `2bee.claude-bridge`,
and then it fills the Endpoint and Model below. It never fills or stores a key, never replaces an
address the person typed, and does not run on the dev server. **The key is pasted once** in "Set up
AI", with Remember ticked, just as for the printer.

## Paste into the app's Ask settings (File → Settings…)

| Field | Value |
|---|---|
| Endpoint | `http://127.0.0.1:8787/v1/chat/completions` |
| Model | `claude-sonnet` (or `claude-opus`, `claude-haiku`, `claude-fable`) — **List models** also works |
| Key | the bridge token (below) |
| Timeout | the app defaults to 60 s; raise it for long Opus answers. The bridge itself gives up at 120 s |

The model ids map to `claude --model sonnet|opus|haiku|fable`. Any other id is a 400.

## The bridge token — yours to set

This is the bridge's own bearer token. **It is not Claude's login and has nothing to do with it.**

1. `--token-file PATH` — first line of the file, trimmed. Wins over the env var.
2. env `CLAUDE_BRIDGE_TOKEN`.
3. Neither given: a random token is generated for this run and **printed once** at startup.

A token from a file or the env is **never printed** (startup says *"the token from … (not
printed)"*). It must be at least 16 characters with no whitespace, or the bridge refuses to
start (exit 2). Requests without `Authorization: Bearer <token>`, or with the wrong one, get
**401** and the CLI is never started.

## What it can and cannot do

**Can:** answer a text conversation with your logged-in Claude model. System messages become
the system prompt; user/assistant turns go to the CLI on stdin.

**Images (2026-10-15, for the Tools tab's "Photo the cutter"):** the **last user message** may
carry `{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,…"}}` parts (jpeg, png,
gif, webp; at most 4). They reach the CLI as image content blocks through
`--input-format stream-json` (see the command below). Refused with **400**, and the CLI never
starts: an `http(s)` image URL (**the bridge fetches nothing**), any other media type, a
malformed data URL, an image in an earlier turn, more than 4 images. A text-only request takes
exactly the old path. The app resizes a photo to 1024 px JPEG before sending, a few hundred kB,
so the default 2 MiB `--max-body` was **not** raised (a test sends 400 kB of base64 under it).

**Cannot, by construction:**

- **No tools.** No shell, no file reads or writes, no web fetch, no MCP servers, no skills, no
  hooks, no CLAUDE.md. The model runs in an **empty temporary directory** that is deleted after
  each request. (Checked 2026-10-14: asked to list its tools under these flags, the model
  answered `NONE`.)
- **Local only.** Binds `127.0.0.1`. Not reachable from another machine. It also refuses a
  request whose `Host` header is not a loopback name (DNS-rebinding guard).
- **Browser origins on an allowlist.** Defaults: `http://localhost:5178`,
  `http://127.0.0.1:5178` (the Vite dev server), `https://2bee.app`. Any other `Origin` → **403**.
  A request with **no** `Origin` header (curl, a script) is not a browser page and is let
  through. It still needs the token.
- **No streaming** (`stream: true` → 400). **`temperature` is ignored.** The CLI has no such
  flag, so the `temperature: 0` the app sends is **not honoured**: answers can vary between runs.
- **One request at a time.** Up to 8 more wait in a queue; past that → 429.
- **No auth handling.** It never logs in, refreshes, reads, copies or writes Claude's
  credentials. If the CLI is logged out or its token has expired, the request fails with a
  **502** carrying the CLI's own message. Fix the login yourself, outside the bridge.
- **No body or token in the log.** It writes one line per request: time, method, path, origin,
  status, ms.

## Cost

Every request is a real `claude -p` run on **your own Claude login/subscription**, counted
against its usage limits like any other Claude Code session. One small prompt cost about 550 input
tokens (measured 2026-10-14: the CLI adds overhead even with the default system prompt
replaced). A 2bee.cad edit sends the whole SCAD source every time.

## The exact command each request runs

Text-only requests:

```
claude -p --output-format json --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
       --safe-mode --disable-slash-commands --permission-mode dontAsk --no-session-persistence \
       --system-prompt-file <tmp>/system.txt --model <alias>        # conversation on stdin, cwd = <tmp>/cwd (empty)
```

| Flag | Why |
|---|---|
| `-p` | print mode: one turn, print the answer, exit |
| `--output-format json` | one JSON object; the bridge returns its `result`, and maps `is_error` to 502 |
| `--tools ""` | the built-in tool set is empty (`claude --help`: *Use "" to disable all tools*) |
| `--strict-mcp-config` + `--mcp-config '{"mcpServers":{}}'` | ignore every MCP config on the machine and load none |
| `--safe-mode` | no CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents or commands. The fleet's config does not leak into the prompt and no hook runs. Auth is unaffected |
| `--disable-slash-commands` | a prompt starting with `/` is text, not a skill |
| `--permission-mode dontAsk` | extra safety: anything that would need a permission is denied, never prompted |
| `--no-session-persistence` | the conversation is not saved to disk |
| `--system-prompt-file` | **replaces** Claude Code's default agent prompt with the app's instruction. A file, not argv, because Linux caps one argv string at 128 KiB |
| `--model` | from the id the app chose |

Requests with an image use the same flags, with `--output-format json` replaced by
`--input-format stream-json --output-format stream-json --verbose`. The CLI accepts an image only
as a content block in stream-json input, refuses stream-json input without stream-json output,
and refuses stream-json output under `-p` without `--verbose` (all three measured against
`claude` 2.1.299, 2026-10-15). stdin is then one JSON line,
`{"type":"user","message":{"role":"user","content":[{"type":"text",…},{"type":"image","source":{"type":"base64",…}}]}}`.
The bridge returns only the `result` event's text.

🔴 **In stream-json mode the bridge also checks the child's `init` event.** If it lists any
`tools` or `mcp_servers`, the answer is thrown away and the client gets **502**. The flags are
meant to give the child none, and this event is where the bridge can see whether they did.
⚠ The same event lists the operator's installed **plugins** even under `--safe-mode`
(measured 2026-10-15: 9 listed, with `tools`, `mcp_servers`, `skills` and `slash_commands` all
empty). That is not checked, and "no plugins" in the list above is the `claude --help`
description of `--safe-mode`, not something this bridge has measured.

**Never passed:** `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`,
`--add-dir`, `--permission-mode bypassPermissions`. `--bare` is not passed either: it would
ignore your OAuth login. The tests assert all of these flags are absent.

On timeout or client disconnect, the child's whole process group gets SIGTERM, then SIGKILL 2 s
later. The client gets its 504 immediately and does not wait for the kill.

## Tests

```bash
node --test tools/claude-bridge/bridge.test.mjs
```

⚠ Node 22's `node --test tools/claude-bridge/` (a directory) fails with `Cannot find module`.
Name the file.

The tests run the real `bridge.mjs` as a subprocess, with `CLAUDE_BIN` pointing at
`test-fixtures/fake-claude.mjs`. That fake records its argv, cwd and stdin. They cover: 401
(none/wrong token), 403 (bad Origin, bad Host), 200 + shape for the exact `buildRequest` body,
argv flags, empty cwd, `/v1/models`, OPTIONS + PNA, 127.0.0.1-only bind (including a refused
connection on a non-loopback interface), 413, 504 + child dead, 502 on a CLI error, 400s,
token precedence/printing, log hygiene, and no overlap between concurrent requests. Images: an
image part arrives as a stream-json image block with every no-tools flag still present, a
text-only request keeps the json path, the five refusals above are 400s with no child, a
child whose `init` reports a tool is a 502 (negative control: with the check disabled that test
goes red), and a 400 kB photo fits the default cap.

**Through `vite dev`'s `/__claude` proxy (2026-10-15):** the proxy forwards the JSON body as
is, so a photo needs nothing new there; the bridge's 2 MiB cap is the only limit, and the app
refuses above 1.5 MB of data URL before sending. Measured: cnc.tools' assistant, a drawn end
mill photo, `claude-sonnet`, answer in 4.3 s, form filled, nothing registered (a dev server on
5391 with `CLAUDE_BRIDGE_URL` pointing at a separate bridge on 8811 with its own token).
⚠ **A bridge started before this change still refuses images** (`only text content parts are
supported`). Node does not reload: restart it after pulling.

**Live check, 2026-10-15:** a separate bridge instance on port 8811 with its own token (not the
operator's 8787 bridge) and the real CLI was sent a 200×200 PNG of a red square with
`claude-haiku`. It answered `Red.`

**What the tests do not prove:** that the real CLI keeps honouring these flags after an
upgrade. The fake can confirm we *pass* `--tools ""`; it cannot confirm `claude` still treats it
as "no tools". Re-run the `NONE` check after a CLI upgrade:

```bash
cd "$(mktemp -d)" && echo "List the exact names of every tool you can call, or say NONE." | \
  claude -p --output-format json --model haiku --tools "" --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' --safe-mode --permission-mode dontAsk --system-prompt "Answer literally."
```
