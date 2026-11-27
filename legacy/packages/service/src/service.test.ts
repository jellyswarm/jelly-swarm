import { describe, expect, test } from "bun:test";
import { verifyVerdict } from "@jelly/checker";
import { signer } from "@jelly/checker/src/testkit";
import { verifyProof } from "@jelly/receipts";
import type { Address, Hex } from "viem";
import { COPY } from "./copy";
import type { SignedGrant } from "./escrow";
import { ServiceError } from "./service";
import type { Account } from "./store";
import { COLUMNS, SUMMARY, makeService } from "./testkit";

const ALICE: Account = { id: "acct-alice", tier: "paid" };
const BOB: Account = { id: "acct-bob", tier: "paid" };
const WALLET = "0x000000000000000000000000000000000000dEaD" as Address;
const input = (items: string[]) => ({ task: "Holder count for each token.", items, columns: COLUMNS });
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof ServiceError ? e.code : `other: ${e}`));

/** Quote, fund from the client's own wallet, run, and wait for settlement. */
async function runJob(s: ReturnType<typeof makeService>, items: string[], account = ALICE) {
  const quote = await s.service.quote(account, input(items));
  const { job } = await s.service.prepare(account, quote.quoteId, "wallet", WALLET);
  const stored = (await s.store.getJob(job.jobKey))!;
  s.escrow.markFunded(stored.jobId, WALLET);
  await s.service.confirm(account, job.jobKey);
  await s.service.finished(job.jobKey);
  return { quote, jobKey: job.jobKey, jobId: stored.jobId };
}

describe("quote", () => {
  test("returns the fixed price, the agent count of 247, and when it expires", async () => {
    const s = makeService();
    const q = await s.service.quote(ALICE, input(["tok-0", "tok-1", "tok-2", "tok-3"]));
    expect(q).toMatchObject({
      agents: 4,
      of: 247,
      priceUsd: "0.31", // $0.25 + 4 × $0.015
      lines: { base: "0.25", rows: "0.06", toolsCap: "0.00" },
      tier: "standard",
      tierForced: false,
      waves: 1,
    });
    expect(new Date(q.expiresAt).getTime()).toBe(s.clock.now + 600_000);
  });

  test("a request without a list, a Picket request, or a bad tier is refused with a plain message", async () => {
    const s = makeService();
    const refused = (i: object) => s.service.quote(ALICE, i as never).then(() => null, (e: ServiceError) => [e.code, e.message]);
    expect(await refused({ task: "cheapest flights to Lisbon" })).toEqual(["invalid", COPY.itemsRequired]);
    expect(await refused({ ...input(["a"]), product: "picket" })).toEqual(["invalid", COPY.picketNotPerJob]);
    expect(await refused({ ...input(["a"]), product: "trawl", tier: "open" })).toEqual(["invalid", COPY.notOffered]);
    expect((await refused({ ...input(["a"]), maxAgents: 248 }))?.[0]).toBe("invalid");
  });
});

