# Changelog

Every release of `@unrlzd/sdk` on npm, newest first. Versions follow [semantic versioning](https://semver.org); before
1.0, a minor release can change the API.

## 0.1.2 (2026-10-29)

Fewer paid reads, complete key reads, and quotes checked on the SDK's own on-chain reads. No export was added or removed. Five exported types gained a field or a value:

- `RpcEndpoint`: new optional field `foreground?: true` (see below).
- `ListData`, `StatsData` and `SocialHotData`: new optional field `snipersLowerBound?: boolean`. When `true`, `snipersPct` is only a lower bound ("at least this share"), for a bonding-curve token whose sniping window isn't known.
- `NotificationsData`: `kind` has a new value, `"referral_payout"` (a referral payout reached the account). A `switch` over `kind` that lists every value needs a case or a `default` for it.

What changed in behaviour:

- Your own paid RPC endpoint as the fallback: add it to `rpc` with `foreground: true` and its `headers`. Reads ask the free providers first and go to your endpoint only when they refuse, fail or are slow. Background reads never use it.
- The first quote in a new process makes fewer paid reads and finishes sooner: the Rhea DCL pool list is read from the free providers, every page at once, and reaches your paid endpoint only when every free provider refuses.
- Each `Unrlzd` instance keeps its own record of which providers are slow or refusing. Another instance, or another library in the same process, no longer shares it. A router's rate limit (HTTP 429) and a provider that lags behind the chain count in that record. When two providers must agree on the chain's latest block, they are two different hosts: one host's answer passed on by another never counts twice.
- Accounts with more than 100 access keys are read completely: key checks read every page of the key list at the same block, so a key after the first 100 is found.
- Quotes: a route is ranked, and its minimum output set, on the SDK's own on-chain read at the quote's block, never on a router's estimate. The price-impact confirm compares the fill with the on-chain market price at that block, so a fill at or above the market asks for no confirm. A Rhea DCL pool that charges a swap tax is never quoted.

## 0.1.1 (2026-10-24)

Documentation, example and package metadata only; the code is the same as 0.1.0.

- README: install, requirements, a quick start that onboards a new user (`fundYocto: await sdk.minFunding()`), the security model split into what the contract enforces and what the SDK checks, versioning, and links to the docs.
- Example: Connect funds a new account with `await sdk.minFunding()` (0.7 NEAR on mainnet). It passed `MIN_FUNDING` (0.2 NEAR), which failed with `FUNDING_TOO_LOW` for a new user.
- package.json: `homepage`, `bugs`, `keywords`, `engines` (Node.js 24 or later) and `author`; the published manifest no longer lists the workspace's scripts.

## 0.1.0 (2026-10-23)

First release.

- Quotes for buys and sells, with the same routes and on-chain checks as the UNRLZD terminal. With no device key and no account, `sdk.quote` returns what a new trading account would be quoted.
- Guardrails: `account.guardrails(quote)` returns the notices and confirms the terminal would show. `execute` refuses a quote until every confirm is passed back.
- Checked signing and sending from a user's UNRLZD trading account: `account.execute` signs only terms no wider than the quote shown, and `account.dryRun` returns the terms and operations without signing or sending.
- Your builder code on every trade and 24/7 order.
- Browser use: the device key stays in your origin's IndexedDB, and `nearConnectWallet` adapts a `@hot-labs/near-connect` wallet.
- Server use: `DeviceSigner.fromSecret` takes your own device key, and `FileIntentLog` (`@unrlzd/sdk/node`) keeps a trade from being sent twice after a restart.
- Account setup and deposits: `sdk.status`, `sdk.minFunding`, `account.deposit` from the owner's NEAR wallet, and `account.depositAddress` for deposits from another chain or an exchange.
- `sdk.feed()`: the live WebSocket feed, with typed channels, resynced gaps, reconnects, and each trade delivered once.
- Builder fee on top: not enabled until the core contract is upgraded. Send `f: 0`.
