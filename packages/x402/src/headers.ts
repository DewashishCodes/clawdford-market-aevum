import type { z } from "zod";

/** x402 v2 HTTP header names (transports-v2/http.md). Header lookups are case-insensitive. */
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

/** CAIP-2 network id, e.g. `eip155:44005`. */
export const networkOf = (chainId: number) => `eip155:${chainId}`;

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** Decodes base64 JSON (standard or URL-safe) and validates it. Throws on bad input. */
export function decodeHeader<S extends z.ZodType>(schema: S, header: string): z.infer<S> {
  return schema.parse(JSON.parse(Buffer.from(header, "base64").toString("utf8")));
}
