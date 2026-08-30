import { describe, it, expect } from "vitest";
import { createServer } from "../server.js";
import { getToolRegistry } from "../toolWrapper.js";
import { CATALOG_METADATA, FALLBACK_CATEGORY } from "./catalog.js";

describe("tool catalog + registry", () => {
  it("registers 73 tools and every name has curated catalog metadata", () => {
    createServer();
    const registry = getToolRegistry();
    expect(registry.map((t) => t.name).sort()).toEqual([...new Set(registry.map((t) => t.name))].sort());
    expect(registry).toHaveLength(73);

    const missing = registry
      .filter((entry) => {
        const meta = CATALOG_METADATA[entry.name];
        return !meta || meta.category === FALLBACK_CATEGORY;
      })
      .map((entry) => entry.name);

    expect(missing).toEqual([]);
    expect(registry.some((t) => t.name === "whalescope_risk_circuit")).toBe(true);
    expect(registry.some((t) => t.name === "whalescope_find_grid_walls")).toBe(true);
  });
});
