import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionUIContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EditorComponent, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

import { formatError, openTmuxSplitAndWait, runProcess } from "./tmux";
import { renderCollapsedPrompt, SPLIT_EDITOR_OPEN_LABEL } from "./collapsed-prompt";

// Re-exported so the pure helper is part of this module's public surface (and
// remains unit-testable on its own via ./collapsed-prompt.ts).
export { renderCollapsedPrompt };

const DEFAULT_CONFIG: SplitEditorConfig = {
	editor: "nvim",
	size: "50%",
	direction: "h",
	minWidth: 80,
	minHeight: 10,
	aspectRatio: 4,
	showIndicator: true,
	hideWhileEditing: false,
};

type SessionState = {
	active: boolean;
};

/**
 * Factory shape for pi editor components, matching pi's `EditorFactory`. Not
 * re-exported by the pi package, so defined locally for type safety.
 */
type EditorComponentFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

type SplitEditorConfig = {
	editor: string;
	size: string;
	direction: string;
	minWidth: number;
	minHeight: number;
	aspectRatio: number;
	showIndicator: boolean;
	hideWhileEditing: boolean;
};

type RawConfig = Partial<SplitEditorConfig> & {
	splitEditor?: Partial<SplitEditorConfig>;
};

/**
 * Wraps another editor component (e.g. pi-vim's modal editor) so split-editor
 * can intercept Ctrl+G, lock the prompt while editing, and render its
 * "SPLIT EDITOR OPEN" indicator WITHOUT replacing the inner editor.
 *
 * pi exposes only a single custom editor component slot. An extension that
 * calls `ctx.ui.setEditorComponent(...)` therefore clobbers whatever another
 * extension (such as pi-vim) already registered, dropping its behavior —
 * including pi-vim's mode-aware cursor shape (skinny in INSERT, fat in NORMAL),
 * leaving pi's default block cursor. To stay transparent we instead wrap the
 * previously-registered editor (see createSplitEditor) and forward every
 * property to it, overriding only handleInput/render/invalidate.
 */
class SplitEditorWrapper {
	private editing = false;
	private opening = false;
	private showIndicator = DEFAULT_CONFIG.showIndicator;
	private hideWhileEditing = DEFAULT_CONFIG.hideWhileEditing;

	constructor(
		private readonly inner: EditorComponent,
		private readonly tui: TUI,
		private readonly keybindings: KeybindingsManager,
		private readonly ui: ExtensionUIContext,
		private readonly cwd: string,
		private readonly sessionState: SessionState,
	) {}

	handleInput(data: string): void {
		// Intercept Ctrl+G before the inner editor so pi's built-in blocking
		// external-editor action never runs.
		if (this.keybindings.matches(data, "app.editor.external")) {
			if (this.editing || this.opening) {
				this.ui.notify("split editor is already open", "warning");
				return;
			}

			if (!process.env.TMUX) {
				this.ui.notify("tmux not detected; using pi's external editor; start tmux for split editing or disable split-editor to stop this warning.", "warning");
				// Hand Ctrl+G back to the inner editor so pi's built-in external
				// editor (registered on CustomEditor as an app action) runs as the
				// fallback.
				this.inner.handleInput?.(data);
				return;
			}

			void this.openSplitEditor();
			return;
		}

		if (this.editing || this.opening) {
			// Lock the prompt while the tmux pane owns the editable copy.
			return;
		}

		this.inner.handleInput?.(data);
	}

