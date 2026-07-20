import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Pure resolver, extracted into its own module (./editor.ts) — mirroring
// ./tmux.ts and ./collapsed-prompt.ts — so the full precedence chain can be
// unit-tested with plain node (index.ts pulls in the pi runtime and can't be
// imported here).
import { readExternalEditor, resolveEditor } from "../editor.ts";

/** Minimal valid input; tests override individual fields. */
const base = (overrides = {}) => ({
	explicitEditor: undefined,
	projectSettings: {},
	globalSettings: {},
	env: {},
	platform: "linux",
	...overrides,
});

describe("resolveEditor — explicit split-editor `editor` always wins", () => {
	it("returns the explicit editor, ignoring pi settings and env vars", () => {
		assert.equal(
			resolveEditor(
				base({
					explicitEditor: "nvim",
					projectSettings: { externalEditor: "code" },
					env: { VISUAL: "vim" },
				}),
			),
			"nvim",
		);
	});

	it("treats an empty-string explicit editor as unset (falls through)", () => {
		// normalizeRawConfig only ever yields undefined or a non-empty trimmed
		// string, but resolveEditor guards defensively anyway.
		assert.equal(resolveEditor(base({ explicitEditor: "", env: { EDITOR: "nano" } })), "nano");
	});
});

describe("resolveEditor — pi's externalEditor setting (project over global)", () => {
	it("uses the project externalEditor when present", () => {
		assert.equal(
			resolveEditor(
				base({
					projectSettings: { externalEditor: "code --wait" },
					globalSettings: { externalEditor: "nano" },
				}),
			),
			"code --wait",
		);
	});

	it("falls back to the global externalEditor when the project has none", () => {
		assert.equal(resolveEditor(base({ globalSettings: { externalEditor: "helix" } })), "helix");
	});

	it("beats $VISUAL / $EDITOR (matches pi's own ordering)", () => {
		assert.equal(
			resolveEditor(base({ projectSettings: { externalEditor: "code" }, env: { VISUAL: "vim" } })),
			"code",
		);
	});
});

describe("resolveEditor — env vars", () => {
	it("prefers $VISUAL over $EDITOR", () => {
		assert.equal(resolveEditor(base({ env: { VISUAL: "code", EDITOR: "nano" } })), "code");
	});

	it("uses $EDITOR when $VISUAL is unset", () => {
		assert.equal(resolveEditor(base({ env: { EDITOR: "nano" } })), "nano");
	});
});

describe("resolveEditor — platform defaults (nothing configured)", () => {
	it("defaults to nano on non-win32 platforms", () => {
		assert.equal(resolveEditor(base({ platform: "linux" })), "nano");
		assert.equal(resolveEditor(base({ platform: "darwin" })), "nano");
	});

	it("defaults to notepad on win32", () => {
		assert.equal(resolveEditor(base({ platform: "win32" })), "notepad");
	});
});

describe("readExternalEditor", () => {
	it("returns a trimmed externalEditor string", () => {
		assert.equal(readExternalEditor({ externalEditor: "  code --wait  " }), "code --wait");
	});

	it("returns undefined for missing / empty / blank / wrong-type / non-object input", () => {
		assert.equal(readExternalEditor(undefined), undefined);
		assert.equal(readExternalEditor(null), undefined);
		assert.equal(readExternalEditor([]), undefined);
		assert.equal(readExternalEditor("code"), undefined);
		assert.equal(readExternalEditor({}), undefined);
		assert.equal(readExternalEditor({ externalEditor: "" }), undefined);
		assert.equal(readExternalEditor({ externalEditor: "   " }), undefined);
		assert.equal(readExternalEditor({ externalEditor: 42 }), undefined);
		assert.equal(readExternalEditor({ externalEditor: null }), undefined);
	});
});