describe("fund and run", () => {
  test("a job does not start until the escrow shows it funded", async () => {
    const s = makeService();
    const quote = await s.service.quote(ALICE, input(["tok-0", "tok-1"]));
    const { job, payment } = await s.service.prepare(ALICE, quote.quoteId, "wallet", WALLET);
    expect(job.state).toBe("awaiting_payment");
    expect(payment).toMatchObject({ route: "wallet", amountUsd: "0.28" });
    expect(await code(s.service.confirm(ALICE, job.jobKey))).toBe("payment_required");
    expect(s.provider.calls.filter((c) => c.req.messages[0]!.content.includes("row-task")).length).toBe(2); // only the dry run so far
  });

  test("preparing the same quote twice gives the same job", async () => {
    const s = makeService();
    const quote = await s.service.quote(ALICE, input(["tok-0"]));
    const a = await s.service.prepare(ALICE, quote.quoteId, "wallet", WALLET);
    const b = await s.service.prepare(ALICE, quote.quoteId, "wallet", WALLET);
    expect(b.job.jobKey).toBe(a.job.jobKey);
  });

  test("an expired quote cannot be funded", async () => {
    const s = makeService();
    const quote = await s.service.quote(ALICE, input(["tok-0"]));
    s.clock.now += 600_000;
    expect(await code(s.service.prepare(ALICE, quote.quoteId, "wallet", WALLET))).toBe("expired");
  });

  test("end to end: passed rows are paid for, the failed row is refunded, and the verdict settles on the escrow", async () => {
    const s = makeService();
    const { jobKey, jobId } = await runJob(s, ["tok-0", "tok-1", "bad-1", "tok-3"]);

    const view = await s.service.get(ALICE, jobKey);
    expect(view).toMatchObject({
      state: "settled",
      rows: { total: 4, passed: 3, refunded: 1 },
      quoteUsd: "0.31",
      paidUsd: "0.295", // 3 × $0.015 + $0.25
      refundedUsd: "0.015",
    });

    const settled = s.escrow.settled.get(jobId)!;
    expect(settled.verdict).toMatchObject({ jobKey, rowCount: 4, passedCount: 3 });
    expect(await verifyVerdict(s.escrow.verdictDomain(), settled.verdict, settled.signature, signer.address)).toBe(true);
    expect(s.escrow.sealed.get(jobKey)?.root).toBe(settled.verdict.receiptsRoot);

    const status = await s.service.status(ALICE, jobKey);
    // §11.2 added tile/eta/cost telemetry around these milestones (covered by its own
    // tests); this checks only that the milestones themselves land in the right order.
    const types = status.events.map((e) => e.type);
    const milestones = types.filter((t) => t.startsWith("job.") || t === "wave.started");
    expect(milestones).toEqual(["job.quoted", "job.funded", "wave.started", "job.merged", "job.sealed", "job.settled"]);
    expect(status.spentUsd).toBeDefined();
    expect((await s.service.status(ALICE, jobKey, status.nextSeq)).events).toEqual([]);
  });

  test("if nothing passes, everything is refunded", async () => {
    const s = makeService();
    const { jobKey } = await runJob(s, ["bad-1", "bad-2"]);
    expect(await s.service.get(ALICE, jobKey)).toMatchObject({ state: "refunded", paidUsd: "0.00", refundedUsd: "0.28" });
  });

  test("a prepaid balance pays under a signed grant; without one the request is refused", async () => {
    const s = makeService();
    const grant: SignedGrant = {
      owner: WALLET,
      keyId: `0x${"11".repeat(32)}` as Hex,
      perJobCapUsd6: 25_000_000n,
      perDayCapUsd6: 50_000_000n,
      expiresAt: 2_000_000_000n,
      periodCapUsd6: 0n,
      minCoverageBps: 9500,
      signature: "0x00",
    };
    s.escrow.vault.set(WALLET.toLowerCase(), 5_000_000n);
    const quote = await s.service.quote(ALICE, input(["tok-0", "tok-1"]));
    expect(await code(s.service.runFromVault(ALICE, quote.quoteId, undefined))).toBe("invalid");

    const job = await s.service.runFromVault(ALICE, quote.quoteId, grant);
    expect(job.state).toBe("running");
    await s.service.finished(job.jobKey);
    expect((await s.service.get(ALICE, job.jobKey)).state).toBe("settled");
    expect(s.escrow.vault.get(WALLET.toLowerCase())).toBe(5_000_000n - 280_000n);
  });

  describe("free tier", () => {
    const STUDIO = "0x000000000000000000000000000000000000Fee" as Address;
    const studioGrant: SignedGrant = {
      owner: STUDIO,
      keyId: `0x${"22".repeat(32)}` as Hex,
      perJobCapUsd6: 550_000n,
      perDayCapUsd6: 50_000_000n,
      expiresAt: 2_000_000_000n,
      periodCapUsd6: 0n,
      minCoverageBps: 0,
      signature: "0x00",
    };

    test("pays from the studio's own vault, never the caller's", async () => {
      const s = makeService({ studioGrant });
      s.escrow.vault.set(STUDIO.toLowerCase(), 5_000_000n);
      const quote = await s.service.quote(ALICE, input(["tok-0", "tok-1"])); // $0.28, within the cap
      const job = await s.service.runFree(ALICE, quote.quoteId);
      expect(job.state).toBe("running");
      await s.service.finished(job.jobKey);
      expect((await s.service.get(ALICE, job.jobKey)).state).toBe("settled");
      expect(s.escrow.vault.get(STUDIO.toLowerCase())).toBe(5_000_000n - 280_000n);
    });

    test("is refused when no studio grant is configured", async () => {
      const s = makeService(); // no studioGrant
      const quote = await s.service.quote(ALICE, input(["tok-0", "tok-1"]));
      expect(await code(s.service.runFree(ALICE, quote.quoteId))).toBe("not_ready");
    });

    test("is refused when the quote prices above the free-tier cap", async () => {
      const s = makeService({ studioGrant });
      s.escrow.vault.set(STUDIO.toLowerCase(), 5_000_000n);
      const quote = await s.service.quote(ALICE, input(Array.from({ length: 25 }, (_, i) => `tok-${i}`))); // $0.25 + 25×$0.015 = $0.625
      expect(await code(s.service.runFree(ALICE, quote.quoteId))).toBe("invalid");
    });
  });

  describe("paying with a credit balance", () => {
    const STUDIO = "0x000000000000000000000000000000000000Fee" as Address;
    const creditsGrant: SignedGrant = {
      owner: STUDIO,
      keyId: `0x${"33".repeat(32)}` as Hex,
      perJobCapUsd6: 50_000_000n,
      perDayCapUsd6: 500_000_000n,
      expiresAt: 2_000_000_000n,
      periodCapUsd6: 0n,
      minCoverageBps: 0,
      signature: "0x00",
    };

    test("pays from the studio's vault and debits the caller's own credit balance, never the studio's budget", async () => {
      const s = makeService({ creditsGrant });
      s.escrow.vault.set(STUDIO.toLowerCase(), 5_000_000n);
      await s.store.addCredit({ id: "c1", accountId: ALICE.id, deltaUsd6: 1_000_000n, reason: "referral_referrer", createdAtMs: s.clock.now });
      expect(await s.service.creditBalance(ALICE)).toBe("1.00");

      const quote = await s.service.quote(ALICE, input(["tok-0", "tok-1"])); // $0.28
      const job = await s.service.runFromCredits(ALICE, quote.quoteId);
      expect(job.state).toBe("running");
      await s.service.finished(job.jobKey);
      expect((await s.service.get(ALICE, job.jobKey)).state).toBe("settled");
      expect(s.escrow.vault.get(STUDIO.toLowerCase())).toBe(5_000_000n - 280_000n);
      expect(await s.service.creditBalance(ALICE)).toBe("0.72"); // $1.00 - $0.28
    });

    test("a row that fails checking is never charged for: the debit is the settled amount, not the quoted price", async () => {
      const s = makeService({ creditsGrant });
      s.escrow.vault.set(STUDIO.toLowerCase(), 5_000_000n);
      await s.store.addCredit({ id: "c1", accountId: ALICE.id, deltaUsd6: 1_000_000n, reason: "referral_referrer", createdAtMs: s.clock.now });

      const quote = await s.service.quote(ALICE, input(["tok-0", "bad-1"])); // $0.28 quoted; only tok-0 will pass
      const job = await s.service.runFromCredits(ALICE, quote.quoteId);
      await s.service.finished(job.jobKey);
      expect((await s.service.get(ALICE, job.jobKey)).state).toBe("settled");
      // 1 passed row: $0.25 base + $0.015 = $0.265 — not the full $0.28 quoted.
      expect(await s.service.creditBalance(ALICE)).toBe("0.735"); // $1.00 - $0.265
    });

    test("is refused when no credits grant is configured", async () => {
      const s = makeService(); // no creditsGrant
      await s.store.addCredit({ id: "c1", accountId: ALICE.id, deltaUsd6: 1_000_000n, reason: "referral_referrer", createdAtMs: s.clock.now });
      const quote = await s.service.quote(ALICE, input(["tok-0", "tok-1"]));
      expect(await code(s.service.runFromCredits(ALICE, quote.quoteId))).toBe("not_ready");
    });

    test("is refused when the balance does not cover the job's price", async () => {
      const s = makeService({ creditsGrant });
      s.escrow.vault.set(STUDIO.toLowerCase(), 5_000_000n);
      await s.store.addCredit({ id: "c1", accountId: ALICE.id, deltaUsd6: 100_000n, reason: "referral_referrer", createdAtMs: s.clock.now }); // $0.10
      const quote = await s.service.quote(ALICE, input(["tok-0", "tok-1"])); // $0.28
      expect(await code(s.service.runFromCredits(ALICE, quote.quoteId))).toBe("payment_required");
    });
  });

  test("if settlement fails, the job is marked failed with a safe message and no internal detail", async () => {
    const s = makeService();
    s.escrow.settle = async () => {
      throw new Error("rpc 10.0.0.7 refused: nonce too low");
    };
    const { jobKey } = await runJob(s, ["tok-0"]);
    const view = await s.service.get(ALICE, jobKey);
    expect(view).toMatchObject({ state: "failed", error: COPY.runFailed });
    expect(JSON.stringify(await s.service.status(ALICE, jobKey))).not.toContain("10.0.0.7");
  });
});

