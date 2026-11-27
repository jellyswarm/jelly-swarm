import { describe, expect, test } from "bun:test";
import { type Hex, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AGENT_ID,
  NO_ROW,
  type ReceiptBody,
  ReceiptChain,
  type SignedReceipt,
  ZERO32,
  attestationRef,
  canonicalJson,
  hashJson,
  hashLabel,
  merkleProof,
  merkleRoot,
  receiptDomain,
  verifyChain,
  verifyProof,
} from "./index";

// Well-known anvil test keys. Never used outside tests.
const signer = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const other = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const domain = {
  chainId: 8453,
  verifyingContract: "0x00000000000000000000000000000000000000aa",
  salt: keccak256(toBytes("fanout")),
} as const;

const jobKey = keccak256(toBytes("job-1"));
const body = (n: number, over: Partial<ReceiptBody> = {}): ReceiptBody => ({
  jobKey,
  agentId: AGENT_ID.worker((n % 247) + 1),
  role: 2,
  rowIdx: n,
  inputHash: hashJson({ n, in: true }),
  toolCallsHash: hashJson([]),
  modelId: hashLabel("deepseek-v4-flash"),
  host: hashLabel("router-a"),
  costMicros: BigInt(1000 + n),
  outputHash: hashJson({ n, out: true }),
  attestationRef: ZERO32,
  ...over,
});

const leaf = (i: number): Hex => keccak256(toBytes(`leaf-${i}`));

describe("canonical hashing", () => {
  test("key order does not change the hash", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(hashJson({ b: 1, a: 2 })).toBe(hashJson({ a: 2, b: 1 }));
  });
  test("bigint and undefined are handled", () => {
    expect(canonicalJson({ n: 5n, gone: undefined })).toBe('{"n":"5"}');
  });
  test("different values hash differently", () => {
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
    expect(hashLabel("phala")).not.toBe(hashLabel("node:7"));
  });
  test("attestation ref binds both the receipt id and the quote hash", () => {
    const q = keccak256(toBytes("quote"));
    expect(attestationRef("r-1", q)).not.toBe(attestationRef("r-2", q));
    expect(attestationRef("r-1", q)).not.toBe(attestationRef("r-1", keccak256(toBytes("other"))));
  });
});

describe("merkle tree", () => {
  test("empty and single-leaf trees", () => {
    expect(merkleRoot([])).toBe(ZERO32);
    expect(merkleRoot([leaf(0)])).toBe(leaf(0));
    expect(verifyProof(leaf(0), merkleProof([leaf(0)], 0), leaf(0))).toBe(true);
  });

  test("every leaf proves against the root, for many tree sizes", () => {
    for (const n of [2, 3, 4, 5, 7, 8, 9, 31, 250, 251]) {
      const leaves = Array.from({ length: n }, (_, i) => leaf(i));
      const root = merkleRoot(leaves);
      for (let i = 0; i < n; i++) {
        expect(verifyProof(leaves[i]!, merkleProof(leaves, i), root)).toBe(true);
      }
    }
  });

  test("a wrong leaf or a tampered proof fails", () => {
    const leaves = Array.from({ length: 9 }, (_, i) => leaf(i));
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, 3);
    expect(verifyProof(leaf(99), proof, root)).toBe(false);
    expect(verifyProof(leaves[3]!, [...proof.slice(0, -1), leaf(99)], root)).toBe(false);
    expect(verifyProof(leaves[3]!, proof, merkleRoot(leaves.slice(0, 8)))).toBe(false);
  });
});

