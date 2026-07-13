/**
 * Pure rendering logic for the collapsed prompt shown while a split editor is
 * open and `hideWhileEditing` is on.
 *
 * Intentionally free of any `@earendil-works/*` imports — this mirrors ./tmux.ts
 * so it can be unit-tested with plain node (`node --test`) without jiti or a pi
 * install on the module-resolution path. `index.ts` imports and uses it.
 */

/** Label shown in the prompt area while a split editor session is open. */
export const SPLIT_EDITOR_OPEN_LABEL = " SPLIT EDITOR OPEN ";

/**
 * Clip `text` to `width` terminal cells without adding an ellipsis.
 *
 * The default label (SPLIT_EDITOR_OPEN_LABEL) is pure ASCII, so its cell count
 * equals its character count and a plain slice is correct. This matches pi-tui's
 * `truncateToWidth(text, width, "")` for ASCII input, minus the trailing
 * `\x1b[0m` reset that helper appends on truncation — that reset would nest
 * poorly once `borderColor` re-wraps the result, so it is omitted here on
 * purpose. Widths <= 0 yield "".
 */
function clipToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	return text.length <= width ? text : text.slice(0, width);
}

/**
 * Render the prompt area while a split editor is open and `hideWhileEditing`
 * is on. Returns a single indicator line when `showIndicator` is true, or an
 * empty array (fully hidden) when false. The line is colored with the editor's
 * themed `borderColor` when available and is always clipped to `width`.
 *
 * Pure (no pi imports) so it can be unit-tested like ./tmux.
 */
export function renderCollapsedPrompt(
	width: number,
	options: { showIndicator: boolean; borderColor?: (str: string) => string; label?: string },
): string[] {
	if (!options.showIndicator) return [];
	const label = options.label ?? SPLIT_EDITOR_OPEN_LABEL;
	const clipped = clipToWidth(label, Math.max(0, width));
	return [(options.borderColor ?? ((s: string) => s))(clipped)];
}
