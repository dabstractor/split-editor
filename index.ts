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
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

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

type SplitEditorConfig = {
	editor: string;
	size: string;
	direction: string;
	showIndicator: boolean;
};

type RawConfig = Partial<SplitEditorConfig> & {
	splitEditor?: Partial<SplitEditorConfig>;
};

class SplitEditor extends CustomEditor {
	private editing = false;
	private opening = false;
	private showIndicator = DEFAULT_CONFIG.showIndicator;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly appKeybindings: KeybindingsManager,
		private readonly ui: ExtensionUIContext,
		private readonly cwd: string,
		private readonly sessionState: SessionState,
	) {
		super(tui, theme, appKeybindings);
	}

	handleInput(data: string): void {
		// Intercept before CustomEditor's copied app handlers so pi's built-in
		// blocking external-editor action never runs.
		if (this.appKeybindings.matches(data, "app.editor.external")) {
			if (this.editing || this.opening) {
				this.ui.notify("split editor is already open", "warning");
				return;
			}
			void this.openSplitEditor();
			return;
		}

		if (this.editing || this.opening) {
			// Lock the prompt while the tmux pane owns the editable copy.
			return;
		}

		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (!this.editing || !this.showIndicator || lines.length === 0) return lines;

		const label = " SPLIT EDITOR OPEN ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, Math.max(0, width - label.length), "") + label;
		}
		return lines;
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
				this.setText(newText);
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

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		sessionState.active = true;
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new SplitEditor(tui, theme, keybindings, ctx.ui, ctx.cwd, sessionState),
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionState.active = false;
		ctx.ui.setEditorComponent(undefined);
	});
}
