/**
 * The SDK calls the page and the server script share: one trade (quote, guardrails, execute with the builder) and one
 * 24/7 order. Each is the docs' own sequence (sdk.md "Calls", builder-codes.md).
 */
import type { Account, Builder, GuardResult, Quote, Slippage, TradeResult } from "@unrlzd/sdk";

/** auto slippage: 0.5% to 5% */
export const SLIPPAGE: Slippage = { type: "Auto", minBps: 50, maxBps: 500 };

/** the confirms the user (or the server's policy) accepts; execute refuses the quote until all of them are passed */
export type Accept = (confirms: string[]) => Promise<string[]>;

/** A server has nobody to ask: it stops on any confirm. */
export const refuseConfirms: Accept = async (c) => {
  if (c.length > 0) throw new Error(`the quote needs a yes: ${c.join(" | ")}`);
  return [];
};

/** `amount`: a buy's NEAR in yocto, a sell's token in raw units */
export async function quoteWithGuards(
  account: Account,
  r: { side: "buy" | "sell"; token: string; amount: bigint },
): Promise<{ quote: Quote; guards: GuardResult }> {
  const quote = await account.quote({ ...r, slippage: SLIPPAGE });
  if (quote.blockers.length > 0)
    throw new Error(`the quote can't trade: ${quote.blockers.map((b) => b.message).join("; ")}`);
  return { quote, guards: await account.guardrails(quote) };
}

export interface Sent {
  clientOrderId?: string;
  result?: TradeResult;
  /** the SDK did not take the trade (another trade of the same token and side in flight, ...) */
  rejected?: string;
}

export async function send(
  account: Account,
  quote: Quote,
  confirms: string[],
  o: { builder: Builder; accept: Accept },
): Promise<Sent> {
  const confirmed = await o.accept(confirms);
  const h = await account.execute(quote, { builder: o.builder, confirmed });
  if (!h.accepted) return { rejected: h.reason };
  return { clientOrderId: h.clientOrderId, result: await h.done };
}

export async function trade(
  account: Account,
  r: { side: "buy" | "sell"; token: string; amount: bigint },
  o: { builder: Builder; accept: Accept },
): Promise<Sent & { quote: Quote }> {
  const { quote, guards } = await quoteWithGuards(account, r);
  return { quote, ...(await send(account, quote, guards.confirms, o)) };
}

/** a 24/7 limit buy `underPct` under the market, so it rests until it is cancelled */
export async function placeRestingBuy(
  account: Account,
  token: string,
  sizeNear: number,
  builder: Builder,
  underPct = 20,
): Promise<{ orderId: string; txHash?: string; triggerMeta: string }> {
  const market = await account.client.marketPriceOf(token);
  if (!market) throw new Error(`no market price for ${token}`);
  const limitPriceNear = market.priceNear * (1 - underPct / 100);
  return account.placeLimit(
    { token, side: "buy", limitPriceNear, sizeNear, slippageBps: 300 },
    { builder },
  );
}
