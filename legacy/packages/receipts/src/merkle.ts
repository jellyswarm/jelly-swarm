import { type Hex, concat, keccak256 } from "viem";
import { ZERO32 } from "./types";

/**
 * Merkle tree with sorted (commutative) pair hashing, verifiable on-chain by
 * OpenZeppelin's MerkleProof. Leaves stay in receipt order; an unpaired node
 * is promoted to the next level unchanged.
 *
 * Leaves are EIP-712 digests (hash of a 66-byte preimage) and inner nodes
 * hash 64 bytes, so a leaf can never be passed off as an inner node.
 */
export function hashPair(a: Hex, b: Hex): Hex {
  return BigInt(a) <= BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a]));
}

function nextLevel(level: Hex[]): Hex[] {
  const out: Hex[] = [];
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i]!;
    const right = level[i + 1];
    out.push(right === undefined ? left : hashPair(left, right));
  }
  return out;
}

/** Root of the tree over `leaves`. An empty tree has the zero root. */
export function merkleRoot(leaves: readonly Hex[]): Hex {
  if (leaves.length === 0) return ZERO32;
  let level = [...leaves];
  while (level.length > 1) level = nextLevel(level);
  return level[0]!;
}

/** Sibling path for the leaf at `index`. */
export function merkleProof(leaves: readonly Hex[], index: number): Hex[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`leaf index out of range: ${index}`);
  }
  const proof: Hex[] = [];
  let level = [...leaves];
  let i = index;
  while (level.length > 1) {
    const sibling = level[i ^ 1];
    if (sibling !== undefined) proof.push(sibling);
    level = nextLevel(level);
    i >>= 1;
  }
  return proof;
}

/** Same check as OpenZeppelin MerkleProof.verify. */
export function verifyProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  let node = leaf;
  for (const sibling of proof) node = hashPair(node, sibling);
  return node.toLowerCase() === root.toLowerCase();
}