describe("results and receipts", () => {
  test("the result has only passed rows, in three formats, with the summary", async () => {
    const s = makeService();
    const { jobKey } = await runJob(s, ["tok-0", "bad-1", "tok-2"]);
    const json = await s.service.result(ALICE, jobKey, "json");
    expect(json).toMatchObject({ summary: SUMMARY, passed: 2, refunded: 1, unverifiedCells: 0 });
    const parsed = JSON.parse(json.content);
    expect(parsed.rows.map((r: { item: string }) => r.item)).toEqual(["tok-0", "tok-2"]);
    expect(parsed.rows[1].cells.holders).toEqual({ value: 1002, sourceUrl: "https://s.example/tok-2" });
    expect((await s.service.result(ALICE, jobKey, "csv")).content.split("\r\n")).toHaveLength(3);
    expect((await s.service.result(ALICE, jobKey, "md")).content).toContain("| 0 | tok-0 | 1000 ([source](<https://s.example/tok-0>)) |");
  });

  test("a result is not available before the job finishes", async () => {
    const s = makeService();
    const quote = await s.service.quote(ALICE, input(["tok-0"]));
    const { job } = await s.service.prepare(ALICE, quote.quoteId, "wallet", WALLET);
    expect(await code(s.service.result(ALICE, job.jobKey))).toBe("not_ready");
    expect(await code(s.service.transcript(ALICE, job.jobKey))).toBe("not_ready");
  });

  test("the transcript proves every receipt against the sealed root", async () => {
    const s = makeService();
    const { jobKey } = await runJob(s, ["tok-0", "tok-1"]);
    const t = (await s.service.transcript(ALICE, jobKey)) as {
      manifest: { root: Hex; count: number; rowsRoot: Hex; sealTx: string; settleTx: string };
      receipts: { leaf: Hex; proof: Hex[]; costMicros: string }[];
    };
    expect(t.manifest.count).toBe(t.receipts.length);
    expect(t.manifest.sealTx).toBeDefined();
    expect(t.receipts.length).toBeGreaterThanOrEqual(5); // 2 workers + 2 checks + merger
    for (const r of t.receipts) expect(verifyProof(r.leaf, r.proof, t.manifest.root)).toBe(true);
    expect(typeof t.receipts[0]!.costMicros).toBe("string"); // JSON-safe

    const one = (await s.service.transcript(ALICE, jobKey, 1)) as { receipts: { rowIdx: number }[]; row: { rowIdx: number; passed: boolean } };
    expect(one.row).toMatchObject({ rowIdx: 1, passed: true });
    expect(one.receipts.every((r) => r.rowIdx === 1)).toBe(true);
  });
});

