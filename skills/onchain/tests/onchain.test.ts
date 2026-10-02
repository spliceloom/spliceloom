/**
 * Unit tests for @splice/onchain with a stub capability function (no provider calls).
 * Run with: node --test tests/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import balance from "../tools/balance.ts";
import token from "../tools/token.ts";
import transaction from "../tools/transaction.ts";

function stub(result: unknown = { status: "LIVE", data: {}, provenance: { source: "stub", chainId: 4663 } }) {
  const calls: Array<{ name: string; args: unknown }> = [];
  return { calls, ctx: { capability: async (name: string, args?: unknown) => (calls.push({ name, args }), result) } };
}

describe("@splice/onchain", () => {
  it("maps tools to host capabilities", async () => {
    const s = stub();
    const address = "0x948951006b81b5dc954a18b639918a768447a66f";
    const hash = `0x${"a".repeat(64)}`;
    await balance({ address }, s.ctx);
    await transaction({ hash }, s.ctx);
    await token({ address }, s.ctx);
    assert.deepEqual(s.calls.map((c) => c.name), ["onchain.balance", "onchain.transaction", "onchain.token"]);
    assert.deepEqual(s.calls[1]!.args, { hash });
  });

  it("returns errors from the host unchanged", async () => {
    const error = { status: "ERROR", code: "NOT_FOUND", message: "transaction not found" };
    assert.deepEqual(await transaction({ hash: `0x${"b".repeat(64)}` }, stub(error).ctx), error);
  });
});
