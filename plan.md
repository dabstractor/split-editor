# pi-split-editor implementation plan

## Goal

Create a pi package named `pi-split-editor` that replaces pi's blocking Ctrl+G
external-editor workflow with a tmux split editor workflow.

When the user presses Ctrl+G in pi's prompt editor:

1. The current prompt text is written to a temporary markdown file.
2. `nvim` opens in a tmux split using that temp file.
3. Pi's TUI stays active, readable, scrollable, and resize-aware in its original
   pane.
4. The pi prompt editor is locked while the split editor is open.
5. When `nvim` exits, the temp file contents replace the pi prompt editor
   contents.
6. The tmux split closes automatically.

This package should be implemented as a pi extension/package, not as a fork of
pi core.

## Relevant pi APIs/docs

Read these before implementation:

- `/home/red/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `/home/red/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- `/home/red/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md`
- `/home/red/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`

Key APIs/features to use:

- `ctx.ui.setEditorComponent(...)`
- `CustomEditor` from `@earendil-works/pi-coding-agent`
- app keybinding action `app.editor.external` (`ctrl+g` by default)
- `ctx.ui.setStatus(...)` for a footer/status indicator
- pi package manifest via `package.json` `pi.extensions`

## Package structure

Create a pi package under `picosystem/pi-split-editor/`.

Suggested structure:

```text
picosystem/pi-split-editor/
├── package.json
├── README.md
├── plan.md
└── src/
    └── index.ts
```

`package.json` should define a pi package, for example:

```json
{
  "name": "pi-split-editor",
  "version": "0.1.0",
  "description": "Open pi prompt editing in a live tmux split editor without freezing the pi UI.",
  "type": "module",
  "keywords": ["pi-package", "pi", "tmux", "nvim", "editor"],
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "latest",
    "@earendil-works/pi-tui": "latest"
  }
}
```

Adjust dependency strategy if local package resolution does not require these as
direct dependencies.

## Core implementation design

Implement `src/index.ts` exporting a default extension function:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new SplitEditor(tui, theme, keybindings, ctx),
    );
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setEditorComponent(undefined);
    ctx.ui.setStatus("pi-split-editor", undefined);
  });
}
```

The actual constructor signature may need refinement; avoid holding stale
session-bound context if pi docs warn against it. It is acceptable to pass only
the pieces needed for UI notification/status.

## Custom editor behavior

Create a class that extends `CustomEditor`:

```ts
class SplitEditor extends CustomEditor {
  private editing = false;

  constructor(tui, theme, keybindings, ...) {
    super(tui, theme, keybindings);
    this.onAction("app.editor.external", () => {
      void this.openSplitEditor();
    });
  }

