/**
 * Pure editor-command resolution for split-editor, kept free of any
 * `@earendil-works/*` imports (and of `process`/fs) so it can be unit-tested
 * with plain node — mirroring ./tmux.ts and ./collapsed-prompt.ts. index.ts
 * wires it into the pi extension by passing `process.env`/`process.platform`
 * and the raw settings.json objects in.
 *
 * When split-editor's own `editor` is configured anywhere (the splitEditor
 * block of settings.json, .pi/split-editor.json, or $SPLIT_EDITOR_EDITOR), that
 * wins. Otherwise we fall back to EXACTLY what pi's native Ctrl+G resolves —
 * `settings-manager.getExternalEditorCommand()`: the `externalEditor` setting
 * (project over global) → $VISUAL → $EDITOR → platform default — so the split
 * opens the same editor pi would have launched directly.
 */

export type EditorResolutionInput = {
	/** First split-editor-specific `editor` found across the config layers
	 *  (already highest-precedence-first by the caller), or undefined/empty if
	 *  none was configured. */
	explicitEditor: string | undefined;
	/** Raw pi settings.json from `<cwd>/.pi/settings.json` (higher precedence). */
	projectSettings: unknown;
	/** Raw pi settings.json from the agent dir (lower precedence). */
	globalSettings: unknown;
	/** Environment map; the caller passes `process.env`. */
	env: Record<string, string | undefined>;
	/** `process.platform` (passed in to keep this pure). */
	platform: string;
};

/**
 * Read pi's `externalEditor` setting from a raw settings.json object. Returns
 * the trimmed value only when it is a non-empty string, mirroring pi's own
 * `typeof === "string" && trim() !== ""` guard.
 */
export function readExternalEditor(raw: unknown): string | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const value = (raw as { externalEditor?: unknown }).externalEditor;
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Resolve the editor command split-editor should launch. Precedence matches the
 * split-editor config layers first, then pi's native external-editor chain:
 *
 *   1. explicitEditor — split-editor's own `editor` (any layer)
 *   2. externalEditor setting — project settings.json, then global
 *   3. $VISUAL
 *   4. $EDITOR
 *   5. platform default — notepad on win32, nano elsewhere
 */
export function resolveEditor(input: EditorResolutionInput): string {
	if (input.explicitEditor) return input.explicitEditor;

	const fromSettings = readExternalEditor(input.projectSettings) ?? readExternalEditor(input.globalSettings);
	if (fromSettings) return fromSettings;

	if (input.env.VISUAL) return input.env.VISUAL;
	if (input.env.EDITOR) return input.env.EDITOR;

	return input.platform === "win32" ? "notepad" : "nano";
}