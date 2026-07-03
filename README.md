# split-editor

Edit pi prompts in a live tmux split without blocking pi's TUI.

`split-editor` replaces pi's blocking Ctrl+G external-editor workflow. Press
Ctrl+G in pi's prompt editor to open the current prompt in your editor (`nvim`
by default) in a tmux split. When the editor exits, the edited text is read back
into pi's prompt.

Pi stays visible and resize-aware in the original pane while the split is open.
The prompt is locked during editing so it cannot be mutated in two places at
once.

## Demo

https://github.com/user-attachments/assets/47a81b03-8292-45b9-8c85-508719c5f585

## Requirements

- pi
- tmux
- `nvim` by default; set the `editor` option to use a different terminal editor
  (see [Configuration](#configuration))

## Installation

From npm:

```bash
pi install npm:split-editor
```

From a local checkout:

```bash
pi install /path/to/split-editor
```

For development:

```bash
pi -e .
```

## Usage

1. Start pi inside tmux with this package loaded.
2. Type a prompt.
3. Press Ctrl+G.
4. Edit in the tmux split.
5. Save and quit the editor.
6. The edited text replaces the pi prompt.

Pressing Ctrl+G again while the split editor is already open will not open a
second editor.

## Configuration

Configuration is read each time Ctrl+G opens the split editor, so file/env
changes are picked up without reloading the extension.

Options:

| Option          | Env var                       | Default | Description                                                       |
| --------------- | ----------------------------- | ------- | ----------------------------------------------------------------- |
| `editor`        | `SPLIT_EDITOR_EDITOR`         | `nvim`  | Editor command to run in the tmux pane.                           |
| `size`          | `SPLIT_EDITOR_SIZE`           | `50%`   | tmux split size passed to `tmux split-window -l`.                 |
| `direction`     | `SPLIT_EDITOR_DIRECTION`      | `h`     | `h`/`horizontal` side-by-side, `v`/`vertical` top/bottom, `auto` picks by pane size. |
| `minWidth`      | `SPLIT_EDITOR_MIN_WIDTH`      | `80`    | In `auto`, minimum columns each side-by-side pane must keep.         |
| `minHeight`     | `SPLIT_EDITOR_MIN_HEIGHT`     | `10`    | In `auto`, minimum rows each stacked pane must keep.                 |
| `aspectRatio`   | `SPLIT_EDITOR_ASPECT_RATIO`   | `4`     | In `auto`, tie-breaker ratio (columns ÷ rows) when both floors fail. |
| `showIndicator` | `SPLIT_EDITOR_SHOW_INDICATOR` | `true`  | Show `SPLIT EDITOR OPEN` in the editor border while locked.       |

With `direction` set to `auto`, split-editor picks side-by-side or stacked
from the pane size: it goes side-by-side when the pane is wide enough that
each half keeps at least `minWidth` columns, stacks when it's narrow but tall
enough that each half keeps `minHeight` rows, and otherwise falls back to the
`aspectRatio` (columns ÷ rows). If the pane size can't be read, it defaults to
side-by-side.

`aspectRatio` is in terminal cells (columns ÷ rows), not visual ratio — cells
are roughly twice as tall as wide, so `4` reads as about a 2:1 visual ratio.

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
  "direction": "auto",
  "minWidth": 80,
  "minHeight": 10,
  "aspectRatio": 4,
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
    "minWidth": 100,
    "minHeight": 12,
    "aspectRatio": 4,
    "showIndicator": false
  }
}
```

Environment example:

```bash
SPLIT_EDITOR_EDITOR="nvim" \
SPLIT_EDITOR_SIZE=50% \
SPLIT_EDITOR_DIRECTION=auto \
SPLIT_EDITOR_MIN_WIDTH=80 \
SPLIT_EDITOR_MIN_HEIGHT=10 \
SPLIT_EDITOR_ASPECT_RATIO=4 \
SPLIT_EDITOR_SHOW_INDICATOR=false \
pi
```

`SPLIT_EDITOR_SHOW_INDICATOR` accepts `1`, `true`, `yes`, `on`, `0`, `false`,
`no`, or `off`.

## Notes and limitations

- Requires tmux for live split behavior; falls back to pi's default external
  editor outside tmux.
- The pi prompt editor ignores input while the split editor is open.
- If the editor exits non-zero, the temp file is still read back into pi and a
  warning is shown.
- Temporary files are removed on a best-effort basis after the editor closes.
