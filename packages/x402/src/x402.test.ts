import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  PaymentPayload,
  PaymentRequired,
  decodeHeader,
  encodeHeader,
  hashVaultMessage,
  vaultDomain,
  vaultTypedData,
  vaultTypes,
  type PaymentRequired as PaymentRequiredT,
} from "./index.js";

const VAULT = "0x88f4CceafDF6c90664117CC8E0A3bB3C4C275BBE";
const TOKEN = "0x456569838f1d43009A91ebA4263147Afd7233483";
const seller = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const domain = vaultDomain(44005, VAULT);

const quote = {
  stallId: "1",
  amount: "10000",
  resourceHash: `0x${"ab".repeat(32)}`,
  buyerSession: "0",
  validBefore: "1800000000",
  quoteNonce: `0x${"01".repeat(32)}`,
} as const;

function required(): PaymentRequiredT {
  return {
    x402Version: 2,
    resource: { url: "https://stall.example/translate", description: "Translate text, 0.01 tUSD8 per call" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:44005",
        amount: "10000",
        asset: TOKEN,
        payTo: seller.address,
        maxTimeoutSeconds: 60,
        extra: { vault: VAULT, stallId: "1", quote, quoteSig: "0x1234" },
      },
    ],
  };
}

describe("vault EIP-712 types", () => {
  const sources = ["VaultBase", "VaultChannels", "VaultTasks"]
    .map((f) => readFileSync(new URL(`../../../contracts/src/vault/${f}.sol`, import.meta.url), "utf8"))
    .join("\n");

  it.each(Object.keys(vaultTypes))("%s matches the contract typehash string", (name) => {
    const fields = vaultTypes[name as keyof typeof vaultTypes].map((f) => `${f.type} ${f.name}`).join(",");
    expect(sources).toContain(`"${name}(${fields})"`);
  });

  it("signatures over a quote recover to the seller", async () => {
    const td = vaultTypedData(domain, "Quote", quote);
    const sig = await seller.signTypedData(td);
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(seller.address);
  });

  it("hash depends on chain id and vault", () => {
    const h = hashVaultMessage(domain, "Quote", quote);
    expect(hashVaultMessage(vaultDomain(440050, VAULT), "Quote", quote)).not.toBe(h);
    expect(hashVaultMessage(vaultDomain(44005, TOKEN), "Quote", quote)).not.toBe(h);
  });

  it("throws when a field is missing", () => {
    expect(() => vaultTypedData(domain, "Voucher", { channelId: "1" })).toThrow(/cumulativeAmount missing/);
  });
});

describe("headers", () => {
  it("round trips PAYMENT-REQUIRED", () => {
    const v = required();
    expect(decodeHeader(PaymentRequired, encodeHeader(v))).toEqual(v);
  });

  it("accepts URL-safe base64", () => {
    const h = encodeHeader(required()).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(decodeHeader(PaymentRequired, h).accepts).toHaveLength(1);
  });

  it("rejects a v1 payload, a wrong scheme payload and garbage", () => {
    expect(() => decodeHeader(PaymentRequired, encodeHeader({ ...required(), x402Version: 1 }))).toThrow();
    const accepted = required().accepts[0];
    // exact requirements with a stream payload
    const mixed = { x402Version: 2, accepted, payload: { action: "voucher", voucher: { channelId: "1", cumulativeAmount: "5" }, signature: "0x12" } };
    expect(() => decodeHeader(PaymentPayload, encodeHeader(mixed))).toThrow();
    expect(() => decodeHeader(PaymentPayload, "not base64 json")).toThrow();
  });

  it("rejects non-decimal amounts", () => {
    const v = required();
    v.accepts[0]!.amount = "1e6";
    expect(() => PaymentRequired.parse(v)).toThrow(/decimal/);
  });
});
