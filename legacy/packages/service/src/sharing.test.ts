import { describe, expect, test } from "bun:test";
import { MemoryTemplateRegistry, defineTemplate } from "@jelly/templates";
import type { Address } from "viem";
import { z } from "zod";
import { COPY } from "./copy";
import { ServiceError } from "./service";
import type { Account } from "./store";
import { COLUMNS, makeService } from "./testkit";

const ALICE: Account = { id: "acct-alice", tier: "paid" };
const BOB: Account = { id: "acct-bob", tier: "paid" };
const WALLET = "0x000000000000000000000000000000000000dEaD" as Address;
const input = (items: string[]) => ({ task: "Holder count for each token.", items, columns: COLUMNS });
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof ServiceError ? e.code : `other: ${e}`));

async function runJob(s: ReturnType<typeof makeService>, items: string[], account = ALICE, markAsWalletJobAfter = false) {
  const quote = await s.service.quote(account, { ...input(items) });
  const { job } = await s.service.prepare(account, quote.quoteId, "wallet", WALLET);
  const stored = (await s.store.getJob(job.jobKey))!;
  s.escrow.markFunded(stored.jobId, WALLET);
  await s.service.confirm(account, job.jobKey);
  await s.service.finished(job.jobKey);
  // Flipped only after the job has already finished: this tests the sharing
  // restriction against the stored flag, not the engine's own Sealed-tier
  // handling of a real wallet job (a separate concern, covered in @jelly/engine's tests).
  if (markAsWalletJobAfter) await s.store.updateJob(job.jobKey, { walletJob: true });
  return { jobKey: job.jobKey };
}

describe("share links (§11.4)", () => {
  test("a finished job can be shared, read back by slug, and re-quoted", async () => {
    const s = makeService();
    const { jobKey } = await runJob(s, ["tok-0", "tok-1"]);
    const { slug, visibility } = await s.service.createShare(ALICE, jobKey, "unlisted");
    expect(visibility).toBe("unlisted");

    const read = await s.service.getShare(slug);
    expect(read.jobKey).toBe(jobKey);
    expect(read.snapshot.csv).toContain("tok-0");
    expect(read.snapshot.manifest.jobKey).toBe(jobKey);

    const rerun = await s.service.rerunShare(ALICE, slug);
    expect(rerun.agents).toBe(2);
  });

  test("a job with nothing to show yet cannot be shared", async () => {
    const s = makeService();
    const quote = await s.service.quote(ALICE, input(["tok-0"]));
    const { job } = await s.service.prepare(ALICE, quote.quoteId, "wallet", WALLET);
    expect(await code(s.service.createShare(ALICE, job.jobKey, "unlisted"))).toBe("not_ready");
  });

  test("only the owner can create or change a share's visibility", async () => {
    const s = makeService();
    const { jobKey } = await runJob(s, ["tok-0"]);
    expect(await code(s.service.createShare(BOB, jobKey, "unlisted"))).toBe("not_found");
    const { slug } = await s.service.createShare(ALICE, jobKey, "private");
    expect(await code(s.service.setShareVisibility(BOB, slug, "public"))).toBe("not_found");
    await s.service.setShareVisibility(ALICE, slug, "public");
    expect((await s.service.getShare(slug)).visibility).toBe("public");
  });

  test("a private share is invisible to everyone but its owner; unlisted and public are open to anyone with the slug", async () => {
    const s = makeService();
    const { jobKey } = await runJob(s, ["tok-0"]);
    const { slug: priv } = await s.service.createShare(ALICE, jobKey, "private");
    expect(await code(s.service.getShare(priv))).toBe("not_found");
    expect(await code(s.service.getShare(priv, BOB))).toBe("not_found");
    expect((await s.service.getShare(priv, ALICE)).visibility).toBe("private");

    const { slug: unlisted } = await s.service.createShare(ALICE, jobKey, "unlisted");
    expect((await s.service.getShare(unlisted)).visibility).toBe("unlisted"); // no account needed
  });

  test("a wallet job can never be shared beyond private", async () => {
    const s = makeService();
    const { jobKey } = await runJob(s, ["tok-0"], ALICE, true);
    expect(await code(s.service.createShare(ALICE, jobKey, "unlisted"))).toBe("invalid");
    expect(await code(s.service.createShare(ALICE, jobKey, "public"))).toBe("invalid");
    const { visibility } = await s.service.createShare(ALICE, jobKey, "private");
    expect(visibility).toBe("private");
  });

  test("a job quoted from a template records the template's current version on its share (§11.4, day1.md #21)", async () => {
    const templates = new MemoryTemplateRegistry();
    await templates.register(
      defineTemplate({
        slug: "holder-check",
        product: "fanout",
        title: "Holder check",
        params: z.object({ items: z.array(z.string()) }),
        columns: COLUMNS,
        defaultTier: "standard",
        safetyClass: "public",
        example: { items: ["tok-0"] },
        pricebookKey: "fanout.job",
        build: (p) => ({ task: "Holder count for each token.", items: p.items }),
      }),
    );
    const s = makeService({ templates });
    const quote = await s.service.quote(ALICE, { ...input(["tok-0"]), templateId: "holder-check" });
    const { job } = await s.service.prepare(ALICE, quote.quoteId, "wallet", WALLET);
    const stored = (await s.store.getJob(job.jobKey))!;
    s.escrow.markFunded(stored.jobId, WALLET);
    await s.service.confirm(ALICE, job.jobKey);
    await s.service.finished(job.jobKey);

    const { slug } = await s.service.createShare(ALICE, job.jobKey, "unlisted");
    const raw = await s.store.getShare(slug);
    expect(raw?.templateVersion).toBe(1);

    await templates.bump(
      defineTemplate({
        slug: "holder-check",
        product: "fanout",
        title: "Holder check v2",
        params: z.object({ items: z.array(z.string()) }),
        columns: COLUMNS,
        defaultTier: "standard",
        safetyClass: "public",
        example: { items: ["tok-0"] },
        pricebookKey: "fanout.job",
        build: (p) => ({ task: "Holder count for each token, v2.", items: p.items }),
      }),
    );
    const quote2 = await s.service.quote(ALICE, { ...input(["tok-1"]), templateId: "holder-check" });
    expect(quote2 && (await s.store.getQuote(quote2.quoteId))?.spec.templateVersion).toBe(2);
  });

  test("an unknown slug looks the same as one that does not exist, to anyone", async () => {
    const s = makeService();
    expect(await code(s.service.getShare("no-such-slug"))).toBe("not_found");
  });
});

