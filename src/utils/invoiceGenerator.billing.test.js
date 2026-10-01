import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors the real src/api.js names: api.documents.list / generate / remove (shipment documents),
// api.chargeCodes.list, api.costLines.create.
const documents = { list: vi.fn(), generate: vi.fn(), remove: vi.fn() };
vi.mock("../api", () => ({
  api: {
    documents: { list: (...a) => documents.list(...a), generate: (...a) => documents.generate(...a), remove: (...a) => documents.remove(...a) },
    chargeCodes: { list: async () => [] },
    costLines: { create: async () => ({}) },
  },
}));

import { generateInvoices, billableSellLines, alreadyBilledSummary } from "./invoiceGenerator";

// One SELL line, one live billing document (TKT-2F19XD): Invoice Entry leaves out a line another
// invoice, credit note or statement already holds (cost line billedOn), except the draft a
// regenerate is about to replace.
const shipment = { id: "SHP-TEST02", pol: "NLRTM", pod: "USNYC", principalName: "Veldhoven Office Supplies B.V." };
const sell = (id, chargeCode, billedOn = null, over = {}) => ({ id, type: "SELL", chargeCode, currency: "USD", amount: 100, vatRate: 0, billedOn, ...over });
const onStatement = { kind: "statement", id: "STMT-AAA111", docType: "STMT", status: "confirmed", label: "STMT-AAA111" };
const onDraft = { kind: "invoice", id: "DOC-DRAFT1", docType: "FR01", status: "draft", label: "FR01-old.pdf" };
const onConfirmed = { kind: "invoice", id: "DOC-CONF1", docType: "FR01", status: "confirmed", label: "FR01-issued.pdf" };

beforeEach(() => {
  documents.list.mockReset(); documents.generate.mockReset(); documents.remove.mockReset();
  documents.generate.mockImplementation(async (_sid, body) => ({ id: "DOC-NEW", ...body }));
  documents.remove.mockResolvedValue({ ok: true });
});

describe("billableSellLines", () => {
  it("keeps unbilled SELL lines and drops BUY lines", () => {
    const out = billableSellLines([sell("CL-1", "Ocean Freight"), { ...sell("CL-2", "Trucking"), type: "BUY" }]);
    expect(out.map(l => l.id)).toEqual(["CL-1"]);
  });

  it("drops a line on a statement, a confirmed invoice or another draft", () => {
    const lines = [sell("CL-1", "Ocean Freight", onStatement), sell("CL-2", "THC", onConfirmed), sell("CL-3", "Docs", onDraft), sell("CL-4", "Cleaning")];
    expect(billableSellLines(lines).map(l => l.id)).toEqual(["CL-4"]);
  });

  it("keeps a line on the draft being replaced", () => {
    const lines = [sell("CL-3", "Docs", onDraft), sell("CL-1", "Ocean Freight", onStatement)];
    expect(billableSellLines(lines, "DOC-DRAFT1").map(l => l.id)).toEqual(["CL-3"]);
  });

  it("summarises where the billed lines are", () => {
    expect(alreadyBilledSummary([sell("CL-1", "Ocean Freight", onStatement), sell("CL-2", "THC", onConfirmed), sell("CL-4", "Cleaning")]))
      .toBe("Ocean Freight on STMT-AAA111, THC on FR01-issued.pdf");
  });
});

describe("generateInvoices", () => {
  it("bills only the lines no other document holds, and records exactly those", async () => {
    documents.list.mockResolvedValue([]);
    const costLines = [sell("CL-1", "Ocean Freight", onStatement), sell("CL-2", "THC", onConfirmed), sell("CL-4", "Cleaning")];
    await generateInvoices(shipment, { costLines });
    expect(documents.generate).toHaveBeenCalledTimes(1);
    const body = documents.generate.mock.calls[0][1];
    expect(body.sourceCostLineIds).toEqual(["CL-4"]);
    expect(body.html).toContain("Cleaning");
    expect(body.html).not.toContain("Ocean Freight");
  });

  it("regenerating replaces the draft and keeps its lines", async () => {
    documents.list.mockResolvedValue([{ id: "DOC-DRAFT1", docType: "FR01", status: "draft", containerId: "" }]);
    await generateInvoices(shipment, { costLines: [sell("CL-3", "Docs", onDraft), sell("CL-4", "Cleaning")] });
    expect(documents.remove).toHaveBeenCalledWith("SHP-TEST02", "DOC-DRAFT1");
    expect(documents.generate.mock.calls[0][1].sourceCostLineIds).toEqual(["CL-3", "CL-4"]);
  });

  it("refuses with a clear message when every charge is already billed — nothing is deleted or created", async () => {
    documents.list.mockResolvedValue([]);
    await expect(generateInvoices(shipment, { costLines: [sell("CL-1", "Ocean Freight", onStatement)] }))
      .rejects.toThrow("Every charge on this shipment is already billed — Ocean Freight on STMT-AAA111.");
    expect(documents.generate).not.toHaveBeenCalled();
    expect(documents.remove).not.toHaveBeenCalled();
  });

  it("per container: skips a container whose charges are all billed and bills the others", async () => {
    documents.list.mockResolvedValue([]);
    const containers = [{ id: "CTR-1", containerNumber: "MSKU1234565" }, { id: "CTR-2", containerNumber: "MSKU7654321" }];
    const costLines = [sell("CL-1", "Ocean Freight", onStatement, { containerId: "CTR-1" }), sell("CL-2", "Ocean Freight", null, { containerId: "CTR-2" })];
    const out = await generateInvoices(shipment, { containers, costLines, splitPerContainer: true });
    expect(out).toHaveLength(1);
    expect(documents.generate.mock.calls[0][1]).toMatchObject({ containerId: "CTR-2", sourceCostLineIds: ["CL-2"] });
  });
});
