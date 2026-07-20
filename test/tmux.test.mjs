import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import the real module under test (node strips TS types natively on >=23.6).
// This is the pure helper layer extracted from index.ts; the tmux-coordination
// functions that need a live tmux session stay in index.ts (untestable here
// because index.ts pulls in the pi runtime) and are covered indirectly by the
// end-to-end behavior.
import { buildPaneCommand, serializeEnvironment, shellQuote, splitFlag } from "../tmux.ts";

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