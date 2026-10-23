/**
 * The example's own logic, kept free of I/O so it can be unit tested: NEAR amounts, a server's device key, a check
 * run's arguments, a dry run's walls (a fetch that refuses every send, a signer that never hands a signed transaction
 * back), and the on-chain checks of a builder's trade (its tag, its `settled` event, the fee paid to the fee
 * recipient) and 24/7 order.
 */
import { base58 } from "@scure/base";
import { parseBuilderTag } from "@unrlzd/sdk";

export const NEAR = 10n ** 24n;
/** the most one leg of the check may move: the buy and the 24/7 order together stay under 0.1 NEAR */
export const MAX_LEG_YOCTO = (NEAR * 4n) / 100n;

/** "0.02" → yocto; refuses anything that is not a plain positive decimal with at most 24 places */
export function nearToYocto(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(s.trim());
  if (!m) throw new Error(`not a NEAR amount: ${JSON.stringify(s)}`);
  const y = BigInt(m[1] as string) * NEAR + BigInt((m[2] ?? "").padEnd(24, "0") || "0");
  if (y <= 0n) throw new Error("the amount must be above 0");
  return y;
}

/** raw units → a decimal string with `digits` places, rounded down */
export function formatUnits(raw: bigint, decimals: number, digits = 6): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = ((raw % base) * 10n ** BigInt(digits)) / base;
  return digits > 0 ? `${whole}.${frac.toString().padStart(digits, "0")}` : `${whole}`;
}

/**
 * A new device key for a server: `secretKey` (`ed25519:` and the base58 of the 32-byte seed then the 32-byte public
 * key, the form DeviceSigner.fromSecret reads) and `publicKey` (`ed25519:<base58>`, the key the owner adds).
 */
export async function newDeviceKey(): Promise<{ secretKey: string; publicKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  // an Ed25519 key's PKCS #8 form is a 16-byte header, then the 32-byte seed
  const seed = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).slice(16);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return {
    secretKey: `ed25519:${base58.encode(new Uint8Array([...seed, ...pub]))}`,
    publicKey: `ed25519:${base58.encode(pub)}`,
  };
}

export interface CheckArgs {
  mode: "dry" | "live";
  token: string;
  legYocto: bigint;
  /** the device key file; without it a dry run makes its keyless reads only */
  keyFile?: string;
  intentLog: string;
}

