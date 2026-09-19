import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import * as local from "./localTableQuery";

// localTableQuery.js is the browser twin of lib/tableQuery.js. The whole point is that the two behave
// IDENTICALLY, so almost every test here feeds the same input to both and requires the same answer, and
// then also pins that answer against what a person would expect — a test that only compared the two
// would pass if both were wrong the same way.
const server = createRequire(import.meta.url)("../../lib/tableQuery.js");

const ROWS = [
  { id: "A", name: "Smith & Sons, Ltd.", status: "Draft", tags: ["x", "y"], qty: "10", date: "2026-03-01" },
  { id: "B", name: "acme trading",       status: "Sent",  tags: ["y"],      qty: "9",  date: "" },
  { id: "C", name: "",                    status: "Draft", tags: [],         qty: "100", date: "2026-01-15" },
  { id: "D", name: "Zed Co",             status: "",      tags: ["z"],      qty: "2",  date: "2027-01-01" },
];
const COLUMNS = {
  name:   r => r.name,
  status: r => r.status,
  tags:   r => r.tags,   // multi-valued
  qty:    r => r.qty,
};
const ids = rows => rows.map(r => r.id).join("");

// same call through both implementations; they must agree, and the shared answer is returned
const both = (fn, ...args) => {
  const s = server[fn](...args), l = local[fn](...args);
  expect(l).toEqual(s);
  return l;
};

describe("applyColumnFilters — identical on both sides", () => {
  it("absent param = no filter; a single value or an array filters; OR within a column", () => {
    expect(ids(both("applyColumnFilters", ROWS, {}, COLUMNS))).toBe("ABCD");
    expect(ids(both("applyColumnFilters", ROWS, { status: "Draft" }, COLUMNS))).toBe("AC");
    expect(ids(both("applyColumnFilters", ROWS, { status: ["Draft", "Sent"] }, COLUMNS))).toBe("ABC");
  });

  it("an EMPTY selection shows nothing — it is not the same as no filter", () => {
    expect(ids(both("applyColumnFilters", ROWS, { status: [] }, COLUMNS))).toBe("");
    expect(ids(both("applyColumnFilters", ROWS, { status: "" }, COLUMNS))).toBe("");   // the wire's bare `?status=`
  });

  it("a value containing a comma matches as ONE value", () => {
    expect(ids(both("applyColumnFilters", ROWS, { name: "Smith & Sons, Ltd." }, COLUMNS))).toBe("A");
  });

  it("matching is exact and case-sensitive; a blank cell never matches a selection", () => {
    expect(ids(both("applyColumnFilters", ROWS, { name: "ACME TRADING" }, COLUMNS))).toBe("");
    expect(ids(both("applyColumnFilters", ROWS, { status: ["Draft", "Sent"] }, COLUMNS))).not.toContain("D");
  });

  it("columns AND together", () => {
    expect(ids(both("applyColumnFilters", ROWS, { status: "Draft", name: "Smith & Sons, Ltd." }, COLUMNS))).toBe("A");
    expect(ids(both("applyColumnFilters", ROWS, { status: "Sent", name: "Smith & Sons, Ltd." }, COLUMNS))).toBe("");
  });

  it("a multi-valued cell matches when ANY of its values is selected; an empty one matches no selection", () => {
    expect(ids(both("applyColumnFilters", ROWS, { tags: "y" }, COLUMNS))).toBe("AB");
    expect(ids(both("applyColumnFilters", ROWS, { tags: ["x", "z"] }, COLUMNS))).toBe("AD");
    expect(ids(both("applyColumnFilters", ROWS, { tags: ["x", "y", "z"] }, COLUMNS))).not.toContain("C");
  });

  it("ignores query keys that are not columns", () => {
    expect(ids(both("applyColumnFilters", ROWS, { search: "x", sort: "y", limit: 5, nonsense: "q" }, COLUMNS))).toBe("ABCD");
  });
});

describe("filterOptions — identical on both sides", () => {
  it("distinct, numeric-aware sorted, blanks never offered, multi-valued cells flattened", () => {
    const o = both("filterOptions", ROWS, COLUMNS);
    expect(o.qty).toEqual(["2", "9", "10", "100"]);          // numeric-aware: 9 before 10
    expect(o.status).toEqual(["Draft", "Sent"]);              // the blank status is not an option
    expect(o.name).not.toContain("");
    expect(o.tags).toEqual(["x", "y", "z"]);                  // each value once, not "x,y"
  });

  it("caps a column at maxOptions and names it in `truncated`", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ v: `v${String(i).padStart(2, "0")}` }));
    const o = both("filterOptions", many, { v: r => r.v }, { maxOptions: 10 });
    expect(o.v).toHaveLength(10);
    expect(o.truncated).toEqual({ v: true });
  });
});

