import { DeviceSigner } from "@unrlzd/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  checkCancel,
  checkPlace,
  checkTrade,
  DryRunRefused,
  DryRunSigned,
  formatUnits,
  guardedFetch,
  NEAR,
  nearToYocto,
  newDeviceKey,
  parseCheckArgs,
  type Signed,
  sameAnswer,
  type TxView,
  withheldSign,
} from "./lib.ts";

const TA = "aaaaaaaaaaaaaaaa.trade.unrlzd.near";
const BUILDER = "bbbbbbbbbbbbbbbb.trade.unrlzd.near";
const TAG = `b:${BUILDER}:cmvgs4oti-a1s`;
const FEE = "357843257241604604591";
const b64 = (v: unknown) => btoa(JSON.stringify(v));
const ev = (event: string, data: unknown) =>
  `EVENT_JSON:${JSON.stringify({ standard: "nttrade", version: "1", event, data })}`;

/** a tagged sell as EXPERIMENTAL_tx_status returns it (trimmed) */
const sell = (
  o: { tag?: string; fee?: string; paid?: string; status?: Record<string, unknown> } = {},
): TxView => ({
  status: o.status ?? { SuccessValue: "" },
  transaction: {
    signer_id: TA,
    receiver_id: TA,
    actions: [
      {
        FunctionCall: {
          method_name: "execute",
          args: b64({ ops: [], client_order_id: o.tag ?? TAG }),
        },
      },
    ],
  },
  receipts_outcome: [
    {
      id: "r1",
      outcome: { executor_id: TA, logs: [ev("execute", { client_order_id: o.tag ?? TAG })] },
    },
    {
      id: "r2",
      outcome: {
        executor_id: TA,
        logs: [
          ev("settled", {
            client_order_id: o.tag ?? TAG,
            used: "1",
            fee: o.fee ?? FEE,
            spend_returned: "0",
          }),
        ],
      },
    },
  ],
  receipts: [
    {
      predecessor_id: "system",
      receiver_id: TA,
      receipt: { Action: { actions: [{ Transfer: { deposit: "5" } }] } },
    },
    {
      predecessor_id: TA,
      receiver_id: "fees.unrlzd.near",
      receipt: { Action: { actions: [{ Transfer: { deposit: o.paid ?? FEE } }] } },
    },
  ],
});
const want = {
  account: TA,
  builder: BUILDER,
  clientOrderId: TAG,
  feeRecipient: "fees.unrlzd.near",
};

describe("amounts", () => {
  it("parses NEAR without floats", () => {
    expect(nearToYocto("0.02")).toBe(2n * 10n ** 22n);
    expect(nearToYocto("1")).toBe(NEAR);
    expect(nearToYocto("0.000000000000000000000001")).toBe(1n);
  });
  it.each(["", "0", "-1", "1e3", ".5", "0.0000000000000000000000001", "1,5"])("refuses %j", (s) => {
    expect(() => nearToYocto(s)).toThrow();
  });
  it("formats raw units", () => {
    expect(formatUnits(1234567n * 10n ** 18n, 24)).toBe("1.234567");
    expect(formatUnits(5n, 0, 0)).toBe("5");
  });
});

describe("newDeviceKey", () => {
  it("makes a key DeviceSigner.fromSecret reads, with the public key the owner adds", async () => {
    const k = await newDeviceKey();
    expect(k.secretKey).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    const d = await DeviceSigner.fromSecret({
      network: "mainnet",
      secretKey: k.secretKey,
      presence: { confirm: async () => false },
    });
    expect(d.serverKey?.publicKey).toBe(k.publicKey);
    expect((await newDeviceKey()).secretKey).not.toBe(k.secretKey);
  });
});

describe("parseCheckArgs", () => {
  it("needs exactly one mode", () => {
    expect(() => parseCheckArgs([])).toThrow(/exactly one/);
    expect(() => parseCheckArgs(["--dry", "--live", "--key-file", "k"])).toThrow(/exactly one/);
  });
  it("a live run needs the key file; a dry run doesn't", () => {
    expect(() => parseCheckArgs(["--live"])).toThrow(/--key-file/);
    expect(parseCheckArgs(["--dry"])).toMatchObject({ mode: "dry", legYocto: 2n * 10n ** 22n });
    expect(parseCheckArgs(["--live", "--key-file", "k.json"])).toMatchObject({
      mode: "live",
      keyFile: "k.json",
    });
  });
  it("keeps a leg at 0.04 N at most", () => {
    expect(parseCheckArgs(["--dry", "--near", "0.04"]).legYocto).toBe(4n * 10n ** 22n);
    expect(() => parseCheckArgs(["--dry", "--near", "0.05"])).toThrow(/at most/);
    expect(() => parseCheckArgs(["--dry", "--near"])).toThrow(/needs a value/);
  });
});

