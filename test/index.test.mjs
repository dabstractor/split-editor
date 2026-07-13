import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The collapse logic is intentionally pure and lives in its own module
// (./collapsed-prompt.ts), mirroring ./tmux.ts, so it can be unit-tested with
// plain node — `index.ts` itself cannot be imported here (it pulls in the pi
// runtime via `@earendil-works/*`, which is not on this project's resolution
// path, and uses TS parameter properties node's strip-only mode rejects).
import { renderCollapsedPrompt, SPLIT_EDITOR_OPEN_LABEL } from "../collapsed-prompt.ts";

const identity = (s) => s;

describe("renderCollapsedPrompt — showIndicator false (fully hidden)", () => {
	it("returns [] when showIndicator is false", () => {
		assert.deepEqual(renderCollapsedPrompt(80, { showIndicator: false }), []);
	});

	it("returns [] even on a wide terminal and with a borderColor", () => {
		assert.deepEqual(
			renderCollapsedPrompt(200, { showIndicator: false, borderColor: (s) => `\x1b[36m${s}\x1b[39m` }),
			[],
		);
	});

	it("returns [] regardless of width (including negative)", () => {
		assert.deepEqual(renderCollapsedPrompt(-5, { showIndicator: false }), []);
		assert.deepEqual(renderCollapsedPrompt(0, { showIndicator: false }), []);
	});
});

describe("renderCollapsedPrompt — showIndicator true (single indicator line)", () => {
	it("returns exactly one line that contains the label", () => {
		const out = renderCollapsedPrompt(80, { showIndicator: true });
		assert.equal(out.length, 1);
		assert.match(out[0], /SPLIT EDITOR OPEN/);
	});

	it("uses SPLIT_EDITOR_OPEN_LABEL as the default label content", () => {
		const out = renderCollapsedPrompt(80, { showIndicator: true });
		assert.equal(out[0], SPLIT_EDITOR_OPEN_LABEL);
	});

	it("does not apply color when borderColor is omitted", () => {
		const out = renderCollapsedPrompt(80, { showIndicator: true });
		assert.equal(out[0], " SPLIT EDITOR OPEN ");
		assert.equal(out[0].includes("\x1b"), false, "must contain no ANSI codes when uncolored");
	});

	it("applies borderColor to the whole line when provided", () => {
		const out = renderCollapsedPrompt(80, {
			showIndicator: true,
			borderColor: (s) => `\x1b[36m${s}\x1b[39m`,
		});
		assert.equal(out[0], "\x1b[36m SPLIT EDITOR OPEN \x1b[39m");
	});

	it("respects a custom label", () => {
		const out = renderCollapsedPrompt(80, { showIndicator: true, label: " hi " });
		assert.equal(out[0], " hi ");
	});

	it("colors a custom label too", () => {
		const out = renderCollapsedPrompt(80, {
			showIndicator: true,
			label: " editing ",
			borderColor: identity,
		});
		assert.equal(out[0], " editing ");
	});
});

describe("renderCollapsedPrompt — width handling", () => {
	it("truncates the label to width on narrow terminals with no ellipsis", () => {
		const out = renderCollapsedPrompt(5, { showIndicator: true });
		assert.equal(out.length, 1);
		// Pure ASCII label clipped to 5 cells = " SPLI" (no trailing ANSI reset,
		// unlike pi-tui's truncateToWidth which appends \x1b[0m).
		assert.equal(out[0], " SPLI");
		assert.equal(out[0].length, 5);
	});

	it("returns the full label when width equals the label length", () => {
		const width = SPLIT_EDITOR_OPEN_LABEL.length;
		const out = renderCollapsedPrompt(width, { showIndicator: true });
		assert.equal(out[0], SPLIT_EDITOR_OPEN_LABEL);
	});

	it("clips one char short when width is one less than the label length", () => {
		const width = SPLIT_EDITOR_OPEN_LABEL.length - 1;
		const out = renderCollapsedPrompt(width, { showIndicator: true });
		assert.equal(out[0], SPLIT_EDITOR_OPEN_LABEL.slice(0, width));
	});

	it("clamps negative width to 0 without throwing", () => {
		const out = renderCollapsedPrompt(-1, { showIndicator: true });
		assert.equal(out.length, 1);
		assert.equal(out[0], "");
	});

	it("clamps zero width to an empty string line without throwing", () => {
		const out = renderCollapsedPrompt(0, { showIndicator: true });
		assert.equal(out.length, 1);
		assert.equal(out[0], "");
	});

	it("truncation happens before borderColor is applied (color wraps the clipped text)", () => {
		const out = renderCollapsedPrompt(3, {
			showIndicator: true,
			borderColor: (s) => `[${s}]`,
		});
		assert.equal(out[0], "[ SP]");
	});

	it("never exceeds the requested width in visible cells for ASCII input", () => {
		for (const width of [1, 2, 5, 7, 10, 18, 19, 30, 80]) {
			const out = renderCollapsedPrompt(width, { showIndicator: true });
			// strip a trivial bracketing colorer for the visible-width check
			const visible = out[0].replace(/\x1b\[[0-9;]*m/g, "");
			assert.ok(
				visible.length <= Math.max(0, width),
				`width ${width}: visible "${visible}" (len ${visible.length}) exceeded ${width}`,
			);
		}
	});
});

describe("SPLIT_EDITOR_OPEN_LABEL", () => {
	it("is the expected bordered string", () => {
		assert.equal(SPLIT_EDITOR_OPEN_LABEL, " SPLIT EDITOR OPEN ");
	});

	it("is pure ASCII (cell count === char count), so simple slicing is correct", () => {
		assert.equal(SPLIT_EDITOR_OPEN_LABEL.length, [...SPLIT_EDITOR_OPEN_LABEL].length);
	});
});
