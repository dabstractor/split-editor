/**
 * Pure helpers for building the tmux pane command, kept free of any
 * `@earendil-works/*` imports (and of `process`/fs) so they can be unit-tested
 * with plain node. index.ts wires them into the pi extension.
 */

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Serialize an environment map into POSIX-shell `export` lines so it can be
 * re-established inside a tmux pane (see `buildPaneCommand`'s `envFile`).
 *
 * Why this exists: tmux runs a `split-window` pane under the tmux *server*,
 * which uses the server's session environment — a snapshot from when the server
 * started, refreshed only for the tiny `update-environment` allowlist
 * (DISPLAY, SSH_AUTH_SOCK, …). Anything set later — a just-sourced direnv, a
 * freshly-exported API key, vars pi set on its own process — is dropped, unlike
 * pi's native Ctrl+G which `spawn`s the editor as a direct child and so
 * inherits the full live `process.env`. Writing this snapshot to a temp file
 * and sourcing it in the pane restores that inheritance across the boundary.
 *
 * `shellQuote`-escaped values handle embedded single quotes and even literal
 * newlines (valid inside POSIX single quotes). Invalid env keys and empty
 * values are skipped; keys in `skip` are dropped so the pane/shell keeps owning
 * the vars it must control itself (TMUX, TMUX_PANE, PWD, …).
 */
export function serializeEnvironment(
	env: Record<string, string | undefined>,
	skip: ReadonlySet<string> = new Set(),
): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (skip.has(key)) continue;
		if (typeof value !== "string" || value === "") continue;
		if (!ENV_KEY_PATTERN.test(key)) continue;
		lines.push(`export ${key}=${shellQuote(value)}`);
	}
	return lines.join("\n");
}

/**
 * Build the shell command tmux runs in the editor pane. The EXIT trap is the
 * signal `openTmuxSplitAndWait`'s `tmux wait-for` waits on (it fires on a clean
 * shell exit); the `printf` writes the editor's exit code to `statusFile` for
 * the caller to read back.
 *
 * When `envFile` is given it is sourced first (`.`) so the editor inherits the
 * caller's environment (see `serializeEnvironment`). Sourcing is silenced and
 * non-fatal: a missing/unreadable file just degrades to the pre-forwarding
 * behavior rather than blocking the edit. The trap is still set before the
 * editor so the wait-for covers every exit path.
 */
export function buildPaneCommand(editorCommand: string, tempFile: string, statusFile: string, token: string, envFile?: string): string {
	const signalCommand = `tmux wait-for -S ${shellQuote(token)}`;
	const commands: string[] = [`trap ${shellQuote(signalCommand)} EXIT`];
	if (envFile) {
		commands.push(`. ${shellQuote(envFile)} 2>/dev/null`);
	}
	commands.push(`${editorCommand} ${shellQuote(tempFile)}`);
	commands.push(`printf '%s' "$?" > ${shellQuote(statusFile)}`);
	return commands.join("; ");
}

export function splitFlag(direction: string): "-h" | "-v" {
	const normalized = direction.toLowerCase();
	return normalized === "v" || normalized === "vertical" ? "-v" : "-h";
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}