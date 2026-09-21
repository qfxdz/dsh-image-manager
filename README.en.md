# Multimodal Image Manager · dsh-image-manager

[![CI](https://github.com/OWNER/dsh-image-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/dsh-image-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

Multimodal image manager (per-session image caps and image picking) for [DeepSeek Harness](https://github.com/) (dsh) Web UI.
[中文说明 →](./README.md)

## The problem

Images in a dsh session only accumulate: every turn re-sends all historical images in the request
body, so sooner or later you hit the gateway / vLLM hard limit:

```
400 {"message":"At most 8 image(s) may be provided in one prompt. (parameter=image)"}
```

The built-in `compaction-image-offload` can only *drop the oldest* — neither the user nor the model
gets a say. This plugin makes the policy controllable, and separates **global default** from
**per-session override**:

1. **Global default** (Settings → "Image Manager", or the sidebar "Images" page): how many images
   every session may send per request. Stored in `$DSH_HOME/image-manager.json`.
2. **Per-session override**: a session may set its own cap. *If a session has a value, that value
   wins; if not ("inherit"), the global default applies.* Changing the global default instantly
   affects every inheriting session; overridden sessions stay put until you click
   "follow global again".
3. **The model can choose what to send**: call `images_list` to see what is available, then
   `images_select` to pin a send-list, optionally labelling each image. Unselected images degrade
   to text placeholders in the request.
4. **Three entry points**: the **"Images N/M"** button next to the session title; **Settings →
   "Image Manager"** for the global default; the **sidebar "Images"** page for a global view across
   loaded sessions.

The key property: **selection is reversible.** Images pushed out of the request stay in the
session (shown as placeholders) and can be restored or permanently excluded at any time.

## Install

```bash
# 1) register this directory as a bundle in the web profile (idempotent)
git clone https://github.com/OWNER/dsh-image-manager.git
/path/to/dsh/node_modules/.bin/dsh plugin --profile web add "$PWD/dsh-image-manager"

# 2) restart dsh — a newly added bundle is NOT hot-loaded
/path/to/dsh/stop.sh && /path/to/dsh/start.sh
```

Or just run `./install.sh` in this directory: it installs, restarts and then self-checks the HTTP
API (log at `/tmp/dsh-image-manager-install.log`). Set `DSH_DIR=/path/to/dsh` if dsh is not in
`$HOME/dsh`.

Uninstall: `dsh plugin --profile web remove dsh-image-manager`, then restart. Disabling the
built-in `image-offload` (done in `cordis.patch.yml`) disappears with the bundle, so the built-in
"drop oldest" behaviour comes back automatically.

## Usage

### Model tools

| Tool | Purpose |
|---|---|
| `images_list` | List every image in the session: id, sent or not, filename, size, label |
| `images_select` | Pick which ids to send (optional `labels`); pass `[]` to fall back to "newest N" |
| `images_limit` | Set this session's cap (`maxImages`), or `inherit: true` to clear the override |
| `images_exclude` / `images_include` | Permanently exclude / restore an image |

Because the send-list is a persisted event in the session, later turns keep using the same list.

### UI

- **"Images N/M" button** next to the session title: N = images in this session, M = effective cap.
  Grey dot = inheriting the global default; blue dot = this session overrides it.
- **Settings → "Image Manager"**: global default, config file path, per-session inherit/override
  status, and a button opening the global view.
- **Sidebar "Images"**: global default + session picker + image grid.
- Inside the manager: preview, `send`/`don't send`, `exclude`/`restore`, back to "newest N",
  and `follow global` / `custom` + `save` / `follow global again`.

### HTTP API (what the UI uses)

| Method | Path | Notes |
|---|---|---|
| GET | `/dsh-image-manager/api/settings` | Global cap + config file path |
| POST | `/dsh-image-manager/api/settings` | `{maxImages}` → change the global default; same-origin only |
| GET | `/dsh-image-manager/api/sessions` | Sessions in this process (count, override, effective cap) + settings |
| GET | `/dsh-image-manager/api/state?sessionId=` | Effective cap, inherit flag, send-list, image list |
| POST | `/dsh-image-manager/api/policy` | `{sessionId, maxImages? \| inherit?, pinned?, dropped?, labels?}`; same-origin only |
| GET | `/dsh-image-manager/api/image?sessionId=&id=` | Raw image bytes (thumbnail / preview) |

## Implementation notes

- **Persistence reuses the `image/offload` event type.** dsh's session log has a whitelist
  (`KNOWN_SESSION_EVENT_TYPES`) and downstream plugins **cannot** add persistable event types.
  `image/offload` is the only registered, persistable type that can also affect model requests, so
  this plugin takes it over and reads `data` as a *full policy snapshot*
  (`{v:2, inherit, maxImages, pinned, dropped, labels}`) instead of the built-in append-only
  `{targets}`. The same snapshot can be re-projected any number of times, which is what makes the
  policy reversible. Historical `{targets}` events written by the built-in plugin remain readable.
- **Why the global/session distinction lives in the event**: projections must be pure functions of
  the session log (replays must be deterministic), so they cannot read "the current global setting".
  Each policy event therefore stores the effective value at write time plus an `inherit` flag; when
  the global default changes, the plugin appends a new event to every still-inheriting session.
- **Why the built-in `@deepseek-ai/dsh-compaction-image-offload` is disabled**:
  `registerMessageProjection` allows one registration per event type. The patch disables the
  built-in line and this plugin re-implements its duties (projection, `IMAGE_OFFLOAD_REQUIRED`
  recovery, `compaction/summary-error` recovery).
- **Zero dependencies**: the host half only uses `ctx` (`sessions` / `tools` / `webServer` /
  `attachments`) and imports nothing from `@deepseek-ai/*`; the browser half is a hand-written
  `window.__ModuleLoader__.load({id, factory})` that only `require('react')`. No build step, no
  profile dependencies.

## Known limitations

- **Exclude is a logical delete.** dsh attachments are content-addressed, immutable and have no
  delete API, so disk objects stay — which is exactly what makes "restore" possible.
- **The cap is not a server-side limit.** The gateway's own `--limit-mm-per-prompt` still applies;
  if it is lower than the plugin's default of 8, a request may still be rejected (the plugin then
  retries when it receives `IMAGE_OFFLOAD_REQUIRED`, up to 3 times).
- The HTTP prefix is not covered by dsh's root-path token protection; write endpoints only accept
  same-origin POSTs, so cross-site calls are not possible.
- The UI can only act on sessions loaded in the current dsh process.
- The global default lives in a file rather than a native dsh settings namespace (kept zero-dep on
  purpose); it is re-read by mtime, so hand edits apply too.
- Once a session has overridden its cap it still counts as "custom" even if the value equals the
  global default; use "follow global again" to go back.

## Files

```
dsh-image-manager/
├── package.json            # dsh bundle manifest (dsh.bundle.patch + dsh.client)
├── cordis.patch.yml        # disable built-in image-offload, insert this plugin
├── lib/index.js            # host: global default, session policy, projection, tools, HTTP API
├── lib/client.js           # browser: session button + settings section + manager UI
├── test/logic.test.mjs     # host logic unit tests
├── test/client.test.mjs    # browser-half smoke test
├── install.sh              # install + restart + self-check
├── CONTRIBUTING.md         # dev setup & PR checklist
├── SECURITY.md             # security policy
├── CHANGELOG.md
└── LICENSE
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Please keep the plugin dependency-free and run
`npm test` before opening a PR.

## License

[MIT](./LICENSE)
