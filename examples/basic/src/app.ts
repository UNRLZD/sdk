/**
 * The page (sdk.md "Calls"): connect the owner's NEAR wallet (near-connect), quote, buy, sell, and place and cancel
 * one 24/7 order, every trade and order tagged with your builder account.
 *
 *   VITE_BUILDER=you.near [VITE_NETWORK=testnet] pnpm dev
 */
import { NearConnector } from "@hot-labs/near-connect";
import { type Account, checkBuilder, nearConnectWallet, Unrlzd } from "@unrlzd/sdk";
import { placeRestingBuy, quoteWithGuards, send } from "./flow.ts";
import { formatUnits, nearToYocto } from "./lib.ts";

const NETWORK = import.meta.env.VITE_NETWORK === "testnet" ? "testnet" : "mainnet";
const builder = checkBuilder({ b: import.meta.env.VITE_BUILDER, f: 0 });
const explorer = NETWORK === "testnet" ? "https://testnet.nearblocks.io" : "https://nearblocks.io";

const el = (id: string) => document.getElementById(id) as HTMLInputElement;
const val = (id: string) => el(id).value.trim();
const log = (line: string) => {
  el("out").textContent += `${line}\n`;
};
const tx = (hash?: string) => (hash ? `${explorer}/txns/${hash}` : "");
/** the user answers each confirm the terminal would ask */
const ask = async (confirms: string[]) => confirms.filter((c) => window.confirm(c));

const sdk = new Unrlzd({
  network: NETWORK,
  presence: { confirm: async (p) => window.confirm(p.text) },
});
let account: Account | undefined;
let orderId: string | undefined;
const connected = () => {
  if (!account) throw new Error("connect first");
  return account;
};

const on = (id: string, run: () => Promise<void>) =>
  el(id).addEventListener("click", () => run().catch((e) => log(`${id}: ${(e as Error).message}`)));

on("connect", async () => {
  const connector = new NearConnector({ network: NETWORK });
  await connector.connect();
  const wallet = await connector.wallet();
  const [first] = await wallet.getAccounts();
  if (!first) throw new Error("no account in the wallet");
  const owner = nearConnectWallet(wallet, { accountId: first.accountId, network: NETWORK });
  // a new user's account is created with the factory's minimum funding (0.7 NEAR on mainnet), from their wallet
  ({ account } = await sdk.connect(owner, { fundYocto: await sdk.minFunding() }));
  el("account").textContent = account.accountId;
  for (const id of ["quote", "buy", "sell", "place"]) el(id).disabled = false;
});

on("quote", async () => {
  const a = connected();
  const token = val("token");
  const { quote, guards } = await quoteWithGuards(a, {
    side: "buy",
    token,
    amount: nearToYocto(val("amount")),
  });
  const d = (await a.client.marketPriceOf(token))?.decimals;
  const units = (raw: bigint) => (d === undefined ? `${raw} raw` : formatUnits(raw, d));
  log(
    `quote ${val("amount")} N → ${units(quote.expectedOut)} (min ${units(quote.minOut)}), impact ${quote.impactBps} bps`,
  );
  for (const line of [...guards.notices, ...guards.confirms]) log(`  ${line}`);
});

const trade = async (side: "buy" | "sell", amount: bigint) => {
  const a = connected();
  const { quote, guards } = await quoteWithGuards(a, { side, token: val("token"), amount });
  const s = await send(a, quote, guards.confirms, { builder, accept: ask });
  log(
    `${side} ${s.clientOrderId ?? ""}: ${s.result?.status ?? s.rejected} ${tx(s.result?.txHash)}`,
  );
};
on("buy", () => trade("buy", nearToYocto(val("amount"))));
// sells all of the token the account holds
on("sell", async () => trade("sell", await connected().balance(val("token"))));

on("place", async () => {
  const o = await placeRestingBuy(connected(), val("token"), Number(val("amount")), builder);
  orderId = o.orderId;
  el("cancel").disabled = false;
  log(`24/7 order ${o.orderId}: ${tx(o.txHash)}`);
});
on("cancel", async () => {
  if (!orderId) return;
  const c = await connected().cancelOrder(orderId);
  log(`cancel ${orderId}: ${c.ok ? "ok" : c.failure} ${tx(c.txHash)}`);
});
