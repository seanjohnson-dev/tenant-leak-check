import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXIT, EXIT_MEANING, combineExitCodes } from "../../src/core/exit-codes.ts";

describe("exit codes", () => {
  it("are the documented, distinct values", () => {
    assert.deepEqual(EXIT, { clean: 0, leaks: 1, inconclusive: 2, toolError: 3, migrationReview: 4 });
    assert.equal(new Set(Object.values(EXIT)).size, Object.values(EXIT).length);
  });

  it("each have a plain-English meaning", () => {
    for (const code of Object.values(EXIT)) {
      assert.ok(EXIT_MEANING[code].length > 20, `missing meaning for ${code}`);
    }
  });
});

describe("combineExitCodes", () => {
  it("is clean when nothing went wrong", () => {
    assert.equal(combineExitCodes([]), EXIT.clean);
    assert.equal(combineExitCodes([EXIT.clean, EXIT.clean]), EXIT.clean);
  });

  it("puts tool errors above everything", () => {
    assert.equal(combineExitCodes([EXIT.leaks, EXIT.toolError, EXIT.inconclusive]), EXIT.toolError);
  });

  it("puts leaks above migration review and inconclusive", () => {
    assert.equal(combineExitCodes([EXIT.inconclusive, EXIT.migrationReview, EXIT.leaks]), EXIT.leaks);
  });

  it("puts migration review above inconclusive", () => {
    assert.equal(combineExitCodes([EXIT.inconclusive, EXIT.migrationReview]), EXIT.migrationReview);
  });

  it("never lets an inconclusive result look clean", () => {
    assert.equal(combineExitCodes([EXIT.clean, EXIT.inconclusive, EXIT.clean]), EXIT.inconclusive);
  });
});