describe("dry run walls", () => {
  const rpc = (method: string) => ({
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  });
  it.each(["send_tx", "broadcast_tx_commit", "broadcast_tx_async", "sandbox_patch_state"])(
    "a dry fetch refuses %s",
    async (m) => {
      const inner = vi.fn(async () => new Response("{}"));
      const calls = new Map<string, number>();
      await expect(
        guardedFetch(inner, { dry: true, calls })("https://rpc.example", rpc(m)),
      ).rejects.toThrow(DryRunRefused);
      expect(inner).not.toHaveBeenCalled();
      expect(calls.get(`rpc.example ${m}`)).toBe(1);
    },
  );
  it("a dry fetch refuses a POST that isn't JSON-RPC and lets reads through", async () => {
    const inner = vi.fn(async () => new Response("{}"));
    const f = guardedFetch(inner, { dry: true, calls: new Map() });
    await expect(
      f("https://api.example/v1/auth/challenge", { method: "POST", body: "{}" }),
    ).rejects.toThrow(DryRunRefused);
    await f("https://rpc.example", rpc("query"));
    await f("https://api.example/v1/token/x");
    expect(inner).toHaveBeenCalledTimes(2);
  });
  it("a live fetch sends, and counts", async () => {
    const inner = vi.fn(async () => new Response("{}"));
    const calls = new Map<string, number>();
    await guardedFetch(inner, { dry: false, calls })("https://rpc.example", rpc("send_tx"));
    expect(inner).toHaveBeenCalledOnce();
    expect(calls.get("rpc.example send_tx")).toBe(1);
  });
  it("the withheld signer signs, keeps the payload and never hands the signed tx back", async () => {
    const out: Signed[] = [];
    const sign = vi.fn(async (p: { n: number }) => ({
      signedTx: "SECRET-BYTES",
      hash: `h${p.n}`,
      summary: ["Buy"],
    }));
    await expect(withheldSign(sign, out)({ n: 1 })).rejects.toThrow(DryRunSigned);
    expect(sign).toHaveBeenCalledOnce();
    expect(out).toEqual([{ params: { n: 1 }, hash: "h1", summary: ["Buy"] }]);
    expect(JSON.stringify(out)).not.toContain("SECRET-BYTES");
  });
  it("a refused signature records nothing", async () => {
    const out: Signed[] = [];
    await expect(
      withheldSign(async () => {
        throw new Error("refused");
      }, out)({}),
    ).rejects.toThrow("refused");
    expect(out).toEqual([]);
  });
});

describe("live checks", () => {
  it("passes a tagged trade whose fee went to the fee recipient", () => {
    expect(checkTrade(sell(), want)).toEqual({ problems: [], feeYocto: BigInt(FEE) });
  });
  it("fails a trade tagged with another builder", () => {
    const tag = "b:hoot.near:cmvgs4oti-a1s";
    expect(checkTrade(sell({ tag }), { ...want, clientOrderId: tag }).problems).toEqual([
      `${tag} is not tagged with ${BUILDER}`,
    ]);
  });
  it("fails when the sent id isn't the one on chain", () => {
    expect(checkTrade(sell({ tag: `b:${BUILDER}:other` }), want).problems).toEqual([
      `execute's client_order_id "b:${BUILDER}:other"`,
      "no settled event with the tag",
    ]);
  });
  it("fails a fee that was not paid to the recipient in full", () => {
    expect(checkTrade(sell({ paid: "1" }), want).problems).toEqual([
      `fee ${FEE} but 1 paid to fees.unrlzd.near`,
    ]);
  });
  it("fails a failed transaction", () => {
    expect(checkTrade(sell({ status: { Failure: {} } }), want).problems[0]).toMatch(
      /not a success/,
    );
  });
  it("checks the 24/7 order's bc and its id", () => {
    const meta = JSON.stringify({ v: 2, k: "lim", bc: BUILDER });
    const place = (bc: string | undefined, id: string): TxView => ({
      status: { SuccessValue: "IjQzMyI=" },
      transaction: {
        signer_id: TA,
        receiver_id: TA,
        actions: [
          {
            FunctionCall: {
              method_name: "place_order",
              args: b64({ trigger_meta: bc ? meta : JSON.stringify({ v: 2 }) }),
            },
          },
        ],
      },
      receipts_outcome: [
        { id: "r", outcome: { executor_id: TA, logs: [ev("order_placed", { order_id: id })] } },
      ],
    });
    const o = { account: TA, builder: BUILDER, orderId: "433" };
    expect(checkPlace(place(BUILDER, "433"), o)).toEqual([]);
    expect(checkPlace(place(undefined, "433"), o)).toEqual(["trigger_meta bc undefined"]);
    expect(checkPlace(place(BUILDER, "434"), o)).toEqual([
      `the SDK's order id 433, the chain's order_placed ["434"]`,
    ]);
  });
  it("checks a cancel", () => {
    expect(checkCancel(sell(), { account: TA })).toEqual([]);
    expect(checkCancel(sell({ status: { Failure: {} } }), { account: TA })).toHaveLength(1);
  });
  it("two providers must agree", () => {
    expect(sameAnswer(sell(), sell())).toEqual([]);
    expect(sameAnswer(sell(), sell({ status: { Failure: {} } }))).toEqual(["the status differs"]);
    expect(sameAnswer(sell(), sell({ fee: "1" }))).toEqual(["the receipts differ"]);
  });
});
