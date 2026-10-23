# @unrlzd/sdk

TypeScript SDK for trading on NEAR from UNRLZD trading accounts, in your own web page or on your server. It quotes,
runs the guardrails, checks every payload before the device key signs it, and sends the trade from the user's trading
account with your builder code on it. It is the trading core and signer core of the UNRLZD terminal
([unrealized.trade](https://unrealized.trade)) in one package.

Docs: [SDK](https://docs.unrealized.trade/developers/sdk/),
[builder codes](https://docs.unrealized.trade/developers/builder-codes/),
[security model](https://docs.unrealized.trade/developers/security/). Also here: the [example](examples/basic) and the
[changelog](CHANGELOG.md).

## Install

```sh
npm i @unrlzd/sdk
```

## Requirements

- Node.js 24 or later on a server.
- In a browser: WebCrypto Ed25519 and IndexedDB, where the device key is kept.
- Published as ES modules, with type declarations. With TypeScript, set `moduleResolution` to `bundler` or `nodenext`.
- For the owner's wallet: [`@hot-labs/near-connect`](https://www.npmjs.com/package/@hot-labs/near-connect). The
  SDK's `nearConnectWallet` adapts it.

## Quick start

In a page, on mainnet:

```ts
import { NearConnector } from "@hot-labs/near-connect";
import { nearConnectWallet, Unrlzd, type UserPresence } from "@unrlzd/sdk";

// Asks the user before the device key unlocks and before a new withdraw destination is trusted.
const presence: UserPresence = { confirm: async (p) => window.confirm(p.text) };
const sdk = new Unrlzd({ network: "mainnet", presence });

// The owner's NEAR wallet, through near-connect.
const connector = new NearConnector({ network: "mainnet" });
await connector.connect();
const wallet = await connector.wallet();
const [first] = await wallet.getAccounts();
if (!first) throw new Error("no account in the wallet");
const owner = nearConnectWallet(wallet, { accountId: first.accountId, network: "mainnet" });

// Creates the user's trading account, funded from their wallet, or adds this browser's key to it.
const { account } = await sdk.connect(owner, { fundYocto: await sdk.minFunding() });

const q = await account.quote({
  side: "buy",
  token: "blackdragon.tkn.near",
  amount: 2n * 10n ** 22n, // 0.02 NEAR, in yocto (10^24 per NEAR)
  slippage: { type: "Auto", minBps: 50, maxBps: 500 },
});
const { notices, confirms } = await account.guardrails(q);
console.log(notices);
const confirmed = confirms.filter((c) => window.confirm(c)); // ask the user each one
const h = await account.execute(q, { builder: { b: "your-app.near", f: 0 }, confirmed });
if (h.accepted) console.log((await h.done).status); // "filled", "failed" or "unknown"
```

- `amount` is a `bigint` in the smallest units: yocto for a buy's NEAR, the token's own decimals for a sell.
- `slippage` has no default. `{ type: "Fixed", bps }` signs exactly `bps`. `Auto` signs the larger of `minBps` and 4%,
  at most `maxBps`, on a pool route (Rhea classic, DCL, Plach), and `maxBps` on a launchpad curve or a Shards route.
- `connect` creates the account for a new user, in one wallet approval, funded with `fundYocto`. That must be at
  least `await sdk.minFunding()` (0.7 NEAR on mainnet). `sdk.status(owner)` says beforehand what `connect` will ask
  the wallet (`new`, `needs-device` or `ready`) without asking it.
- `execute` refuses a quote until every confirm of `guardrails` is passed back in `confirmed`. It returns
  `{ accepted: false, reason }` when it sent nothing, for example while a trade of the same token and side is still
  running.
- `account.dryRun(q, options)` runs every check of `execute` and returns the terms and ops `execute` would sign,
  without signing or sending anything.

## Quotes without an account

`new Unrlzd({ network })` with no `presence` and no `device` only quotes. `sdk.quote(request)` returns what a new
trading account would be quoted, on the same routes and on-chain checks, with no key and no account:

```ts
import { Unrlzd } from "@unrlzd/sdk";

const sdk = new Unrlzd({ network: "mainnet" });
const q = await sdk.quote({
  side: "buy",
  token: "blackdragon.tkn.near",
  amount: 10n ** 23n, // 0.1 NEAR
  slippage: { type: "Auto", minBps: 50, maxBps: 500 },
});
const { notices, confirms } = sdk.guardrails(q);
```

That quote has no blockers and can't be signed: `execute` and `dryRun` throw `QuoteNotSignable` on it.

## More of the API

- `account.placeLimit(order, { builder })` places a 24/7 order. UNRLZD's executor fires it within its stored terms (token, amount, venues, minimum out).
  `account.orders()` reads the account's orders on chain, and `account.cancelOrder(orderId)` cancels one.
- `account.deposit({ amount, token })` deposits from the owner's NEAR wallet. `account.depositAddress({ asset })`
  gives an address to deposit to from another chain or an exchange.
- `account.withdraw(token, amount)` withdraws to the owner.
- `sdk.feed()` is the live WebSocket feed: typed channels, gaps resynced, reconnects, and each trade once by its id.
  `account.feed()` adds the account's own channels.
- The SDK's notices are not printed: pass `logger: console` to `new Unrlzd` to see them. Refusals and failures are
  still thrown or returned.

Every call, with its options and errors, is on the [SDK page](https://docs.unrealized.trade/developers/sdk/).

## The wallet

`nearConnectWallet` adapts a `@hot-labs/near-connect` wallet. near-connect's type declarations import
`@near-js/transactions` and `@near-js/types` without depending on them: install both beside it if your TypeScript
config doesn't set `skipLibCheck`.

## Server key

On a backend you supply the device key (`ed25519:<base58>`, from your env or secret store). The owner adds its
public half to their trading account from their own wallet first (`owner_add_key`; `buildOwnerAddKeyTx` builds that
transaction). `connect` then takes the owner's account id and asks no wallet anything.

```ts
import { DeviceSigner, Unrlzd } from "@unrlzd/sdk";
import { FileIntentLog } from "@unrlzd/sdk/node";

const secretKey = process.env.UNRLZD_DEVICE_KEY;
if (!secretKey) throw new Error("set UNRLZD_DEVICE_KEY");
const device = await DeviceSigner.fromSecret({
  network: "mainnet",
  secretKey,
  presence: { confirm: async (p) => p.kind === "unlock" }, // your server's policy
});
const intentLog = new FileIntentLog("/var/lib/bot/intents.jsonl");
const { account } = await new Unrlzd({ network: "mainnet", device, intentLog }).connect("alice.near");
```

- The key passes the same signer core and checks as the browser key.
- A server needs a durable `intentLog`: `FileIntentLog` (one process per file) or your own `IntentLog`. The SDK
  refuses a server key without one. The log keeps a trade id from being sent twice after a restart; the contract's
  own check on a repeated id lasts only until the trade's expiry, at most 120 seconds.
- A signer object trades one account, the first it connects. Use one key per trading account: the SDK doesn't check
  keys across signer objects.
- No error, `JSON.stringify` or `util.inspect` of the signer holds the key, but code in the same process can read
  it: the key is as safe as the process and the secret store.
- `fromSecret` never makes a key, and the trading account must exist with the key on it.

## Security model

**Enforced by the trading account contract**, whatever code holds the key:

- A device key can withdraw only to the owner, or to a cross-chain destination the owner registered. It can't add
  keys, raise caps, change the fee or upgrade the contract.
- Every swap pays the trading account itself, never another account.
- The contract calls only the venues on its allowlist.
- The minimum out is part of the signed operation: a fill under it fails on chain.
- A trade id runs once until its expiry, which is at most 120 seconds ahead.

**Checked by the SDK before the device key signs**, in a page and on a server:

- The checked gate: `execute` signs only terms no wider than the quote shown.
- On mainnet, the price is checked against the on-chain pool.
- The signer core checks the payload: a call to the trading account itself, a device method, no deposit, the
  allowlist, output to the account, a short expiry.

These checks run in your page or your process. In a page, the device key is a non-extractable WebCrypto key on your
origin: script can't read it out, but script on that origin can use it. Keep a strict Content-Security-Policy and no
third-party scripts on the page that signs.

**Confirms are advisory.** `guardrails(q)` returns the confirms the terminal would ask on this quote, from the same
function. Pool liquidity and NEAR's price come from the UNRLZD API's token summary, as the terminal reads them. The
SDK can't tell a user's yes from the page's own: a page that passes every confirm back without asking skips them.

`account.client` exposes only reads the account doesn't cover (`config`, `unresolvedIntents`, `warmRoutes`,
`marketPriceOf`). It never exposes a raw `submit`.

The full model is on the [Security model](https://docs.unrealized.trade/developers/security/) page.

## Builder fees

Fee on top will be enabled once our core contract is upgraded. Until then `maxBuilderFee(user, builder)` returns `0`,
and sending `f > 0` or calling `approveBuilderFee` throws `BuilderFeeUnavailable` (`NEEDS_CONTRACT`). Send `f: 0`.

What a builder earns, and how it is paid, is on the [Builder codes](https://docs.unrealized.trade/developers/builder-codes/)
page.

## Example

[`examples/basic`](examples/basic) is a page (connect, quote, buy, sell, a 24/7 order) and a server script, on
`@unrlzd/sdk` from npm, with every trade tagged with your builder code.

## Versioning

`@unrlzd/sdk` follows semantic versioning. Before 1.0, a minor release (0.1 to 0.2) can change the API and a patch
release doesn't, so `^0.1.0` takes patches only. Every release is in the [changelog](CHANGELOG.md).

The SDK reads the account's config, including its contract version, and asks for builder fees only from a version
that supports them.

## Source and verification

This repository holds the documentation, changelog, security policy and example. The SDK's source is not published;
the npm package ships the built ES modules, unminified, with their type declarations.

The trading account and factory contracts the SDK signs for are public, with reproducible builds:
[UNRLZD/contracts](https://github.com/UNRLZD/contracts). Call `contract_source_metadata` (NEP-330) on the factory,
`trade.unrlzd.near`, or on a trading account: it returns the repository and the commit the code was built from.

## Support

- Bugs and questions: [GitHub issues](https://github.com/UNRLZD/sdk/issues).
- Security issues: report them privately, as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE)
