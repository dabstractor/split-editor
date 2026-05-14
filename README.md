# pi-split-editor

`pi-split-editor` replaces pi's blocking Ctrl+G external-editor flow with a live tmux split editor.

When you press Ctrl+G in pi's prompt editor, the current prompt is written to a temporary Markdown file, opened with `nvim` in a tmux split, and read back into the prompt when the editor exits. Pi stays visible in the original tmux pane, and the prompt is locked while the split editor is open.

## Requirements

- `tmux`
- `nvim` by default, or another terminal editor configured with `PI_SPLIT_EDITOR_EDITOR`
- Run pi inside tmux for split behavior

Outside tmux, Ctrl+G shows a warning and does not fall back to pi's blocking external editor.

## Installation / loading

Local package:

```bash
pi install /path/to/picosystem/pi-split-editor
```

Development run:

```bash
pi -e ./src/index.ts
```

If published later:

```bash
pi install npm:pi-split-editor
```

## Configuration

Environment variables:

- `PI_SPLIT_EDITOR_EDITOR` - editor command, default: `nvim`
- `PI_SPLIT_EDITOR_SIZE` - tmux split size, default: `50%`
- `PI_SPLIT_EDITOR_DIRECTION` - `h`/`horizontal` for side-by-side, `v`/`vertical` for top/bottom; default: `h`

Example:

```bash
PI_SPLIT_EDITOR_EDITOR="nvim --clean" PI_SPLIT_EDITOR_SIZE=40% pi -e ./src/index.ts
```

## Notes and limitations

- Requires tmux for live split behavior.
- The pi prompt editor ignores input while the split editor is open.
- Keyboard input goes to whichever tmux pane is focused.
- If the editor exits non-zero, the temp file is still read back into pi and a warning is shown.
- Temporary files are removed on a best-effort basis after the editor closes.