describe("applySearch — identical on both sides", () => {
  const text = r => [r.name, r.status].join(" ");
  it("case-insensitive substring; blank or whitespace-only term is no search", () => {
    expect(ids(both("applySearch", ROWS, "ACME", text))).toBe("B");
    expect(ids(both("applySearch", ROWS, "  draft ", text))).toBe("AC");
    expect(ids(both("applySearch", ROWS, "", text))).toBe("ABCD");
    expect(ids(both("applySearch", ROWS, "   ", text))).toBe("ABCD");
    expect(ids(both("applySearch", ROWS, undefined, text))).toBe("ABCD");
    expect(ids(both("applySearch", ROWS, "no-such-thing", text))).toBe("");
  });
});

describe("applySort / blanksLast — identical on both sides", () => {
  it("an unknown or absent sort key leaves the incoming order alone", () => {
    const sorters = { name: server.blanksLast(r => r.name) };
    expect(ids(both("applySort", ROWS, "nonsense", sorters))).toBe("ABCD");
    expect(ids(both("applySort", ROWS, undefined, sorters))).toBe("ABCD");
  });

  it("blanks sort LAST whether ascending or descending", () => {
    const asc = ids(local.applySort(ROWS, "d", { d: local.blanksLast(r => r.date) }));
    const desc = ids(local.applySort(ROWS, "d", { d: local.blanksLast(r => r.date, { desc: true }) }));
    expect(asc).toBe("CADB");    // 2026-01-15, 2026-03-01, 2027-01-01, then the blank
    expect(desc).toBe("DACB");   // 2027-01-01, 2026-03-01, 2026-01-15, then the blank
    expect(ids(server.applySort(ROWS, "d", { d: server.blanksLast(r => r.date) }))).toBe(asc);
    expect(ids(server.applySort(ROWS, "d", { d: server.blanksLast(r => r.date, { desc: true }) }))).toBe(desc);
  });

  it("does not mutate its input", () => {
    const copy = [...ROWS];
    local.applySort(ROWS, "d", { d: local.blanksLast(r => r.date) });
    expect(ROWS).toEqual(copy);
  });
});

describe("paginate — identical on both sides", () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ id: i }));
  it("defaults to 50, caps at 200, never goes below offset 0, tolerates junk", () => {
    expect(both("paginate", many, {}).results).toHaveLength(50);
    expect(both("paginate", many, { limit: 5000 }).limit).toBe(200);
    expect(both("paginate", many, { limit: 20, offset: 100 }).results).toHaveLength(20);
    expect(both("paginate", many, { limit: 20, offset: 110 }).results).toHaveLength(10);
    expect(both("paginate", many, { offset: -30 }).offset).toBe(0);
    expect(both("paginate", many, { limit: "abc", offset: "xyz" })).toMatchObject({ limit: 50, offset: 0, total: 120 });
    expect(both("paginate", many, undefined).total).toBe(120);
  });
});

describe("queryRows — the whole pipeline, checked against the server's steps composed by hand", () => {
  const spec = { columns: COLUMNS, searchText: r => [r.name, r.status].join(" "), sorters: { name: local.blanksLast(r => r.name) } };
  const serverPipeline = (rows, params) => {
    let out = server.applyColumnFilters(rows, params, COLUMNS);
    out = server.applySearch(out, params.search, spec.searchText);
    out = server.applySort(out, params.sort, { name: server.blanksLast(r => r.name) });
    return server.paginate(out, params);
  };
  const cases = [
    {},
    { status: ["Draft"] },
    { status: [] },
    { status: ["Draft", "Sent"], search: "s", sort: "name" },
    { tags: ["y"], sort: "name", limit: 1, offset: 1 },
    { search: "co", sort: "nonsense", limit: 2 },
  ];
  it.each(cases.map(c => [JSON.stringify(c), c]))("params %s", (_label, params) => {
    expect(local.queryRows(ROWS, params, spec)).toEqual(serverPipeline(ROWS, params));
  });

  it("works without a search function or sorters", () => {
    expect(local.queryRows(ROWS, { status: "Draft", search: "ignored" }, { columns: COLUMNS }).results.map(r => r.id).join("")).toBe("AC");
  });
});

describe("the one intended difference: null means 'no filter' on the client", () => {
  it("client treats null as absent; the server would read it as the literal value 'null'", () => {
    expect(ids(local.applyColumnFilters(ROWS, { status: null }, COLUMNS))).toBe("ABCD");
    expect(ids(server.applyColumnFilters(ROWS, { status: null }, COLUMNS))).toBe("");
  });
});