  handleInput(data: string): void {
    if (this.editing) {
      // Editor is locked while nvim owns the prompt.
      // Allow global/navigation app shortcuts only if safe, otherwise ignore.
      return;
    }
    super.handleInput(data);
  }
}
```

Locking requirement:

- While `editing === true`, text input into pi's prompt editor must be ignored.
- The user should not be able to mutate the pi prompt while nvim is open.
- Pi should still be visible and resize-aware.
- If possible, do not block app-level commands needed for scrolling/navigation.
  However, prioritize safety: no prompt mutation while split editor is open.

## Tmux split workflow

When Ctrl+G is pressed:

1. If not inside tmux (`!process.env.TMUX`), notify the user and do nothing, or
   fall back to normal behavior only if it does not freeze pi.
2. If an editor is already open, notify/status and do nothing.
3. Get current editor text:
   - Prefer `this.getExpandedText?.() ?? this.getText()` if available.
4. Write it to a temp file:
   - Use `os.tmpdir()`.
   - Filename should include `pi-split-editor`, `process.pid`, and a
     timestamp/random suffix.
   - Extension `.md` is preferred.
5. Open tmux split asynchronously with `spawn`, not `spawnSync`.
6. Wait asynchronously for editor completion using `tmux wait-for`.
7. On completion, read the temp file and call `this.setText(newText)`.
8. Request a TUI render.
9. Clear locked status and delete the temp file.

Important: never call `tui.stop()` and never use `spawnSync` for the editor
path.

## Tmux command pattern

Use `tmux split-window` with `tmux wait-for` for reliable async completion.

Conceptual command:

```bash
tmux split-window -h -l 50% 'nvim /tmp/file.md; tmux wait-for -S TOKEN'
tmux wait-for TOKEN
```

In TypeScript:

- Spawn `tmux split-window ...` asynchronously.
- Separately `await` a child process running `tmux wait-for TOKEN`.
- Quote temp file path and token safely for shell use inside the tmux command.

Suggested defaults:

- split direction: horizontal/right side (`split-window -h`)
- split size: `50%`
- editor command: `nvim`

## Configuration

Start simple, but design for future options.

Initial hardcoded defaults are acceptable:

```ts
const DEFAULT_EDITOR = process.env.PI_SPLIT_EDITOR_EDITOR ?? "nvim";
const DEFAULT_SPLIT_SIZE = process.env.PI_SPLIT_EDITOR_SIZE ?? "50%";
const DEFAULT_SPLIT_DIRECTION = process.env.PI_SPLIT_EDITOR_DIRECTION ?? "h";
```

Potential env vars:

- `PI_SPLIT_EDITOR_EDITOR` default `nvim`
- `PI_SPLIT_EDITOR_SIZE` default `50%`
- `PI_SPLIT_EDITOR_DIRECTION` values:
  - `h` / `horizontal` = side-by-side split
  - `v` / `vertical` = top/bottom split

Do not overbuild config in the first version.

## Status/notifications

While nvim is open, show a footer status such as:

```text
split editor: open
```

Use:

```ts
ctx.ui.setStatus("pi-split-editor", "split editor: open");
```

Clear it after nvim exits or if opening fails.

Also notify/warn on:

- not running inside tmux
- tmux command failed
- editor already open
- temp file read/write failure

## Rendering locked state

Optional but desirable: when locked, modify the editor rendering to show that it
is locked.

Example ideas:

- append `SPLIT EDITOR OPEN` to the bottom border
- make the prompt border dim/muted
- display a one-line hint in the editor area

Keep this simple and avoid fragile ANSI layout changes. If unsure, rely on
`ctx.ui.setStatus(...)` only.

## Error handling

Handle these cases:

- No `TMUX` env var.
- `tmux` executable missing.
- `nvim` command exits non-zero.
- `tmux split-window` fails.
- `tmux wait-for` fails.
- Temp file disappears.
- User closes tmux pane unexpectedly.

Desired behavior:

- Never crash pi.
- Always unlock editor in `finally`.
- Always clear status in `finally`.
- Best-effort temp file cleanup.
- If editor exits non-zero, still consider reading the file if it exists, unless
  this creates surprising behavior. Document the chosen behavior.

## Acceptance criteria

- Installing/loading the package causes Ctrl+G to open `nvim` in a tmux split
  instead of replacing the whole pi UI.
- Pi remains visible in the original pane while nvim is open.
- Pi redraws correctly when tmux panes or the terminal are resized.
- Pi prompt editor ignores typing while nvim is open.
- Exiting nvim updates the pi prompt editor with the file contents.
- The temp file is removed after use.
- Pressing Ctrl+G repeatedly while nvim is open does not open multiple editors.
- Outside tmux, Ctrl+G shows a useful warning and does not freeze the UI.

## Manual test plan

1. From inside tmux, start pi with the extension loaded.
2. Type a multi-line prompt.
3. Press Ctrl+G.
4. Confirm nvim opens in a tmux split.
5. Resize the terminal and/or tmux panes.
6. Confirm pi remains readable and redraws in its pane.
7. Try typing in pi while nvim is open; confirm prompt does not change.
8. Edit text in nvim and quit with `:wq`.
9. Confirm pi prompt updates to the edited text.
10. Press Ctrl+G again and quit nvim without changes; confirm no errors.
11. Start pi outside tmux and press Ctrl+G; confirm warning and no freeze.

## README content

Create a concise README documenting:

- What the package does.
- Requirements: tmux and nvim.
- Installation/loading options:
  - as a local pi package
  - via `pi -e ./src/index.ts` for development
  - via package install if later published
- Environment variables for editor/split size/direction.
- Known limitations:
  - requires tmux for live split behavior
  - pi prompt editor is locked while split editor is open
  - focused keyboard input goes to the active tmux pane

## Notes

This package intentionally avoids pi's built-in Ctrl+G implementation because
core currently stops the TUI and blocks with `spawnSync`. The extension must
keep the event loop free and keep pi's TUI running for active resize/redraw
behavior.