describe("receipt chain (§4)", () => {
  test("the EIP-712 domain uses the public product name only", () => {
    expect(receiptDomain(domain).name).toBe("JellySwarm Receipts");
    expect(receiptDomain(domain).version).toBe("1");
  });

  test("worker agent ids are capped at 247", () => {
    expect(AGENT_ID.worker(247)).toBe(247);
    expect(() => AGENT_ID.worker(248)).toThrow();
    expect(() => AGENT_ID.worker(0)).toThrow();
  });

  test("250 concurrent appends stay strictly sequential and verify", async () => {
    const chain = new ReceiptChain(domain, signer);
    const planner = chain.append(body(0, { agentId: AGENT_ID.planner, role: 1, rowIdx: NO_ROW }));
    const workers = Array.from({ length: 249 }, (_, i) => chain.append(body(i + 1)));
    await Promise.all([planner, ...workers]);

    const receipts = chain.receipts(jobKey);
    expect(receipts.length).toBe(250);
    expect(receipts.map((r) => r.stepIdx)).toEqual(Array.from({ length: 250 }, (_, i) => i));
    expect(receipts[0]!.prevHash).toBe(ZERO32);
    for (let i = 1; i < receipts.length; i++) expect(receipts[i]!.prevHash).toBe(receipts[i - 1]!.leaf);

    const result = await verifyChain(receipts, domain, signer.address);
    expect(result.ok).toBe(true);
    const seal = await chain.seal(jobKey);
    expect(result).toEqual({ ok: true, seal });
    expect(seal.count).toBe(250);
    expect(seal.head).toBe(receipts.at(-1)!.leaf);
    expect(verifyProof(receipts[123]!.leaf, merkleProof(receipts.map((r) => r.leaf), 123), seal.root)).toBe(true);
  });

  test("jobs have independent chains", async () => {
    const chain = new ReceiptChain(domain, signer);
    const otherJob = keccak256(toBytes("job-2"));
    await chain.append(body(0));
    await chain.append(body(0, { jobKey: otherJob }));
    await chain.append(body(1));
    expect(chain.receipts(jobKey).map((r) => r.stepIdx)).toEqual([0, 1]);
    expect(chain.receipts(otherJob).map((r) => r.stepIdx)).toEqual([0]);
  });

  const build = async (n: number): Promise<SignedReceipt[]> => {
    const chain = new ReceiptChain(domain, signer);
    for (let i = 0; i < n; i++) await chain.append(body(i));
    return [...chain.receipts(jobKey)];
  };

  test("changing any field breaks verification at that step", async () => {
    const receipts = await build(5);
    const tampered = receipts.map((r, i) => (i === 2 ? { ...r, costMicros: 1n } : r));
    expect(await verifyChain(tampered, domain, signer.address)).toMatchObject({ ok: false, stepIdx: 2 });
  });

  test("dropping, reordering or inserting a receipt is detected", async () => {
    const receipts = await build(5);
    const dropped = [...receipts.slice(0, 2), ...receipts.slice(3)];
    expect(await verifyChain(dropped, domain, signer.address)).toMatchObject({ ok: false, stepIdx: 2 });
    const swapped = [receipts[0]!, receipts[2]!, receipts[1]!, receipts[3]!, receipts[4]!];
    expect(await verifyChain(swapped, domain, signer.address)).toMatchObject({ ok: false, stepIdx: 1 });
  });

  test("a chain signed by a different key is rejected", async () => {
    const receipts = await build(3);
    expect(await verifyChain(receipts, domain, other.address)).toMatchObject({ ok: false, stepIdx: 0 });
  });

  test("a receipt cannot be replayed under another domain", async () => {
    const receipts = await build(2);
    const otherDomain = { ...domain, salt: keccak256(toBytes("trawl")) };
    expect((await verifyChain(receipts, otherDomain, signer.address)).ok).toBe(false);
  });

  test("attestation and node signature travel with the receipt", async () => {
    const chain = new ReceiptChain(domain, signer);
    const q = keccak256(toBytes("tdx"));
    const r = await chain.append(body(0, { attestationRef: attestationRef("rid", q) }), {
      attestation: { receiptId: "rid", quoteHash: q },
      nodeSignature: "0x1234",
    });
    expect(r.attestation).toEqual({ receiptId: "rid", quoteHash: q });
    expect(r.nodeSignature).toBe("0x1234");
    expect((await verifyChain([r], domain, signer.address)).ok).toBe(true);
  });
});
