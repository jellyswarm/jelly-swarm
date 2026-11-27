import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  getAddress,
  http,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const erc20Abi = [
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

export function getChainConfig() {
  const id = Number(process.env.ELYSIUM_CHAIN_ID);
  const rpcUrl = process.env.ELYSIUM_RPC_URL;
  if (!Number.isSafeInteger(id) || id <= 0 || !rpcUrl) throw new Error("elysium_config_missing");
  return defineChain({
    id,
    name: "Elysium",
    nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

function getTransport() {
  const primary = process.env.ELYSIUM_RPC_URL;
  if (!primary) throw new Error("elysium_config_missing");
  const backup = process.env.ELYSIUM_BACKUP_RPC_URL;
  return backup ? fallback([http(primary), http(backup)]) : http(primary);
}

export function getChainClient() {
  return createPublicClient({ chain: getChainConfig(), transport: getTransport() });
}

export function getPaymentConfig() {
  const escrowPublicKey = process.env.ESCROW_PUBLIC_KEY;
  const usdcAddress = process.env.ELYSIUM_USDC_ADDRESS;
  const treasuryPublicKey = process.env.TREASURY_PUBLIC_KEY;
  const pricePerAgent = process.env.PRICE_PER_AGENT_USDC;
  if (!escrowPublicKey || !usdcAddress || !treasuryPublicKey || !pricePerAgent) throw new Error("payment_config_missing");
  if (!/^0x[\da-fA-F]{40}$/.test(escrowPublicKey) || !/^0x[\da-fA-F]{40}$/.test(usdcAddress) || !/^0x[\da-fA-F]{40}$/.test(treasuryPublicKey)) {
    throw new Error("payment_config_invalid");
  }
  const pricePerAgentBaseUnits = parseUnits(pricePerAgent, 6);
  if (pricePerAgentBaseUnits <= 0n) throw new Error("payment_config_invalid");
  return {
    escrow: getAddress(escrowPublicKey),
    usdc: getAddress(usdcAddress),
    treasury: getAddress(treasuryPublicKey),
    pricePerAgentBaseUnits,
  };
}

function getEscrowAccount() {
  const configuredAddress = process.env.ESCROW_PUBLIC_KEY;
  const rawKey = process.env.ESCROW_PRIVATE_KEY;
  if (!configuredAddress || !rawKey) throw new Error("escrow_wallet_not_configured");
  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
  if (!/^0x[\da-fA-F]{64}$/.test(privateKey)) throw new Error("escrow_private_key_invalid");
  const account = privateKeyToAccount(privateKey);
  if (account.address.toLowerCase() !== configuredAddress.toLowerCase()) {
    throw new Error("escrow_wallet_key_mismatch");
  }
  return account;
}

export function getEscrowWalletClient() {
  return createWalletClient({ account: getEscrowAccount(), chain: getChainConfig(), transport: getTransport() });
}

export async function assertPaymentReadiness() {
  const chain = getChainConfig();
  if (chain.id !== 99_901) throw new Error("elysium_mainnet_chain_id_mismatch");
  const payment = getPaymentConfig();
  getEscrowAccount();
  const client = getChainClient();
  const [actualChainId, usdcCode, symbol, decimals] = await Promise.all([
    client.getChainId(),
    client.getCode({ address: payment.usdc }),
    client.readContract({ address: payment.usdc, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: payment.usdc, abi: erc20Abi, functionName: "decimals" }),
  ]);
  if (actualChainId !== chain.id) throw new Error("elysium_rpc_chain_id_mismatch");
  if (!usdcCode || usdcCode === "0x" || symbol !== "USDC" || decimals !== 6) {
    throw new Error("elysium_usdc_mismatch");
  }
  if (!process.env.OPEN_ROUTER_API_KEY || !process.env.OPENROUTER_MODEL) {
    throw new Error("agent_provider_not_configured");
  }
  return { ...payment, chain };
}

export async function verifyFundingReceipt(input: {
  transactionHash: Hash;
  clientAddress: Address;
  amountBaseUnits: bigint;
}) {
  const { escrow, usdc } = getPaymentConfig();
  const client = getChainClient();
  const receipt = await client.getTransactionReceipt({ hash: input.transactionHash });
  if (receipt.status !== "success") return false;
  const head = await client.getBlockNumber();
  if (head < receipt.blockNumber + 2n) return false;
  const events = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" });
  return events.some(({ address, args }) =>
    address.toLowerCase() === usdc.toLowerCase() &&
    args.from.toLowerCase() === input.clientAddress.toLowerCase() &&
    args.to.toLowerCase() === escrow.toLowerCase() &&
    args.value === input.amountBaseUnits
  );
}

export async function sendEscrowTransfer(to: Address, amount: bigint): Promise<Hash> {
  const { usdc } = getPaymentConfig();
  return getEscrowWalletClient().writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, amount],
  });
}

export async function verifyEscrowTransfer(input: {
  transactionHash: Hash;
  recipient: Address;
  amountBaseUnits: bigint;
}) {
  const { escrow, usdc } = getPaymentConfig();
  const client = getChainClient();
  const receipt = await client.getTransactionReceipt({ hash: input.transactionHash });
  if (receipt.status !== "success") return false;
  const head = await client.getBlockNumber();
  if (head < receipt.blockNumber + 2n) return false;
  const events = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" });
  return events.some(({ address, args }) =>
    address.toLowerCase() === usdc.toLowerCase() &&
    args.from.toLowerCase() === escrow.toLowerCase() &&
    args.to.toLowerCase() === input.recipient.toLowerCase() &&
    args.value === input.amountBaseUnits
  );
}
