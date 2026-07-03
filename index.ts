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
	showIndicator: true,
};

type ProcessResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
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
}): Promise<void> {
	const wait = startProcess("tmux", ["wait-for", options.token]);
	const waitPromise = wait.promise.catch((error: unknown) => ({
		code: 1,
		signal: null,
		stderr: formatError(error),
	}));

	const paneCommand = buildPaneCommand(options.editorCommand, options.tempFile, options.statusFile, options.token);
	const splitArgs = ["split-window", splitFlag(options.splitDirection), "-l", options.splitSize, paneCommand];

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

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function startProcess(command: string, args: string[]): { child: ReturnType<typeof spawn>; promise: Promise<ProcessResult> } {
	const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
	const promise = childResult(child);
	return { child, promise };
}

function runProcess(command: string, args: string[]): Promise<ProcessResult> {
	return startProcess(command, args).promise;
}

function childResult(child: ReturnType<typeof spawn>): Promise<ProcessResult> {
	return new Promise((resolve, reject) => {
		let stderr = "";
		let settled = false;

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
			resolve({ code, signal, stderr });
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
