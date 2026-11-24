import { describe, expect, it } from "vitest";
import { loadDeployment } from "./deployments.js";
import { TUSD8_ADDRESS } from "./chains.js";

describe("loadDeployment", () => {
  it("reads the committed Aevum deployment", () => {
    const d = loadDeployment(44005);
    expect(d.chainId).toBe(44005);
    expect(d.tUSD8).toBe(TUSD8_ADDRESS);
    expect(d.AgentVault).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("throws a clear error for an unknown chain", () => {
    expect(() => loadDeployment(1)).toThrow(/No deployment for chain 1/);
  });
});
