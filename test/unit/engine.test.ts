import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyConfig } from "../../src/config/config.ts";
import { buildTenancyModel } from "../../src/discover/tenancy.ts";
import { runLevelProblems } from "../../src/engine.ts";
import { agencyCatalog, catalogOf, col, pk, table } from "./fixtures.ts";

describe("run-level problems (the positive control)", () => {
  const tenancy = buildTenancyModel(agencyCatalog(), emptyConfig());

  it("is fine when tenant A can read its own rows somewhere", () => {
    assert.deepEqual(runLevelProblems(tenancy, [{ table: "public.invoices", ownRowVisible: true }, { table: "public.notes", ownRowVisible: false }]), []);
  });

  it("marks the run unreliable when tenant A can read nothing of its own", () => {
    const problems = runLevelProblems(tenancy, [{ table: "public.invoices", ownRowVisible: false }, { table: "public.notes", ownRowVisible: false }]);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? "", /could not read its own rows in any table/);
  });

  it("marks the run unreliable when no table belongs to a tenant or user", () => {
    const shared = buildTenancyModel(catalogOf([table("public.plans", [col("code", "text")], [pk("code")])]), emptyConfig());
    assert.match(runLevelProblems(shared, []).join(" "), /no customer data to test isolation on/);
  });
});