describe("access", () => {
  test("another account cannot see, confirm, read or dispute a job; it looks as if it does not exist", async () => {
    const s = makeService();
    const { quote, jobKey } = await runJob(s, ["tok-0"]);
    for (const attempt of [
      s.service.get(BOB, jobKey),
      s.service.status(BOB, jobKey),
      s.service.result(BOB, jobKey),
      s.service.transcript(BOB, jobKey),
      s.service.confirm(BOB, jobKey),
      s.service.dispute(BOB, jobKey, [0], ""),
      s.service.prepare(BOB, quote.quoteId, "wallet", WALLET),
    ]) {
      expect(await code(attempt)).toBe("not_found");
    }
    expect(await s.service.list(BOB)).toEqual([]);
    expect(await s.service.list(ALICE)).toHaveLength(1);
  });

  test("an access key maps to its own account, and naming a wallet gives no access to that wallet's jobs", async () => {
    const s = makeService();
    const anon = await s.service.issueAnonymousKey();
    const account = (await s.service.accountForKey(anon.secret))!;
    expect(account.id).toStartWith("anon:");
    expect(await s.service.accountForKey("jk_nope.secret")).toBeNull();

    const k1 = await s.service.issueKey(WALLET);
    const k2 = await s.service.issueKey(WALLET);
    const a1 = (await s.service.accountForKey(k1.secret))!;
    const a2 = (await s.service.accountForKey(k2.secret))!;
    expect(a1.id).not.toBe(a2.id); // two keys bought for the same wallet do not share jobs
    expect(a1.id).not.toContain(WALLET.toLowerCase());
    expect(JSON.stringify([...(s.store as unknown as { apiKeys: Map<string, unknown> }).apiKeys.values()])).not.toContain(k1.secret);
  });
});

