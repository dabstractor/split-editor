import { spawn } from "node:child_process";

/**
 * Pure tmux process-coordination layer. Kept free of any `@earendil-works/*`
 * imports so it can be unit-tested with plain node (no jiti/stubs/env hacks);
 * `index.ts` wires it into the pi extension.
 */

export type ProcessResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

/**
 * Open a tmux split running `editorCommand` on `tempFile`, and resolve once the
 * editor pane is done — no matter how it ends.
 *
 * Synchronization is a race between two signals:
 *   - the fast path: the pane's shell EXIT trap fires `tmux wait-for -S` on a
 *     clean `:wq`, so the blind `tmux wait-for` child exits instantly;
 *   - the recovery path: tmux closes the pane when its process dies for ANY
 *     reason, including SIGKILL/crash/OOM where no trap can fire.
 *
 * Before this race existed, a SIGKILL'd pane left `wait-for` blocked forever,
 * pinning `editing = true` and killing Ctrl+G until pi was restarted. The
 * `.finally(() => wait.child.kill())` guarantees the blind waiter is always
 * reaped on every path so it can never leak and hold the event loop.
 */
export async function openTmuxSplitAndWait(options: {
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
	// -P prints the new pane id; -F formats it as just the id (e.g. %5).
	const splitArgs = ["split-window", splitFlag(resolvedDirection), "-l", options.splitSize, "-P", "-F", "#{pane_id}", paneCommand];

	let paneId: string | undefined;
	try {
		const splitResult = await runProcess("tmux", splitArgs);
		if (splitResult.code !== 0) {
			wait.child.kill();
			throw new Error(`tmux split-window failed${formatProcessDetails(splitResult)}`);
		}
		paneId = splitResult.stdout.trim() || undefined;
	} catch (error) {
		wait.child.kill();
		await waitPromise.catch(() => undefined);
		throw error;
	}

	// Race the fast path (EXIT-trap signal on clean :wq) against the recovery
	// path (tmux closes the pane — which also happens on SIGKILL, where the trap
	// can't fire). Whichever resolves first wins; then reap the other.
	await Promise.race([
		waitPromise,
		waitForPaneClosed(paneId),
	]).finally(() => {
		wait.child.kill();
	});
}

/**
 * Build the shell command tmux runs in the editor pane. The EXIT trap is the
 * fast-path signal (it fires `tmux wait-for -S` on a clean shell exit); the
 * `printf` writes the editor's exit code to `statusFile` for the caller to read
 * back. Neither runs on SIGKILL — that is why `openTmuxSplitAndWait` also races
 * against `waitForPaneClosed`.
 */
export function buildPaneCommand(editorCommand: string, tempFile: string, statusFile: string, token: string): string {
	const signalCommand = `tmux wait-for -S ${shellQuote(token)}`;
	return [
		`trap ${shellQuote(signalCommand)} EXIT`,
		`${editorCommand} ${shellQuote(tempFile)}`,
		`printf '%s' "$?" > ${shellQuote(statusFile)}`,
	].join("; ");
}

export function splitFlag(direction: string): "-h" | "-v" {
	const normalized = direction.toLowerCase();
	return normalized === "v" || normalized === "vertical" ? "-v" : "-h";
}

/**
 * Resolve when the given pane id no longer exists in tmux. tmux closes a pane
 * when its process exits for ANY reason (clean exit or SIGKILL/crash), so this
 * is a reliable death signal that — unlike a shell EXIT trap — does not depend
 * on the shell getting a chance to run cleanup code. Polls at a coarse interval
 * since this is the recovery path; the common case resolves via the wait-for
 * trap first. Returns immediately if `paneId` is undefined (couldn't capture).
 *
 * The existence check MUST be scoped to the pane itself (`-t <paneId>`).
 * `tmux list-panes` with no target lists only the *current* window's panes, so
 * if the user switches tmux windows while the editor is open, the unscoped
 * query would omit this pane and falsely report it closed. That prematurely
 * resolved `openTmuxSplitAndWait`, reset the editing lock while the pane was
 * still open, and let a second Ctrl+G open a concurrent split — stranding the
 * first edit in its temp file. `-t <paneId>` resolves the pane to its own
 * window regardless of which window is active, and fails (non-zero) once tmux
 * reaps the pane, so it neither false-positives on window switches nor hangs.
 */
export async function waitForPaneClosed(paneId: string | undefined): Promise<void> {
	if (!paneId) return;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		let exists = false;
		try {
			const result = await runProcess("tmux", ["list-panes", "-t", paneId, "-F", "#{pane_id}"]);
			exists = result.code === 0;
		} catch {
			exists = false; // tmux query failed; treat as "gone" so we don't hang.
		}
		if (!exists) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

/**
 * Query the current tmux pane's size in columns and rows. Used by `auto`
 * direction mode to decide between side-by-side and stacked splits.
 */
export async function getPaneSize(): Promise<{ width: number; height: number }> {
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
export async function resolveSplitDirection(direction: string, minWidth: number, minHeight: number, aspectRatio: number): Promise<string> {
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

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function startProcess(command: string, args: string[]): { child: ReturnType<typeof spawn>; promise: Promise<ProcessResult> } {
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	const promise = childResult(child);
	return { child, promise };
}

export function runProcess(command: string, args: string[]): Promise<ProcessResult> {
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

export function formatProcessDetails(result: ProcessResult): string {
	const parts: string[] = [];
	if (result.code !== null) parts.push(`exit ${result.code}`);
	if (result.signal) parts.push(`signal ${result.signal}`);
	const status = parts.length > 0 ? ` (${parts.join(", ")})` : "";
	const stderr = result.stderr.trim();
	return stderr ? `${status}: ${stderr}` : status;
}

export function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
