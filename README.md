# split-editor

`split-editor` replaces pi's blocking Ctrl+G external-editor flow with a live
tmux split editor.

When you press Ctrl+G in pi's prompt editor, the current prompt is written to a
temporary Markdown file, opened with the configured editor (`nvim` by default)
in a tmux split, and read back into the prompt when the editor exits. Pi stays
visible in the original tmux pane, and the prompt is locked while the split
editor is open.

## Requirements

- `tmux`
- `nvim` by default, or another terminal editor configured via
  settings/config/env
- Run pi inside tmux for split behavior

Outside tmux, Ctrl+G shows a warning and does not fall back to pi's blocking
external editor.

## Installation / loading

Local package:

```bash
pi install /path/to/picosystem/split-editor
```

Development run:

```bash
pi -e .
```

If published later:

```bash
pi install npm:split-editor
```

## Configuration

Options:

- `editor` - editor command, default: `nvim`
- `size` - tmux split size, default: `50%`
- `direction` - `h`/`horizontal` for side-by-side, `v`/`vertical` for
  top/bottom; default: `h`
- `showIndicator` - show `SPLIT EDITOR OPEN` in the editor border while locked;
  default: `true`

Precedence, lowest to highest:

1. Defaults
2. Global config: `~/.pi/agent/extensions/split-editor.json`
3. Global pi settings: `~/.pi/agent/settings.json` under `splitEditor`
4. Project config: `.pi/split-editor.json`
5. Project pi settings: `.pi/settings.json` under `splitEditor`
6. Environment variables

Standalone config files use the options directly:

```json
{
  "editor": "nvim",
  "size": "50%",
  "direction": "horizontal",
  "showIndicator": true
}
```

Pi `settings.json` uses a `splitEditor` object:

```json
{
  "splitEditor": {
    "editor": "nvim",
    "size": "50%",
    "direction": "vertical",
    "showIndicator": true
  }
}
```

Environment variables:

```bash
SPLIT_EDITOR_EDITOR="nvim" \
SPLIT_EDITOR_SIZE=50% \
SPLIT_EDITOR_DIRECTION=h \
SPLIT_EDITOR_SHOW_INDICATOR=false \
pi
```

`SPLIT_EDITOR_SHOW_INDICATOR` accepts `1`, `true`, `yes`, `on`, `0`, `false`,
`no`, or `off`.

Configuration is read each time Ctrl+G opens the split editor, so file/env
changes are picked up without reloading the extension.

## Notes and limitations

- Requires tmux for live split behavior.
- The pi prompt editor ignores input while the split editor is open.
- Keyboard input goes to whichever tmux pane is focused.
- If the editor exits non-zero, the temp file is still read back into pi and a
  warning is shown.
- Temporary files are removed on a best-effort basis after the editor closes.