	render(width: number): string[] {
		// While a split editor is open and hiding is enabled, collapse the prompt
		// to a single indicator line (or hide it entirely when showIndicator is
		// false) instead of rendering the full inner editor.
		if (this.editing && this.hideWhileEditing) {
			return renderCollapsedPrompt(width, {
				showIndicator: this.showIndicator,
				borderColor: this.inner.borderColor,
			});
		}

		const lines = this.inner.render(width);
		if (!this.editing || !this.showIndicator || lines.length === 0) return lines;

		const label = SPLIT_EDITOR_OPEN_LABEL;
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, Math.max(0, width - label.length), "") + label;
		}
		return lines;
	}

	invalidate(): void {
		this.inner.invalidate?.();
	}

	private getExpandedText(): string {
		return this.inner.getExpandedText?.() ?? this.inner.getText();
	}

	private async openSplitEditor(): Promise<void> {
		if (!process.env.TMUX) {
			this.ui.notify("split-editor requires tmux; Ctrl+G was ignored", "warning");
			return;
		}

		if (this.editing || this.opening) {
			this.ui.notify("split editor is already open", "warning");
			return;
		}

		this.opening = true;
		const suffix = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
		const tempFile = join(tmpdir(), `split-editor-${suffix}.md`);
		const statusFile = join(tmpdir(), `split-editor-${suffix}.status`);
		const token = `split-editor-${suffix}`;

		try {
			const config = await loadConfig(this.cwd);
			this.showIndicator = config.showIndicator;
			this.hideWhileEditing = config.hideWhileEditing;
			this.editing = true;
			this.opening = false;
			this.tui.requestRender();
			await writeFile(tempFile, this.getExpandedText(), "utf8");

			// Capture pi's own pane id right before the split so we can re-select
			// it once the editor exits. Done here (in the caller) rather than
			// inside openTmuxSplitAndWait because that function lives in the
			// pi-context-free ./tmux module so it stays unit-testable.
			const originPaneId = await captureOriginPaneId();
			await openTmuxSplitAndWait({
				tempFile,
				statusFile,
				token,
				editorCommand: config.editor,
				splitSize: config.size,
				splitDirection: config.direction,
				splitMinWidth: config.minWidth,
				splitMinHeight: config.minHeight,
				splitAspectRatio: config.aspectRatio,
			});
			// Best-effort: re-focus pi's pane. A no-op if it's already focused,
			// and a hard guarantee otherwise. Must not throw or block the
			// temp-file read-back.
			await reselectOriginPane(originPaneId);

			const status = await readOptional(statusFile);
			if (status === undefined) {
				this.ui.notify("split editor pane closed without reporting editor status; reading temp file anyway", "warning");
			} else {
				const code = Number.parseInt(status.trim(), 10);
				if (Number.isFinite(code) && code !== 0) {
					this.ui.notify(`split editor exited with status ${code}; reading temp file anyway`, "warning");
				}
			}

			const newText = (await readFile(tempFile, "utf8")).replace(/\n$/, "");
			if (this.sessionState.active) {
				this.inner.setText(newText);
				this.tui.requestRender();
			}
		} catch (error) {
			this.ui.notify(`split-editor: ${formatError(error)}`, "error");
		} finally {
			this.editing = false;
			this.opening = false;
			await Promise.allSettled([unlink(tempFile), unlink(statusFile)]);
			this.tui.requestRender();
		}
	}
}

/**
 * Build the editor component split-editor registers: a Proxy that behaves like
 * `inner` (the previously-registered editor, or a fresh CustomEditor when none
 * exists) except for the three members split-editor overrides. This preserves
 * sibling extensions' editor behavior — including pi-vim's cursor shape — while
 * split-editor adds its Ctrl+G split workflow on top.
 */
function createSplitEditor(
	tui: TUI,
	theme: EditorTheme,
	keybindings: KeybindingsManager,
	ui: ExtensionUIContext,
	cwd: string,
	sessionState: SessionState,
	previousFactory: EditorComponentFactory | undefined,
): EditorComponent {
	const inner: EditorComponent = previousFactory
		? previousFactory(tui, theme, keybindings)
		: new CustomEditor(tui, theme, keybindings);
	const wrapper = new SplitEditorWrapper(inner, tui, keybindings, ui, cwd, sessionState);
	const innerRecord = inner as unknown as Record<PropertyKey, unknown>;
	const wrapperRecord = wrapper as unknown as Record<PropertyKey, unknown>;

	return new Proxy(wrapperRecord, {
		get(target, prop) {
			// Never let the wrapper be mistaken for a thenable (e.g. if it is
			// accidentally awaited somewhere).
			if (prop === "then") return undefined;
			// Members split-editor owns.
			if (prop === "handleInput" || prop === "render" || prop === "invalidate") {
				const value = target[prop];
				return typeof value === "function" ? value.bind(wrapper) : value;
			}
			// Forward everything else (getText, setText, focused, onSubmit,
			// onChange, borderColor, actionHandlers, setPaddingX, ...) to the
			// inner editor so its full behavior is preserved.
			const value = innerRecord[prop];
			return typeof value === "function" ? value.bind(inner) : value;
		},
		set(_target, prop, value) {
			innerRecord[prop] = value;
			return true;
		},
		has(_target, prop) {
			return prop in innerRecord;
		},
	}) as unknown as EditorComponent;
}

