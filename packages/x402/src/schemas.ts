import { z } from "zod";
import type { Address, Hex } from "viem";

/** x402 v2, see docs/QDAY_NOTES.md. Our payloads differ from stock x402, see D11 in docs/DECISIONS.md. */
export const X402_VERSION = 2;

const uint = z.string().regex(/^\d+$/, "expected a decimal string");
const address = z.custom<Address>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v), "expected an address");
const bytes32 = z.custom<Hex>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v), "expected bytes32");
const signature = z.custom<Hex>((v) => typeof v === "string" && /^0x([0-9a-fA-F]{2})+$/.test(v), "expected hex");
const network = z.string().regex(/^eip155:\d+$/, "expected a CAIP-2 eip155 network");

// ------------------------------------------------------------------ signed vault messages (wire form)

export const Quote = z.object({
  stallId: uint,
  amount: uint,
  resourceHash: bytes32,
  buyerSession: uint,
  validBefore: uint,
  quoteNonce: bytes32,
});
export const PaymentIntent = z.object({ quoteHash: bytes32, sessionId: uint, validBefore: uint, nonce: uint });
export const OpenChannel = z.object({ sessionId: uint, stallId: uint, deposit: uint, validBefore: uint, nonce: uint });
export const TopUp = z.object({ channelId: uint, amount: uint, validBefore: uint, nonce: uint });
export const Voucher = z.object({ channelId: uint, cumulativeAmount: uint });
export const CreateTask = z.object({
  sessionId: uint,
  stallId: uint,
  amount: uint,
  specHash: bytes32,
  deadline: uint,
  validBefore: uint,
  nonce: uint,
});

// ------------------------------------------------------------------ payment requirements (one per scheme)

const common = {
  network,
  /** tUSD8 base units (6 decimals). For batch-settlement: the price of one unit. */
  amount: uint,
  asset: address,
  payTo: address,
  maxTimeoutSeconds: z.number().int().positive(),
};
const commonExtra = { vault: address, stallId: uint, facilitator: z.url().optional() };

export const ExactRequirements = z.object({
  scheme: z.literal("exact"),
  ...common,
  extra: z.object({ ...commonExtra, quote: Quote, quoteSig: signature }),
});
export const StreamRequirements = z.object({
  scheme: z.literal("batch-settlement"),
  ...common,
  /** `maxAmount`: the most this one request can cost; the channel must have that much headroom. */
  extra: z.object({ ...commonExtra, unit: z.string(), minDeposit: uint, maxAmount: uint }),
});
export const EscrowRequirements = z.object({
  scheme: z.literal("escrow"),
  ...common,
  extra: z.object({ ...commonExtra, specHash: bytes32.optional(), deadlineSeconds: z.number().int().positive().optional() }),
});
export const PaymentRequirements = z.discriminatedUnion("scheme", [
  ExactRequirements,
  StreamRequirements,
  EscrowRequirements,
]);

export const ResourceInfo = z.object({
  url: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});

/** Body of the `PAYMENT-REQUIRED` header on a 402. */
export const PaymentRequired = z.object({
  x402Version: z.literal(X402_VERSION),
  error: z.string().optional(),
  resource: ResourceInfo,
  accepts: z.array(PaymentRequirements).min(1),
});

// ------------------------------------------------------------------ payment payloads (one per scheme)

const envelope = { x402Version: z.literal(X402_VERSION), resource: ResourceInfo.optional() };

export const ExactPayload = z.object({
  ...envelope,
  accepted: ExactRequirements,
  payload: z.object({ intent: PaymentIntent, signature }),
});
export const StreamPayload = z.object({
  ...envelope,
  accepted: StreamRequirements,
  payload: z.discriminatedUnion("action", [
    z.object({ action: z.literal("open"), open: OpenChannel, signature }),
    z.object({ action: z.literal("topUp"), topUp: TopUp, signature }),
    z.object({ action: z.literal("voucher"), voucher: Voucher, signature }),
  ]),
});
export const EscrowPayload = z.object({
  ...envelope,
  accepted: EscrowRequirements,
  payload: z.object({ task: CreateTask, signature }),
});
/** Body of the `PAYMENT-SIGNATURE` header. */
export const PaymentPayload = z.union([ExactPayload, StreamPayload, EscrowPayload]);

// ------------------------------------------------------------------ facilitator API

export const FacilitatorRequest = z.object({
  x402Version: z.literal(X402_VERSION),
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
});

export const VerifyResponse = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  payer: address.optional(),
});

/** Body of the `PAYMENT-RESPONSE` header and of `/settle`. The id fields are our additions. */
export const SettlementResponse = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  payer: address.optional(),
  transaction: z.string(),
  network,
  amount: uint.optional(),
  receiptId: uint.optional(),
  channelId: uint.optional(),
  taskId: uint.optional(),
  /** Stream only: the channel's total metered cost so far; the next voucher must cover it. */
  owed: uint.optional(),
});

/** Facilitator `/claim`: relay a seller's voucher claim (the facilitator pays the gas). */
export const ClaimRequest = z.object({ voucher: Voucher, signature });
/** Facilitator `/close`: start the close with the agent's CloseChannel signature, or finalize after the window. */
export const CloseRequest = z.object({ channelId: uint, signature: signature.optional() });

/**
 * Seller agent card, served at the identity's on-chain `agentCardURI`. Buyers check that `payee` matches the quote
 * and the stall's registered payee (Confirmation of Payee) and that the stall is listed.
 */
export const AgentCard = z.object({
  name: z.string(),
  description: z.string().optional(),
  chainId: z.number().int(),
  payee: address,
  stallIds: z.array(uint),
});

export const SupportedResponse = z.object({
  kinds: z.array(z.object({ x402Version: z.number(), scheme: z.string(), network, extra: z.record(z.string(), z.unknown()).optional() })),
  extensions: z.array(z.string()),
  signers: z.record(z.string(), z.array(address)),
});

export type Quote = z.infer<typeof Quote>;
export type PaymentIntent = z.infer<typeof PaymentIntent>;
export type OpenChannel = z.infer<typeof OpenChannel>;
export type TopUp = z.infer<typeof TopUp>;
export type Voucher = z.infer<typeof Voucher>;
export type CreateTask = z.infer<typeof CreateTask>;
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;
export type ExactRequirements = z.infer<typeof ExactRequirements>;
export type PaymentRequired = z.infer<typeof PaymentRequired>;
export type PaymentPayload = z.infer<typeof PaymentPayload>;
export type FacilitatorRequest = z.infer<typeof FacilitatorRequest>;
export type VerifyResponse = z.infer<typeof VerifyResponse>;
export type SettlementResponse = z.infer<typeof SettlementResponse>;
export type SupportedResponse = z.infer<typeof SupportedResponse>;
export type StreamRequirements = z.infer<typeof StreamRequirements>;
export type EscrowRequirements = z.infer<typeof EscrowRequirements>;
export type ClaimRequest = z.infer<typeof ClaimRequest>;
export type CloseRequest = z.infer<typeof CloseRequest>;
export type AgentCard = z.infer<typeof AgentCard>;
