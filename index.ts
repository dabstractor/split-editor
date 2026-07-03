import { spawn } from "node:child_process";
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

const DEFAULT_CONFIG: SplitEditorConfig = {
	editor: "nvim",
	size: "50%",
	direction: "h",
	minWidth: 80,
	minHeight: 10,
	aspectRatio: 4,
	showIndicator: true,
};

type ProcessResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
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
		const lines = this.inner.render(width);
		if (!this.editing || !this.showIndicator || lines.length === 0) return lines;

		const label = " SPLIT EDITOR OPEN ";
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
			this.editing = true;
			this.opening = false;
			this.tui.requestRender();
			await writeFile(tempFile, this.getExpandedText(), "utf8");

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

async function openTmuxSplitAndWait(options: {
	tempFile: string;
	statusFile: string;
	token: string;
	editorCommand: string;
	splitSize: string;
	splitDirection: string;
	splitMinWidth: number;
	splitMinHeight: number;
	splitAspectRatio: number;
}): Promise<void> {
	const wait = startProcess("tmux", ["wait-for", options.token]);
	const waitPromise = wait.promise.catch((error: unknown) => ({
		code: 1,
		signal: null,
		stdout: "",
		stderr: formatError(error),
	}));

	const paneCommand = buildPaneCommand(options.editorCommand, options.tempFile, options.statusFile, options.token);
	const resolvedDirection = await resolveSplitDirection(options.splitDirection, options.splitMinWidth, options.splitMinHeight, options.splitAspectRatio);
	const splitArgs = ["split-window", splitFlag(resolvedDirection), "-l", options.splitSize, paneCommand];

	// Capture pi's own pane id right before splitting so we can re-select it
	// once the editor exits. Without this we rely on tmux's default "select
	// previous pane on close" behavior, which isn't guaranteed if the user
	// switches to a third pane mid-edit or has unusual tmux config.
	const originPaneId = await captureOriginPaneId();

	try {
		const splitResult = await runProcess("tmux", splitArgs);
		if (splitResult.code !== 0) {
			wait.child.kill();
			throw new Error(`tmux split-window failed${formatProcessDetails(splitResult)}`);
		}
	} catch (error) {
		wait.child.kill();
		await waitPromise.catch(() => undefined);
		throw error;
	}

	const waitResult = await waitPromise;
	if (waitResult.code !== 0) {
		throw new Error(`tmux wait-for failed${formatProcessDetails(waitResult)}`);
	}

	// Best-effort: re-focus pi's pane. A no-op if it's already focused, and a
	// hard guarantee otherwise. Must not throw or block the temp-file read-back.
	await reselectOriginPane(originPaneId);
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

	return config;
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function buildPaneCommand(editorCommand: string, tempFile: string, statusFile: string, token: string): string {
	const signalCommand = `tmux wait-for -S ${shellQuote(token)}`;
	return [
		`trap ${shellQuote(signalCommand)} EXIT`,
		`${editorCommand} ${shellQuote(tempFile)}`,
		`printf '%s' "$?" > ${shellQuote(statusFile)}`,
	].join("; ");
}

function splitFlag(direction: string): "-h" | "-v" {
	const normalized = direction.toLowerCase();
	return normalized === "v" || normalized === "vertical" ? "-v" : "-h";
}

/**
 * Query the current tmux pane's size in columns and rows. Used by `auto`
 * direction mode to decide between side-by-side and stacked splits.
 */
async function getPaneSize(): Promise<{ width: number; height: number }> {
	const result = await runProcess("tmux", ["display", "-p", "#{pane_width}\t#{pane_height}"]);
	if (result.code !== 0) {
		throw new Error(`tmux display failed${formatProcessDetails(result)}`);
	}
	const [widthRaw, heightRaw] = result.stdout.trim().split(/\s+/);
	const width = Number.parseInt(widthRaw ?? "", 10);
	const height = Number.parseInt(heightRaw ?? "", 10);
	if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
		throw new Error(`could not parse pane size from tmux output: ${JSON.stringify(result.stdout)}`);
	}
	return { width, height };
}

/**
 * Resolve the configured split direction into a concrete `h`/`v` value. For
 * `auto`, measure the pane and decide in three tiers:
 *
 *   1. Side-by-side halves the width, so it needs `width >= 2 × minWidth`
 *      (each pane keeps at least `minWidth` columns). When that holds, always
 *      prefer side-by-side — including when the height is short, since halving
 *      a short height would leave too few rows.
 *   2. Otherwise (width is too narrow to halve) stack when the height can
 *      spare it: `height >= 2 × minHeight` (each pane keeps at least
 *      `minHeight` rows).
 *   3. When neither floor holds (a genuinely small pane), fall back to the
 *      aspect ratio `width / height > aspectRatio` rather than a hard-coded
 *      default: side-by-side if the pane is relatively wide, stacked
 *      otherwise.
 *
 * `aspectRatio` is in raw cell units (columns ÷ rows), not visual ratio —
 * terminal cells are roughly 2:1, so a value of `4` approximates a 2:1 visual
 * ratio. If the pane can't be measured, fall back to side-by-side so the
 * editor still opens.
 */
async function resolveSplitDirection(direction: string, minWidth: number, minHeight: number, aspectRatio: number): Promise<string> {
	const normalized = direction.toLowerCase().trim();
	if (normalized !== "auto" && normalized !== "smart") {
		return direction;
	}
	try {
		const { width, height } = await getPaneSize();
		if (width >= 2 * minWidth) return "h";
		if (height >= 2 * minHeight) return "v";
		return width > height * aspectRatio ? "h" : "v";
	} catch {
		return "h";
	}
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

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function startProcess(command: string, args: string[]): { child: ReturnType<typeof spawn>; promise: Promise<ProcessResult> } {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	const promise = childResult(child);
	return { child, promise };
}

function runProcess(command: string, args: string[]): Promise<ProcessResult> {
	return startProcess(command, args).promise;
}

function childResult(child: ReturnType<typeof spawn>): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		let settled = false;

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = appendLimited(stdout, chunk.toString("utf8"));
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendLimited(stderr, chunk.toString("utf8"));
		});

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});

		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			resolve({ code, signal, stdout, stderr });
		});
	});
}

function appendLimited(current: string, next: string, maxLength = 8192): string {
	const combined = current + next;
	return combined.length > maxLength ? combined.slice(combined.length - maxLength) : combined;
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

function formatProcessDetails(result: ProcessResult): string {
	const parts: string[] = [];
	if (result.code !== null) parts.push(`exit ${result.code}`);
	if (result.signal) parts.push(`signal ${result.signal}`);
	const status = parts.length > 0 ? ` (${parts.join(", ")})` : "";
	const stderr = result.stderr.trim();
	return stderr ? `${status}: ${stderr}` : status;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