/**
 * Query the pane id (e.g. `%5`) pi is currently running in. Returns undefined
 * if tmux can't report it, so the split still proceeds without focus-return.
 */
async function captureOriginPaneId(): Promise<string | undefined> {
	try {
		const result = await runProcess("tmux", ["display", "-p", "#{pane_id}"]);
		if (result.code !== 0) return undefined;
		const paneId = result.stdout.trim();
		return paneId || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Re-select pi's origin pane after the editor exits. Best-effort: any failure
 * is swallowed so the status read and setText flow still run.
 */
async function reselectOriginPane(originPaneId: string | undefined): Promise<void> {
	if (!originPaneId) return;
	try {
		await runProcess("tmux", ["select-pane", "-t", originPaneId]);
	} catch {
		// Ignore — focus-return is a best-effort convenience.
	}
}

async function loadConfig(cwd: string): Promise<SplitEditorConfig> {
	const globalConfig = normalizeRawConfig(await readJsonFile(join(getAgentDir(), "extensions", "split-editor.json")));
	const projectConfig = normalizeRawConfig(await readJsonFile(join(cwd, ".pi", "split-editor.json")));
	const globalSettings = normalizeRawConfig(await readJsonFile(join(getAgentDir(), "settings.json")));
	const projectSettings = normalizeRawConfig(await readJsonFile(join(cwd, ".pi", "settings.json")));
	const envConfig = normalizeRawConfig({
		editor: process.env.SPLIT_EDITOR_EDITOR,
		size: process.env.SPLIT_EDITOR_SIZE,
		direction: process.env.SPLIT_EDITOR_DIRECTION,
		minWidth: process.env.SPLIT_EDITOR_MIN_WIDTH,
		minHeight: process.env.SPLIT_EDITOR_MIN_HEIGHT,
		aspectRatio: process.env.SPLIT_EDITOR_ASPECT_RATIO,
		showIndicator: parseEnvBoolean(process.env.SPLIT_EDITOR_SHOW_INDICATOR),
		hideWhileEditing: parseEnvBoolean(process.env.SPLIT_EDITOR_HIDE_WHILE_EDITING),
	});

	return {
		...DEFAULT_CONFIG,
		...globalConfig,
		...globalSettings,
		...projectConfig,
		...projectSettings,
		...envConfig,
	};
}

async function readJsonFile(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function normalizeRawConfig(raw: unknown): Partial<SplitEditorConfig> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as RawConfig;
	const source = record.splitEditor && typeof record.splitEditor === "object" ? record.splitEditor : record;
	const config: Partial<SplitEditorConfig> = {};

	if (typeof source.editor === "string" && source.editor.trim()) config.editor = source.editor.trim();
	if (typeof source.size === "string" && source.size.trim()) config.size = source.size.trim();
	if (typeof source.direction === "string" && source.direction.trim()) config.direction = source.direction.trim();
	const minWidth = parseNonNegativeInt(source.minWidth);
	if (minWidth !== undefined) config.minWidth = minWidth;
	const minHeight = parseNonNegativeInt(source.minHeight);
	if (minHeight !== undefined) config.minHeight = minHeight;
	const aspectRatio = parseNonNegativeInt(source.aspectRatio);
	if (aspectRatio !== undefined) config.aspectRatio = aspectRatio;
	if (typeof source.showIndicator === "boolean") config.showIndicator = source.showIndicator;
	if (typeof source.hideWhileEditing === "boolean") config.hideWhileEditing = source.hideWhileEditing;

	return config;
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

/**
 * Parse a non-negative integer config value, accepting either a number (from
 * JSON) or a numeric string (from an env var). Non-finite or negative values
 * are ignored so the default remains in effect. Shared by `minWidth` and
 * `minHeight`.
 */
function parseNonNegativeInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
	if (typeof value === "string" && value.trim()) {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return undefined;
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const sessionState: SessionState = { active: false };
	let previousFactory: EditorComponentFactory | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		sessionState.active = true;
		// Wrap the existing editor component instead of replacing it, so we
		// coexist with editor extensions like pi-vim rather than clobbering
		// them (which would drop pi-vim's mode-aware cursor shape).
		previousFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			createSplitEditor(tui, theme, keybindings, ctx.ui, ctx.cwd, sessionState, previousFactory),
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionState.active = false;
		// Unwrap: restore the editor component that was active before us.
		ctx.ui.setEditorComponent(previousFactory);
	});
}
