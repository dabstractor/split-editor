import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CustomEditor, type ExtensionAPI, type ExtensionUIContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const STATUS_KEY = "pi-split-editor";
const DEFAULT_EDITOR = process.env.PI_SPLIT_EDITOR_EDITOR?.trim() || "nvim";
const DEFAULT_SPLIT_SIZE = process.env.PI_SPLIT_EDITOR_SIZE?.trim() || "50%";
const DEFAULT_SPLIT_DIRECTION = process.env.PI_SPLIT_EDITOR_DIRECTION?.trim() || "h";

type ProcessResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
};

type SessionState = {
	active: boolean;
};

class SplitEditor extends CustomEditor {
	private editing = false;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly appKeybindings: KeybindingsManager,
		private readonly ui: ExtensionUIContext,
		private readonly sessionState: SessionState,
	) {
		super(tui, theme, appKeybindings);
	}

	handleInput(data: string): void {
		// Intercept before CustomEditor's copied app handlers so pi's built-in
		// blocking external-editor action never runs.
		if (this.appKeybindings.matches(data, "app.editor.external")) {
			if (this.editing) {
				this.ui.notify("split editor is already open", "warning");
				return;
			}
			void this.openSplitEditor();
			return;
		}

		if (this.editing) {
			// Lock the prompt while the tmux pane owns the editable copy.
			return;
		}

		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (!this.editing || lines.length === 0) return lines;

		const label = " SPLIT EDITOR OPEN ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, Math.max(0, width - label.length), "") + label;
		}
		return lines;
	}

	private async openSplitEditor(): Promise<void> {
		if (!process.env.TMUX) {
			this.ui.notify("pi-split-editor requires tmux; Ctrl+G was ignored", "warning");
			return;
		}

		if (this.editing) {
			this.ui.notify("split editor is already open", "warning");
			return;
		}

		const suffix = `${process.pid}-${Date.now()}-${randomUUID()}`;
		const tempFile = join(tmpdir(), `pi-split-editor-${suffix}.md`);
		const statusFile = join(tmpdir(), `pi-split-editor-${suffix}.status`);
		const token = `pi-split-editor-${suffix}`;

		this.editing = true;
		this.ui.setStatus(STATUS_KEY, "split editor: open");
		this.tui.requestRender();

		try {
			await writeFile(tempFile, this.getExpandedText(), "utf8");

			await openTmuxSplitAndWait({
				tempFile,
				statusFile,
				token,
				editorCommand: DEFAULT_EDITOR,
				splitSize: DEFAULT_SPLIT_SIZE,
				splitDirection: DEFAULT_SPLIT_DIRECTION,
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

			const newText = await readFile(tempFile, "utf8");
			if (this.sessionState.active) {
				this.setText(newText);
				this.tui.requestRender();
			}
		} catch (error) {
			this.ui.notify(`pi-split-editor: ${formatError(error)}`, "error");
		} finally {
			this.editing = false;
			this.ui.setStatus(STATUS_KEY, undefined);
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
			new SplitEditor(tui, theme, keybindings, ctx.ui, sessionState),
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionState.active = false;
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
