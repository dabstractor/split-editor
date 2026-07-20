import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import the real module under test (node strips TS types natively on >=23.6).
import {
	openTmuxSplitAndWait,
	waitForPaneClosed,
	buildPaneCommand,
	serializeEnvironment,
	splitFlag,
	shellQuote,
	formatError,
	formatProcessDetails,
} from "../tmux.ts";

// --- tmux helpers -------------------------------------------------------------

const INSIDE_TMUX = Boolean(process.env.TMUX);
const tmux = (args) => execFileSync("tmux", args, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listPaneIds = () =>
	tmux(["list-panes", "-F", "#{pane_id}"]).split(/\r?\n/).filter(Boolean);

/** Resolve after `ms`, rejecting with `msg` — guards tests so a regression
 *  can never hang the runner. */
const hangGuard = (ms, msg) =>
	new Promise((_, reject) =>
		setTimeout(() => reject(new Error(`hang guard (${ms}ms): ${msg}`)), ms),
	);

/** Count lingering `tmux wait-for <token>` clients. 0 means the blind waiter
 *  was reaped (the `.finally(() => wait.child.kill())` contract). */
function countWaiters(token) {
	try {
		const out = execFileSync("pgrep", ["-f", `tmux wait-for ${token}`], {
			encoding: "utf8",
		});
		return out.split("\n").filter(Boolean).length;
	} catch {
		return 0; // pgrep exits 1 when nothing matched
	}
}

/** SIGKILL the whole pane process group so no orphaned editor child lingers. */
function killPaneGroup(paneId) {
	try {
		const pid = Number(tmux(["display", "-t", paneId, "-p", "#{pane_pid}"]));
		if (pid > 0) process.kill(-pid, 9); // negative pid = process group
	} catch {
		/* pane already gone */
	}
	try {
		execFileSync("tmux", ["kill-pane", "-t", paneId], { stdio: "ignore" });
	} catch {
		/* already closed */
	}
}

const opts = (tmp, i) => {
	const suffix = `test-${i}-${Date.now().toString(36)}-${process.pid.toString(36)}`;
	return {
		tempFile: join(tmp, `split-editor-${suffix}.md`),
		statusFile: join(tmp, `split-editor-${suffix}.status`),
		token: `split-editor-${suffix}`,
		editorCommand: "true",
		splitSize: "50%",
		splitDirection: "h",
		splitMinWidth: 80,
		splitMinHeight: 10,
		splitAspectRatio: 4,
	};
};

// --- pure helpers (no tmux required, run anywhere) ---------------------------

describe("buildPaneCommand", () => {
	it("emits the EXIT trap, the editor invocation, and the status write", () => {
		const cmd = buildPaneCommand("nvim", "/tmp/f.md", "/tmp/f.status", "tok");
		assert.match(cmd, /trap .* EXIT/);
		assert.ok(cmd.includes("nvim '/tmp/f.md'"), cmd);
		assert.ok(cmd.includes("printf '%s' \"$?\" > '/tmp/f.status'"), cmd);
		assert.ok(cmd.includes("tmux wait-for -S"), cmd);
		assert.ok(cmd.includes("tok"), cmd);
		// ordering: trap first, then editor, then printf
		assert.ok(cmd.indexOf("trap") < cmd.indexOf("nvim"), cmd);
		assert.ok(cmd.indexOf("nvim") < cmd.indexOf("printf"), cmd);
	});

	it("shell-quotes a token/path containing a single quote", () => {
		const cmd = buildPaneCommand("ed", "/a'b", "/c'd", "to'k");
		// each embedded quote is escaped as '\''
		assert.ok(cmd.includes("'\\''"), cmd);
	});

	it("omits the source step entirely when no envFile is given (back-compat)", () => {
		const cmd = buildPaneCommand("nvim", "/tmp/f.md", "/tmp/f.status", "tok");
		assert.ok(!cmd.includes("2>/dev/null"), cmd);
		assert.ok(!cmd.includes(". "), cmd);
	});

	it("sources the env file (best-effort) before the editor when envFile is given", () => {
		const cmd = buildPaneCommand("nvim", "/tmp/f.md", "/tmp/f.status", "tok", "/tmp/f.env");
		assert.ok(cmd.includes(`. ${shellQuote("/tmp/f.env")} 2>/dev/null`), cmd);
		// ordering: trap -> source -> editor -> printf
		assert.ok(cmd.indexOf("trap") < cmd.indexOf("/tmp/f.env"), cmd);
		assert.ok(cmd.indexOf("/tmp/f.env") < cmd.indexOf("nvim"), cmd);
		assert.ok(cmd.indexOf("nvim") < cmd.indexOf("printf"), cmd);
	});

	it("shell-quotes an envFile path that itself contains a single quote", () => {
		const cmd = buildPaneCommand("nvim", "/tmp/f.md", "/tmp/f.status", "tok", "/a'b.env");
		assert.ok(cmd.includes(". '/a'\\''b.env' 2>/dev/null"), cmd);
	});
});

describe("splitFlag", () => {
	it("maps direction aliases to -h / -v", () => {
		assert.equal(splitFlag("h"), "-h");
		assert.equal(splitFlag("horizontal"), "-h");
		assert.equal(splitFlag("H"), "-h");
		assert.equal(splitFlag("v"), "-v");
		assert.equal(splitFlag("vertical"), "-v");
		// anything not v/vertical falls back to side-by-side
		assert.equal(splitFlag("auto"), "-h");
		assert.equal(splitFlag("nonsense"), "-h");
	});
});

describe("shellQuote", () => {
	it("wraps a plain string in single quotes", () => {
		assert.equal(shellQuote("abc"), "'abc'");
	});
	it("escapes embedded single quotes", () => {
		assert.equal(shellQuote("a'b"), "'a'\\''b'");
	});
});

describe("serializeEnvironment", () => {
	it("emits one POSIX `export KEY='value'` line per env var, newline-joined", () => {
		const out = serializeEnvironment({ FOO: "bar", BAZ: "qux" });
		assert.equal(out, "export FOO='bar'\nexport BAZ='qux'");
	});

	it("skips empty/undefined values and invalid key names", () => {
		const out = serializeEnvironment({
			GOOD: "x",
			EMPTY: "",
			UNSET: undefined,
			"bad-name": "y",
			"1digit": "z",
			ALSO_GOOD: "w",
		});
		assert.equal(out, "export GOOD='x'\nexport ALSO_GOOD='w'");
	});

	it("honors the skip set so tmux/shell-owned vars are not forwarded", () => {
		const out = serializeEnvironment(
			{ TMUX: "/tmp/sock,1", FOO: "bar", PWD: "/home" },
			new Set(["TMUX", "PWD"]),
		);
		assert.equal(out, "export FOO='bar'");
	});

	it("escapes embedded single quotes and preserves literal newlines", () => {
		const out = serializeEnvironment({ A: "it's", B: "line1\nline2" });
		// values are safe to `source`: single quotes escaped, newline preserved
		assert.ok(out.includes("export A='it'\\''s'"), out);
		assert.ok(out.includes("export B='line1\nline2'"), out);
	});

	it("round-trips through a real POSIX shell (source really does export every value verbatim)", async () => {
		// Strongest guarantee: sourcing the serialized file in a real sh exports
		// each value byte-for-byte, including embedded quotes and newlines.
		const env = { PLAIN: "hello", SPACES: "a b c", QUOTE: "a'b", NEWLINE: "x\ny" };
		const serialized = serializeEnvironment(env);
		const dir = await mkdtemp(join(tmpdir(), "split-env-"));
		const file = join(dir, "env.sh");
		await writeFile(file, serialized, "utf8");
		try {
			const dump = execFileSync(
				"sh",
				["-c", `. ${shellQuote(file)} && printf '%s|%s|%s|%s' "$PLAIN" "$SPACES" "$QUOTE" "$NEWLINE"`],
				{ encoding: "utf8" },
			);
			assert.equal(dump, "hello|a b c|a'b|x\ny");
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});
});

describe("formatError / formatProcessDetails", () => {
	it("formatError unwraps Error.message and stringifies anything else", () => {
		assert.equal(formatError(new Error("boom")), "boom");
		assert.equal(formatError("oops"), "oops");
		assert.equal(formatError(42), "42");
	});
	it("formatProcessDetails reports code/signal and trims stderr", () => {
		assert.equal(formatProcessDetails({ code: 0, signal: null, stdout: "", stderr: "" }), " (exit 0)");
		assert.equal(
			formatProcessDetails({ code: 2, signal: "SIGTERM", stdout: "", stderr: "  bad  " }),
			" (exit 2, signal SIGTERM): bad",
		);
	});
});

// --- tmux coordination (require a live tmux session: $TMUX) ------------------
//   These reproduce the deadlock: SIGKILL'ing the pane shell can't fire the
//   EXIT trap, so the old wait-for-only path hung forever. They assert the race
//   against pane-existence recovers promptly and leaks nothing.

describe("openTmuxSplitAndWait", { skip: !INSIDE_TMUX && "not inside tmux ($TMUX unset)" }, () => {
	let tmp;

	it.before(async () => {
		tmp = await mkdtemp(join(tmpdir(), "split-editor-test-"));
	});
	it.after(async () => {
		await rm(tmp, { recursive: true, force: true }).catch(() => {});
	});

	it("happy path: clean editor exit resolves fast, writes status, leaves no waiter", async () => {
		const o = opts(tmp, "happy");
		o.editorCommand = "true"; // ignores the appended tempfile, exits 0
		await writeFile(o.tempFile, "hello\n", "utf8");

		const start = Date.now();
		await Promise.race([
			openTmuxSplitAndWait(o),
			hangGuard(5000, "happy path did not resolve"),
		]);
		const elapsed = Date.now() - start;

		// wait-for trap fires on clean exit — should be well under a second.
		assert.ok(elapsed < 1500, `happy path was slow: ${elapsed}ms`);
		// EXIT trap ran printf before signalling → status file is "0".
		const status = await readFile(o.statusFile, "utf8").catch(() => null);
		assert.equal(status?.trim(), "0", "status file should report editor exit 0");
		// the blind tmux wait-for child must be reaped (no leak / no hung event loop).
		await sleep(100);
		assert.equal(countWaiters(o.token), 0, "wait-for client leaked on happy path");
	});

	it("forwards the caller's environment into the editor pane (parity with pi's direct spawn)", async () => {
		// A var that exists ONLY in this test process (not the long-lived tmux
		// server) must reach the editor pane via the sourced env file; without
		// forwarding it would be dropped at the tmux server boundary.
		const sentinelKey = `SPLIT_EDITOR_TEST_SENTINEL_${process.pid}`;
		const sentinelValue = `forwarded-${Date.now().toString(36)}`;
		process.env[sentinelKey] = sentinelValue;
		try {
			const o = opts(tmp, "envfwd");
			// "editor": dump the pane's full environment to the temp file so we can
			// assert the sentinel survived the server boundary. ($1 = tempFile.)
			o.editorCommand = `sh -c 'env > "$1"' _`;
			await writeFile(o.tempFile, "seed\n", "utf8");
			const envFile = join(tmp, `split-editor-${o.token}.env`);
			await writeFile(envFile, serializeEnvironment(process.env, new Set()), "utf8");
			o.envFile = envFile;

			await Promise.race([
				openTmuxSplitAndWait(o),
				hangGuard(5000, "env-forwarding path did not resolve"),
			]);

			const captured = await readFile(o.tempFile, "utf8").catch(() => "");
			assert.ok(
				captured.includes(`${sentinelKey}=${sentinelValue}`),
				`env var not forwarded into editor pane; captured env missing ${sentinelKey}=${sentinelValue}`,
			);
			await rm(envFile, { force: true }).catch(() => {});
		} finally {
			delete process.env[sentinelKey];
		}
	});

	it("recovery path: SIGKILL of the pane shell resolves within ~1s instead of hanging", async () => {
		const o = opts(tmp, "sigkill");
		o.editorCommand = 'sh -c "sleep 300"'; // long-running "editor"; tempfile → $0, ignored
		await writeFile(o.tempFile, "hello\n", "utf8");

		const before = new Set(listPaneIds());
		const promise = openTmuxSplitAndWait(o);

		// find the editor pane tmux just created
		let editorPane;
		for (let i = 0; i < 60 && !editorPane; i++) {
			const added = listPaneIds().filter((p) => !before.has(p));
			if (added.length) editorPane = added[0];
			else await sleep(50);
		}
		assert.ok(editorPane, "editor pane did not appear");
		await sleep(250); // let the "editor" actually be running

		// Force the failure mode the bug is about: kill the pane's shell with
		// SIGKILL (signal 9) — uncatchable, so the EXIT trap can never fire.
		killPaneGroup(editorPane);

		const start = Date.now();
		await Promise.race([
			promise,
			hangGuard(5000, "openTmuxSplitAndWait did not resolve after pane SIGKILL (the hang returned)"),
		]);
		const elapsed = Date.now() - start;

		// pane-death poll is 150ms + tmux ~100ms to close the pane; allow headroom.
		assert.ok(elapsed < 2000, `recovery was slow: ${elapsed}ms`);
		await sleep(100);
		assert.equal(countWaiters(o.token), 0, "wait-for client leaked on pane-death path");
	});
});

describe("waitForPaneClosed", { skip: !INSIDE_TMUX && "not inside tmux ($TMUX unset)" }, () => {
	it("resolves immediately when paneId is undefined", async () => {
		const start = Date.now();
		await waitForPaneClosed(undefined);
		assert.ok(Date.now() - start < 50, "did not short-circuit on undefined paneId");
	});

	it("resolves once tmux closes the pane (covers SIGKILL, where no trap fires)", async () => {
		const pane = tmux(["split-window", "-h", "-l", "50%", "-P", "-F", "#{pane_id}", "sleep 300"]);
		await sleep(150);
		assert.ok(listPaneIds().includes(pane), "fixture pane not present");

		const p = waitForPaneClosed(pane);
		killPaneGroup(pane); // also kills the orphaned sleep via the process group
		await Promise.race([
			p,
			hangGuard(3000, "waitForPaneClosed did not resolve after pane kill"),
		]);
		assert.ok(!listPaneIds().includes(pane), "pane still listed after close");
	});

	it("does NOT resolve when the pane still exists but the active window changes (regression)", async () => {
		// `tmux list-panes` with no target lists only the *current* window's
		// panes. The old unscoped query falsely concluded the pane was gone the
		// moment the user switched tmux windows, which reset the editing lock
		// mid-edit and let a second split open concurrently. The scoped
		// `-t <paneId>` query must keep reporting the pane as alive as long as
		// it truly exists, regardless of which window is active.
		//
		// Use dedicated windows (created detached) so the pane and the
		// "other" window are genuinely separate, and so the test never touches
		// the window running this test process.
		const mainWin = tmux(["new-window", "-d", "-P", "-F", "#{window_id}", "sleep 300"]);
		const otherWin = tmux(["new-window", "-d", "-P", "-F", "#{window_id}", "sleep 300"]);
		const pane = tmux(["split-window", "-t", mainWin, "-h", "-l", "50%", "-P", "-F", "#{pane_id}", "sleep 300"]);
		try {
			// Sanity: querying the pane by id succeeds while it lives.
			assert.equal(tmux(["list-panes", "-t", pane, "-F", "#{pane_id}"]).includes(pane), true);

			// Make a DIFFERENT window the session's active window and linger well
			// past the 150ms poll interval. The pane still exists in `mainWin`.
			tmux(["select-window", "-t", otherWin]);
			await sleep(500);

			let resolved = false;
			const guard = waitForPaneClosed(pane).then(() => {
				resolved = true;
			});
			await sleep(500);
			assert.equal(resolved, false, "waitForPaneClosed false-positived while the pane still existed");

			// Now actually close the pane; it must resolve promptly.
			killPaneGroup(pane);
			await Promise.race([
				guard,
				hangGuard(3000, "waitForPaneClosed did not resolve after the pane was truly closed"),
			]);
		} finally {
			tmux(["kill-window", "-t", mainWin]);
			tmux(["kill-window", "-t", otherWin]);
		}
	});
});
