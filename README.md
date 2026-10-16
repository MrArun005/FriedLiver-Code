# FriedLiver on VS Code (Code - OSS)

This folder turns upstream [Code - OSS](https://github.com/microsoft/vscode) (MIT)
into FriedLiver, VSCodium-style. The upstream source is fetched at build time
and is never committed here.

| Path | What it is |
| --- | --- |
| `upstream.json` | Pinned upstream tag and commit (and the Node version upstream wants) |
| `product.json` | Branding and service overrides, deep-merged into upstream `product.json`. `null` deletes a key |
| `patches/*.patch` | Source patches, applied with `git apply` in file-name order |
| `extensions/<name>/` | FriedLiver built-in extensions, copied into upstream `extensions/` (a `build` script runs first) |
| `scripts/` | `fetch.mjs`, `prepare.mjs`, `build.mjs`, `dev.mjs` (plain Node, any OS) |

```bash
node code/scripts/fetch.mjs              # clone/update upstream at the pinned tag
node code/scripts/prepare.mjs            # patches + product.json + icon + built-in extensions
node code/scripts/build.mjs              # npm ci + compile (dev build)
node code/scripts/dev.mjs [folder]       # run from source
node code/scripts/build.mjs --package    # minified app in <VSCODE_DIR>/../VSCode-<os>-<arch>
```

The upstream checkout lives in `code/vscode` unless `VSCODE_DIR` says otherwise.
`FRIEDLIVER_EXTENSIONS_DIR` points `prepare.mjs` at another folder of built-in
extensions. `code/scripts/screenshot.mjs` launches the build under Playwright
and saves a screenshot.

Current patches:

- `0010-drop-builtin-copilot.patch`: no built-in Copilot extension, and runs without `defaultChatAgent`
- `0020-disable-builtin-ai-by-default.patch`: `chat.disableAIFeatures` defaults to true, and the Chat view hides with it

The full guide (prerequisites, time, disk, memory, extensions) is
[docs/fork/BUILD.md](../docs/fork/BUILD.md).

## Writing a patch

```bash
node code/scripts/prepare.mjs                 # start from a prepared tree
# edit files in code/vscode
git -C code/vscode diff -- src > code/patches/0200-my-change.patch
node code/scripts/prepare.mjs                 # check it applies on a clean tree
```

Exclude `product.json`, `resources/linux/code.png` and the removed `extensions/copilot`
from patch diffs; `prepare.mjs` handles those itself.
