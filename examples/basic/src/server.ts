/**
 * Server mode (sdk.md "The key on a server"): one quote, a buy and the sell of what it bought, both tagged with
 * your builder account. The owner has added the key's public half to their trading account beforehand
 * (owner_add_key, buildOwnerAddKeyTx).
 *
 *   UNRLZD_DEVICE_KEY=ed25519:... UNRLZD_OWNER=alice.near UNRLZD_BUILDER=you.near \
 *     node src/server.ts [token] [near]
 */
import { checkBuilder, DeviceSigner, Unrlzd } from "@unrlzd/sdk";
import { FileIntentLog } from "@unrlzd/sdk/node";
import { refuseConfirms, trade } from "./flow.ts";
import { nearToYocto } from "./lib.ts";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};
const builder = checkBuilder({ b: env("UNRLZD_BUILDER"), f: 0 });
const token = process.argv[2] ?? "blackdragon.tkn.near";
const buyYocto = nearToYocto(process.argv[3] ?? "0.02");

const device = await DeviceSigner.fromSecret({
  network: "mainnet",
  secretKey: env("UNRLZD_DEVICE_KEY"),
  // the server's own policy: unlock the key, trust no new withdraw destination
  presence: { confirm: async (p) => p.kind === "unlock" },
});
const sdk = new Unrlzd({
  network: "mainnet",
  device,
  intentLog: new FileIntentLog(process.env.UNRLZD_INTENT_LOG ?? "intents-server.jsonl"),
});
const { account } = await sdk.connect(env("UNRLZD_OWNER"));
console.log(`trading account ${account.accountId}, builder ${builder.b}`);

const before = await account.balance(token);
const buy = await trade(
  account,
  { side: "buy", token, amount: buyYocto },
  { builder, accept: refuseConfirms },
);
console.log(
  `buy ${buy.clientOrderId}: ${buy.result?.status ?? buy.rejected} ${buy.result?.txHash ?? ""}`,
);
if (buy.result?.status !== "filled") process.exit(1);

const bought = (await account.balance(token)) - before;
const sell = await trade(
  account,
  { side: "sell", token, amount: bought },
  { builder, accept: refuseConfirms },
);
console.log(
  `sell ${sell.clientOrderId}: ${sell.result?.status ?? sell.rejected} ${sell.result?.txHash ?? ""}`,
);
account.dispose();
process.exit(sell.result?.status === "filled" ? 0 : 1);
