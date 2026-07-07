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
});
