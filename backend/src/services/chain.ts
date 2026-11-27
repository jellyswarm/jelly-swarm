import {
  createPublicClient,
  defineChain,
  fallback,
  getAddress,
  http,
  parseEventLogs,
  parseUnits,
  type Hash,
} from "viem";

export const escrowAbi = [
  {
    type: "event",
    name: "JobFunded",
    anonymous: false,
    inputs: [
      { indexed: true, name: "jobId", type: "bytes32" },
      { indexed: true, name: "client", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "settleJob",
    stateMutability: "nonpayable",
    inputs: [
      { name: "jobId", type: "bytes32" },
      { name: "clientShareBps", type: "uint16" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "JobSettled",
    anonymous: false,
    inputs: [
      { indexed: true, name: "jobId", type: "bytes32" },
      { indexed: true, name: "client", type: "address" },
      { indexed: false, name: "clientAmount", type: "uint256" },
      { indexed: false, name: "treasuryAmount", type: "uint256" },
      { indexed: false, name: "clientShareBps", type: "uint16" },
      { indexed: false, name: "nonce", type: "uint256" },
    ],
  },
] as const;

export function getChainConfig() {
  const id = Number(process.env.ELYSIUM_CHAIN_ID);
  const rpcUrl = process.env.ELYSIUM_RPC_URL;
  if (!Number.isSafeInteger(id) || id <= 0 || !rpcUrl) {
    throw new Error("elysium_config_missing");
  }
  return defineChain({
    id,
    name: "Elysium",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function getChainClient() {
  const chain = getChainConfig();
  const primary = process.env.ELYSIUM_RPC_URL!;
  const backup = process.env.ELYSIUM_BACKUP_RPC_URL;
  const transport = backup ? fallback([http(primary), http(backup)]) : http(primary);
  return createPublicClient({ chain, transport });
}

export function getPaymentConfig() {
  const escrow = process.env.ESCROW_CONTRACT_ADDRESS;
  const usdc = process.env.ELYSIUM_USDC_ADDRESS;
  const pricePerAgent = process.env.PRICE_PER_AGENT_USDC;
  if (!escrow || !usdc || !pricePerAgent) throw new Error("payment_config_missing");
  if (!/^0x[\da-fA-F]{40}$/.test(escrow) || !/^0x[\da-fA-F]{40}$/.test(usdc)) {
    throw new Error("payment_config_invalid");
  }
  const pricePerCallBaseUnits = parseUnits(pricePerAgent, 6);
  if (pricePerCallBaseUnits <= 0n) throw new Error("payment_config_invalid");
  return { escrow: getAddress(escrow), usdc: getAddress(usdc), pricePerCallBaseUnits };
}

export async function assertPaymentReadiness() {
  const chain = getChainConfig();
  if (chain.id !== 99_901) throw new Error("elysium_mainnet_chain_id_mismatch");
  const payment = getPaymentConfig();
  const client = getChainClient();
  const [actualChainId, escrowCode, usdcCode] = await Promise.all([
    client.getChainId(),
    client.getCode({ address: payment.escrow }),
    client.getCode({ address: payment.usdc }),
  ]);
  if (actualChainId !== chain.id) throw new Error("elysium_rpc_chain_id_mismatch");
  if (!escrowCode || escrowCode === "0x" || !usdcCode || usdcCode === "0x") {
    throw new Error("payment_contract_not_deployed");
  }
  if (!process.env.OPEN_ROUTER_API_KEY || !process.env.OPENROUTER_MODEL) {
    throw new Error("agent_provider_not_configured");
  }
  return { ...payment, chain };
}

export async function verifyFundingReceipt(input: {
  transactionHash: Hash;
  jobId: `0x${string}`;
  clientAddress: `0x${string}`;
  amountBaseUnits: bigint;
}) {
  const { escrow } = getPaymentConfig();
  const client = getChainClient();
  const receipt = await client.getTransactionReceipt({ hash: input.transactionHash });
  if (receipt.status !== "success") return false;
  const head = await client.getBlockNumber();
  if (head < receipt.blockNumber + 2n) return false;

  const events = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "JobFunded" });
  return events.some(({ address, args }) =>
    address.toLowerCase() === escrow.toLowerCase() &&
    args.jobId.toLowerCase() === input.jobId.toLowerCase() &&
    args.client.toLowerCase() === input.clientAddress.toLowerCase() &&
    args.amount === input.amountBaseUnits
  );
}

export async function verifySettlementReceipt(input: {
  transactionHash: Hash;
  jobId: `0x${string}`;
  clientShareBps: number;
}) {
  const { escrow } = getPaymentConfig();
  const client = getChainClient();
  const receipt = await client.getTransactionReceipt({ hash: input.transactionHash });
  if (receipt.status !== "success") return false;
  const head = await client.getBlockNumber();
  if (head < receipt.blockNumber + 2n) return false;
  const events = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "JobSettled" });
  return events.some(({ address, args }) =>
    address.toLowerCase() === escrow.toLowerCase() &&
    args.jobId.toLowerCase() === input.jobId.toLowerCase() &&
    args.clientShareBps === input.clientShareBps
  );
}
