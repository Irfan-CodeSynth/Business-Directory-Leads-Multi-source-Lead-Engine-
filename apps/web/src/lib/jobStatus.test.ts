import { describe, expect, it } from "vitest";
import { dedupKpi } from "./jobStatus";

describe("dedupKpi", () => {
  it("counts the listings that produced no new row, whether recognised or joined", () => {
    expect(dedupKpi({ leadsSkipped: 1, leadsMerged: 3, requestsUsed: 2 }).value).toBe(4);
  });

  it("says which of them were already known and which were merged into a lead you had", () => {
    expect(dedupKpi({ leadsSkipped: 1, leadsMerged: 3, requestsUsed: 2 })).toMatchObject({
      caption: "1 already known · 3 joined to a lead you had · 2 requests used",
    });
  });

  it("keeps the plain wording when nothing merged", () => {
    expect(dedupKpi({ leadsSkipped: 2, leadsMerged: 0, requestsUsed: 1 })).toMatchObject({
      value: 2,
      caption: "Already known — skipped at 1 request used",
    });
  });

  it("still describes a run that recognised nothing", () => {
    expect(dedupKpi({ leadsSkipped: 0, leadsMerged: 0, requestsUsed: 0 })).toMatchObject({
      value: 0,
      caption: "Already known — skipped at 0 requests used",
    });
  });
});