/** `--dry | --live`, `--key-file <path>` (needed by --live), `--token <id>`, `--near <leg>`, `--intent-log <path>` */
export function parseCheckArgs(argv: readonly string[]): CheckArgs {
  const opt = (f: string) => {
    const i = argv.indexOf(f);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${f} needs a value`);
    return v;
  };
  const dry = argv.includes("--dry");
  const live = argv.includes("--live");
  if (dry === live) throw new Error("pass exactly one of --dry or --live");
  const keyFile = opt("--key-file");
  if (live && !keyFile) throw new Error("--live needs --key-file <the device key file>");
  const legYocto = nearToYocto(opt("--near") ?? "0.02");
  if (legYocto > MAX_LEG_YOCTO)
    throw new Error("--near is at most 0.04 (the run stays under 0.1 NEAR)");
  return {
    mode: live ? "live" : "dry",
    token: opt("--token") ?? "blackdragon.tkn.near",
    legYocto,
    ...(keyFile && { keyFile }),
    intentLog: opt("--intent-log") ?? `intents-${live ? "live" : "dry"}.jsonl`,
  };
}

// ------------------------------------------------------------------ the dry run's walls

/** NEAR JSON-RPC methods that only read */
const READ_METHODS = new Set([
  "query",
  "block",
  "chunk",
  "gas_price",
  "status",
  "validators",
  "tx",
  "EXPERIMENTAL_tx_status",
  "EXPERIMENTAL_receipt",
  "EXPERIMENTAL_protocol_config",
  "EXPERIMENTAL_changes",
  "EXPERIMENTAL_changes_in_block",
]);

export class DryRunRefused extends Error {}

/** the JSON-RPC method of a request body, or null when the body is not JSON-RPC */
export function rpcMethodOf(body: string | null): string | null {
  if (!body) return null;
  try {
    const j = JSON.parse(body) as { jsonrpc?: unknown; method?: unknown };
    return j.jsonrpc === "2.0" && typeof j.method === "string" ? j.method : null;
  } catch {
    return null;
  }
}

/**
 * Counts every request (host and JSON-RPC method). In a dry run it refuses every JSON-RPC method that isn't a read
 * and every other request that isn't a GET, so nothing can be sent whatever the SDK does.
 */
export function guardedFetch(
  inner: typeof fetch,
  o: { dry: boolean; calls: Map<string, number> },
): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const body = req.method === "GET" ? null : await req.clone().text();
    const method = rpcMethodOf(body);
    const key = `${new URL(req.url).host} ${method ?? `${req.method} ${new URL(req.url).pathname}`}`;
    o.calls.set(key, (o.calls.get(key) ?? 0) + 1);
    if (o.dry && (method ? !READ_METHODS.has(method) : req.method !== "GET"))
      throw new DryRunRefused(`dry run: refused ${key}`);
    return inner(req);
  };
}

/** What the device key signed in a dry run: everything but the signature, which never leaves the run. */
export interface Signed {
  params: unknown;
  hash: string;
  summary?: string[];
}

export class DryRunSigned extends Error {}

/**
 * A signer's `sign` that signs (so the SDK's checks and the signer core's validateSign run on the real payload),
 * keeps what was signed, and throws instead of returning: the SDK never holds a signed transaction to send.
 */
export function withheldSign<P, R extends { hash: string; summary?: string[] }>(
  sign: (p: P) => Promise<R>,
  out: Signed[],
): (p: P) => Promise<R> {
  return async (p) => {
    const r = await sign(p);
    out.push({ params: p, hash: r.hash, ...(r.summary && { summary: r.summary }) });
    throw new DryRunSigned("dry run: signed, not sent");
  };
}

// ------------------------------------------------------------------ on-chain checks of a live run

/** The parts of an EXPERIMENTAL_tx_status answer the checks read. */
export interface TxView {
  status: Record<string, unknown>;
  transaction: {
    signer_id: string;
    receiver_id: string;
    actions: ({ FunctionCall?: { method_name: string; args: string } } | string)[];
  };
  receipts_outcome: { id: string; outcome: { executor_id: string; logs: string[] } }[];
  receipts?: {
    predecessor_id: string;
    receiver_id: string;
    receipt: { Action?: { actions: ({ Transfer?: { deposit: string } } | string)[] } };
  }[];
}

const ok = (tx: TxView) => "SuccessValue" in tx.status;

/** the account's own `nttrade` events (EVENT_JSON logs) */
export function events(
  tx: TxView,
  account: string,
): { event: string; data: Record<string, unknown> }[] {
  const out: { event: string; data: Record<string, unknown> }[] = [];
  for (const r of tx.receipts_outcome) {
    if (r.outcome.executor_id !== account) continue;
    for (const l of r.outcome.logs) {
      if (!l.startsWith("EVENT_JSON:")) continue;
      try {
        const j = JSON.parse(l.slice(11)) as { standard?: string; event?: string; data?: unknown };
        if (j.standard === "nttrade" && typeof j.event === "string")
          out.push({ event: j.event, data: (j.data ?? {}) as Record<string, unknown> });
      } catch {}
    }
  }
  return out;
}

/** the transaction's function calls with their args parsed */
export function calls(tx: TxView): { method: string; args: Record<string, unknown> }[] {
  return tx.transaction.actions.flatMap((a) => {
    const fc = typeof a === "object" ? a.FunctionCall : undefined;
    if (!fc) return [];
    let args: Record<string, unknown> = {};
    try {
      const bytes = Uint8Array.from(atob(fc.args), (c) => c.charCodeAt(0));
      args = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } catch {}
    return [{ method: fc.method_name, args }];
  });
}

/** NEAR moved by Transfer receipts from `from` to `to` */
export function transferred(tx: TxView, from: string, to: string): bigint {
  let sum = 0n;
  for (const r of tx.receipts ?? []) {
    if (r.predecessor_id !== from || r.receiver_id !== to) continue;
    for (const a of r.receipt.Action?.actions ?? [])
      if (typeof a === "object" && a.Transfer) sum += BigInt(a.Transfer.deposit);
  }
  return sum;
}

/**
 * A trade sent with a builder: final success, signed by the trading account to itself, its `client_order_id` the
 * builder's tag, the `settled` event naming the same id, and the fee in that event paid to the fee recipient.
 */
export function checkTrade(
  tx: TxView,
  o: { account: string; builder: string; clientOrderId: string; feeRecipient: string },
): { problems: string[]; feeYocto: bigint } {
  const p: string[] = [];
  if (!ok(tx)) p.push(`not a success: ${JSON.stringify(tx.status)}`);
  if (tx.transaction.signer_id !== o.account || tx.transaction.receiver_id !== o.account)
    p.push(`signer/receiver ${tx.transaction.signer_id} → ${tx.transaction.receiver_id}`);
  const exec = calls(tx).find((c) => c.method === "execute");
  if (exec?.args.client_order_id !== o.clientOrderId)
    p.push(`execute's client_order_id ${JSON.stringify(exec?.args.client_order_id)}`);
  if (parseBuilderTag(o.clientOrderId)?.builder !== o.builder)
    p.push(`${o.clientOrderId} is not tagged with ${o.builder}`);
  const settled = events(tx, o.account).find(
    (e) => e.event === "settled" && e.data.client_order_id === o.clientOrderId,
  );
  if (!settled) p.push("no settled event with the tag");
  const feeYocto = BigInt(String(settled?.data.fee ?? "0"));
  if (settled && feeYocto <= 0n) p.push("settled fee is 0");
  const paid = transferred(tx, o.account, o.feeRecipient);
  if (settled && paid !== feeYocto) p.push(`fee ${feeYocto} but ${paid} paid to ${o.feeRecipient}`);
  return { problems: p, feeYocto };
}

/** A 24/7 order placed with a builder: success, `bc` in the signed trigger_meta, the `order_placed` event's id. */
export function checkPlace(
  tx: TxView,
  o: { account: string; builder: string; orderId: string },
): string[] {
  const p: string[] = [];
  if (!ok(tx)) p.push(`not a success: ${JSON.stringify(tx.status)}`);
  const place = calls(tx).find((c) => c.method === "place_order");
  let bc: unknown;
  try {
    bc = (JSON.parse(String(place?.args.trigger_meta)) as { bc?: unknown }).bc;
  } catch {}
  if (bc !== o.builder) p.push(`trigger_meta bc ${JSON.stringify(bc)}`);
  const placed = events(tx, o.account)
    .filter((e) => e.event === "order_placed")
    .map((e) => e.data.order_id);
  if (!placed.includes(o.orderId))
    p.push(`the SDK's order id ${o.orderId}, the chain's order_placed ${JSON.stringify(placed)}`);
  return p;
}

/** A cancel: success, sent by the account to itself. */
export function checkCancel(tx: TxView, o: { account: string }): string[] {
  const p: string[] = [];
  if (!ok(tx)) p.push(`not a success: ${JSON.stringify(tx.status)}`);
  if (tx.transaction.signer_id !== o.account || tx.transaction.receiver_id !== o.account)
    p.push(`signer/receiver ${tx.transaction.signer_id} → ${tx.transaction.receiver_id}`);
  return p;
}

/** Two providers' answers for one transaction must agree on its status and on every receipt's logs. */
export function sameAnswer(a: TxView, b: TxView): string[] {
  const p: string[] = [];
  if (JSON.stringify(a.status) !== JSON.stringify(b.status)) p.push("the status differs");
  const logs = (t: TxView) => JSON.stringify(t.receipts_outcome.map((r) => [r.id, r.outcome.logs]));
  if (logs(a) !== logs(b)) p.push("the receipts differ");
  return p;
}
