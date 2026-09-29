import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getUndoEntry, loadHashStore, upsertUndo } from "../../src/hash-store";
import { hashStorePath } from "../../src/paths";
import { useTestHome } from "../support/fixtures";

useTestHome();

describe("undo separators", () => {
	it("round-trips per-line separators", async () => {
		const store = await loadHashStore();
		upsertUndo(store, "/round-trip.ts", {
			content: "a\nb",
			bom: "",
			ending: "\n",
			separators: ["\r\n"],
			hashes: ["ATIm", "BeSR"],
			resultContent: "a\nc",
			resultSeparators: ["\r\n"],
		});
		const entry = getUndoEntry(store, "/round-trip.ts");
		expect(entry?.separators).toEqual(["\r\n"]);
		expect(entry?.resultSeparators).toEqual(["\r\n"]);
	});

	it("omits separators when the row has none", async () => {
		const store = await loadHashStore();
		upsertUndo(store, "/plain.ts", {
			content: "x",
			bom: "",
			ending: "\n",
			hashes: ["ATIm"],
			resultContent: "y",
		});
		const entry = getUndoEntry(store, "/plain.ts");
		expect(entry?.separators).toBeUndefined();
		expect(entry?.resultSeparators).toBeUndefined();
	});

	it("treats a separated list with invalid values as a miss", async () => {
		const store = await loadHashStore();
		upsertUndo(store, "/bad-values.ts", {
			content: "x",
			bom: "",
			ending: "\n",
			hashes: ["ATIm"],
			resultContent: "y",
		});
		const db = new DatabaseSync(hashStorePath(), { defensive: false } as never);
		db.prepare("UPDATE undo SET separators = ? WHERE path = ?").run(JSON.stringify(["X"]), "/bad-values.ts");
		db.close();
		expect(getUndoEntry(store, "/bad-values.ts")).toBeUndefined();
	});

	it("treats a separated list whose count mismatches the content as a miss", async () => {
		const store = await loadHashStore();
		upsertUndo(store, "/bad-length.ts", {
			content: "x",
			bom: "",
			ending: "\n",
			hashes: ["ATIm"],
			resultContent: "y",
		});
		const db = new DatabaseSync(hashStorePath(), { defensive: false } as never);
		db.prepare("UPDATE undo SET result_separators = ? WHERE path = ?").run(JSON.stringify(["\n"]), "/bad-length.ts");
		db.close();
		expect(getUndoEntry(store, "/bad-length.ts")).toBeUndefined();
	});
});
