import { describe, expect, it } from "vitest";
import {
	resEdit,
	type Anchor,
	type HTEdit,
} from "../../src/hashline";

describe("resEdit", () => {
	it("resolves replace with remove_from/remove_to", () => {
		const edit: HTEdit = { remove_from: "wpdmx", remove_to: "ukabx", text: ["a", "b"] };
		const resolved = resEdit(edit);
		expect(resolved).toHaveProperty("hash_bounds");
		expect(resolved).toHaveProperty("content_lines");
	});

	it("resolves a 1-line replace (same anchor)", () => {
		const edit: HTEdit = { remove_from: "ribbx", remove_to: "ribbx", text: ["new"] };
		const resolved = resEdit(edit);
		const r = resolved as {
			hash_bounds: [Anchor, Anchor];
      content_lines: string[];
		};
		expect(r.hash_bounds[0].hash).toBe("ribbx");
		expect(r.hash_bounds[1].hash).toBe("ribbx");
	});

	it("throws on replace with no remove_from/remove_to (E_BAD_SHAPE)", () => {
    const edit = { text: ["new"] } as any;
		expect(() => resEdit(edit)).toThrow(/^\[E_BAD_SHAPE\]/);
	});

	it("throws on malformed remove_from/remove_to", () => {
		const edit: HTEdit = { remove_from: "not-valid", remove_to: "not-valid", text: ["x"] };
		expect(() => resEdit(edit)).toThrow(/Invalid anchor/);
	});

  it("accepts a single string text input", () => {
    const resolved = resEdit({
      remove_from: "wpdmx", remove_to: "wpdmx",
      text: "hello",
    });
    expect(resolved.content_lines).toEqual(["hello"]);
  });

  it("passes text through as content lines", () => {
    const edit = {
      remove_from: "wpdmx", remove_to: "wpdmx",
      text: ["line1", "line2", ""],
    } as unknown as HTEdit;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["line1", "line2", ""]);
  });

  it("splits elements with embedded newlines in text", () => {
    const edit = {
      remove_from: "wpdmx", remove_to: "wpdmx",
      text: ["a\r\nb", "c"],
    } as unknown as HTEdit;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["a", "b", "c"]);
  });

  it("unwraps a stringified text array", () => {
    const warnings: string[] = [];
    const edit = {
      remove_from: "wpdmx", remove_to: "wpdmx",
      text: ['["a", "b",]'],
    } as unknown as HTEdit;
    const resolved = resEdit(edit, warnings);
    expect(resolved.content_lines).toEqual(["a", "b"]);
    expect(warnings).toEqual([]);
  });

  it("decodes single-quoted array text", () => {
    const warnings: string[] = [];
    const edit = {
      remove_from: "wpdmx", remove_to: "wpdmx",
      text: ["['a', 'b']"],
    } as unknown as HTEdit;
    const resolved = resEdit(edit, warnings);
    expect(resolved.content_lines).toEqual(["a", "b"]);
    expect(warnings).toEqual([]);
  });

  it("warns but keeps unparseable string-array text as one literal line", () => {
    const warnings: string[] = [];
    const edit = {
      remove_from: "wpdmx", remove_to: "wpdmx",
      text: ['["a", 7]'],
    } as unknown as HTEdit;
    const resolved = resEdit(edit, warnings);
    expect(resolved.content_lines).toEqual(['["a", 7]']);
    expect(warnings[0]).toContain("looked like a JSON array but could not be parsed");
  });

	it("rejects null text input", () => {
		const edit = {
			remove_from: "wpdmx", remove_to: "wpdmx",
      text: null,
		} as unknown as HTEdit;
		expect(() => resEdit(edit)).toThrow(
      /must be an array of strings/i,
		);
	});

	it("rejects unknown fields", () => {
    const edit = { remove_from: "wpdmx", remove_to: "wpdmx", text: ["x"], extra: true } as any;
		expect(() => resEdit(edit)).toThrow(
			/unknown or unsupported fields/i,
		);
	});

	it("rejects missing text", () => {
		const edit = { remove_from: "wpdmx", remove_to: "wpdmx" } as any;
		expect(() => resEdit(edit)).toThrow(
      /requires a "text" array/i,
		);
	});

	it("strips an anchor│content row pasted into remove_from/remove_to with a warning", () => {
		const edit: HTEdit = { remove_from: "ribbx│const x = 1;", remove_to: "ribbx│const x = 1;", text: ["new"] };
		const warnings: string[] = [];
		const resolved = resEdit(edit, warnings);
		expect(resolved.hash_bounds[0].hash).toBe("ribbx");
		expect(resolved.hash_bounds[1].hash).toBe("ribbx");
		expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^\[W_BAD_REF\]/);
		expect(warnings[0]).toContain('Stripped "anchor│" prefix');
		expect(warnings[0]).toContain("remove_from/remove_to entry");
	});

	it("strips diff-preview rows pasted into remove_from/remove_to with a warning", () => {
		const edit: HTEdit = { remove_from: "+ribbx│const x = 1;", remove_to: "-ribbx│const x = 1;", text: ["new"] };
		const warnings: string[] = [];
		const resolved = resEdit(edit, warnings);
		expect(resolved.hash_bounds[0].hash).toBe("ribbx");
		expect(resolved.hash_bounds[1].hash).toBe("ribbx");
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("diff-preview marker");
		expect(warnings[1]).toContain('leading "-" marker');
	});

	it("leaves bare anchors untouched and emits no warning", () => {
		const edit: HTEdit = { remove_from: "ribbx", remove_to: "ribbx", text: ["new"] };
		const warnings: string[] = [];
		const resolved = resEdit(edit, warnings);
		expect(resolved.hash_bounds[0].hash).toBe("ribbx");
		expect(warnings).toHaveLength(0);
	});

	it("still rejects rows without a leading hash", () => {
		const edit: HTEdit = { remove_from: "│const x = 1;", remove_to: "ribbx", text: ["new"] };
		expect(() => resEdit(edit)).toThrow(/^\[E_BAD_REF\]/);
	});
});