describe("disputes", () => {
  test("up to 25 passed rows can be disputed inside the window, for max($0.50, 1%)", async () => {
    const s = makeService();
    const { jobKey, jobId } = await runJob(s, ["tok-0", "bad-1", "tok-2"]);
    const d = (await s.service.dispute(ALICE, jobKey, [0, 2], "source is about another token")) as {
      feeUsd: string;
      onchain: { jobId: string; rowIdx: number[]; proofs: Hex[][]; operatorIds: string[] };
    };
    expect(d.feeUsd).toBe("0.50");
    expect(d.onchain).toMatchObject({ jobId: jobId.toString(), rowIdx: [0, 2], operatorIds: ["1", "1"] });
    expect(d.onchain.proofs).toHaveLength(2);
    expect(s.store.disputes).toHaveLength(1);
  });

  test("failed rows, repeated rows, more than 25 rows, and late disputes are refused", async () => {
    const s = makeService();
    const { jobKey } = await runJob(s, ["tok-0", "bad-1", "tok-2"]);
    expect(await code(s.service.dispute(ALICE, jobKey, [1], ""))).toBe("invalid"); // row 1 was refunded
    expect(await code(s.service.dispute(ALICE, jobKey, [0, 0], ""))).toBe("invalid");
    expect(await code(s.service.dispute(ALICE, jobKey, [], ""))).toBe("invalid");
    expect(await code(s.service.dispute(ALICE, jobKey, Array.from({ length: 26 }, (_, i) => i), ""))).toBe("invalid");
    s.clock.now += 24 * 3600 * 1000;
    expect(await code(s.service.dispute(ALICE, jobKey, [0], ""))).toBe("expired");
  });
});