describe("referrals and credits (§11.4, §10.3)", () => {
  test("a referral code is stable per account", async () => {
    const s = makeService();
    const code1 = await s.service.referralCode(ALICE);
    const code2 = await s.service.referralCode(ALICE);
    expect(code1).toBe(code2);
    expect(await s.service.referralCode(BOB)).not.toBe(code1);
  });

  test("a clean referral credits the referee on signup, and the referrer once the referee's job qualifies", async () => {
    const s = makeService();
    const refCode = await s.service.referralCode(ALICE);
    const signup = await s.service.registerReferral(BOB, refCode, { sameDevice: false, sameIpPrefix: false, fundingLinked: false });
    expect(signup.state).toBe("pending");
    expect(await s.service.creditBalance(BOB)).toBe("0.50");
    expect(await s.service.creditBalance(ALICE)).toBe("0.00");

    const { jobKey } = await runJob(s, ["tok-0", "tok-1", "tok-2", "tok-3"], BOB); // $0.31, above the $1 floor? see next test for the floor case
    await s.service.onJobFinalized(jobKey);
    // $0.31 is below the $1 qualifying minimum: no referrer credit yet.
    expect(await s.service.creditBalance(ALICE)).toBe("0.00");
  });

  /**
   * A real job's settled amount depends on how many rows the engine actually
   * completes inside the quote's budget (the dry-run estimate can undershoot
   * on a wider job, so some rows finish past the cap and are refunded — the
   * fixed-price guarantee working as intended, not a bug). To keep this test
   * about the referral/credit logic alone, it runs a small job that reliably
   * settles in full, then raises its recorded gross past the $1 floor directly.
   */
  async function makeQualifyingJob(s: ReturnType<typeof makeService>, account: Account, grossUsd6 = 2_000_000n) {
    const { jobKey } = await runJob(s, ["tok-0", "tok-1", "tok-2", "tok-3"], account);
    const job = (await s.store.getJob(jobKey))!;
    await s.store.updateJob(jobKey, { amounts: { ...job.amounts!, grossUsd6 } });
    return jobKey;
  }

  test("the referrer is credited once a qualifying ($1+) job finishes, and not twice", async () => {
    const s = makeService();
    const refCode = await s.service.referralCode(ALICE);
    await s.service.registerReferral(BOB, refCode, { sameDevice: false, sameIpPrefix: false, fundingLinked: false });

    const jobKey = await makeQualifyingJob(s, BOB);
    await s.service.onJobFinalized(jobKey);
    expect(await s.service.creditBalance(ALICE)).toBe("1.00");

    // A second qualifying job for the same referee does not pay the referrer again.
    const jobKey2 = await makeQualifyingJob(s, BOB);
    await s.service.onJobFinalized(jobKey2);
    expect(await s.service.creditBalance(ALICE)).toBe("1.00");
  });

  test("self-referral is refused outright", async () => {
    const s = makeService();
    const refCode = await s.service.referralCode(ALICE);
    expect(await code(s.service.registerReferral(ALICE, refCode, { sameDevice: false, sameIpPrefix: false, fundingLinked: false }))).toBe(
      "invalid",
    );
  });

  test("a shared device, shared IP, or a funding link within 3 hops blocks the credit but still records the referral", async () => {
    for (const signals of [
      { sameDevice: true, sameIpPrefix: false, fundingLinked: false },
      { sameDevice: false, sameIpPrefix: true, fundingLinked: false },
      { sameDevice: false, sameIpPrefix: false, fundingLinked: true },
    ]) {
      const s = makeService();
      const refCode = await s.service.referralCode(ALICE);
      const result = await s.service.registerReferral(BOB, refCode, signals);
      expect(result.state).toBe("blocked");
      expect(result.blockReason).toBeDefined();
      expect(await s.service.creditBalance(BOB)).toBe("0.00"); // no signup credit either
    }
  });

  test("one account can only ever be referred once", async () => {
    const s = makeService();
    const refCode = await s.service.referralCode(ALICE);
    await s.service.registerReferral(BOB, refCode, { sameDevice: false, sameIpPrefix: false, fundingLinked: false });
    expect(await code(s.service.registerReferral(BOB, refCode, { sameDevice: false, sameIpPrefix: false, fundingLinked: false }))).toBe(
      "invalid",
    );
  });

  test("a made-up referral code is treated as a self-referral attempt and refused", async () => {
    const s = makeService();
    expect(await code(s.service.registerReferral(BOB, "not-a-real-code", { sameDevice: false, sameIpPrefix: false, fundingLinked: false }))).toBe(
      "invalid",
    );
  });

  test("onJobFinalized is a safe no-op for a job that is not a referee's qualifying job", async () => {
    const s = makeService();
    const { jobKey } = await runJob(s, ["tok-0"], ALICE); // no referral at all
    await s.service.onJobFinalized(jobKey); // must not throw
    expect(await s.service.creditBalance(ALICE)).toBe("0.00");
  });

  test("the referrer's monthly cap stops further credits and marks the referral blocked instead of paid", async () => {
    const s = makeService();
    // Fifty already-paid referrals this month for Alice, then one more pending referral tries to qualify.
    for (let i = 0; i < 50; i++) {
      await s.store.putReferral({
        id: `r${i}`,
        refCode: "x",
        referrerAccountId: ALICE.id,
        refereeAccountId: `acct-old-${i}`,
        state: "paid",
        createdAtMs: s.clock.now,
      });
    }
    const refCode = await s.service.referralCode(ALICE);
    await s.service.registerReferral(BOB, refCode, { sameDevice: false, sameIpPrefix: false, fundingLinked: false });
    const jobKey = await makeQualifyingJob(s, BOB); // comfortably above $1, so the cap path is the reason for the refusal, not the floor
    await s.service.onJobFinalized(jobKey);
    expect(await s.service.creditBalance(ALICE)).toBe("0.00");
    expect((await s.store.getReferralByReferee(BOB.id))!.state).toBe("blocked");
  });
});
