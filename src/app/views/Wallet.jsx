import React from "react";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { useAccountModal, useChainModal } from "@rainbow-me/rainbowkit";
import { erc20Abi } from "viem";
import { EXPLORER, USDC, elysium } from "../wallet.js";
import { formatUsdc, short } from "../lib.js";
import { useToast } from "../Toasts.jsx";
import { useEnsureWallet } from "../WalletGate.jsx";

export default function WalletView() {
  const { address, isConnected, chainId } = useAccount();
  const { openAccountModal } = useAccountModal();
  const { openChainModal } = useChainModal();
  const ensureWallet = useEnsureWallet();
  const toast = useToast();
  const usdc = useReadContract({
    chainId: elysium.id,
    address: USDC,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const hype = useBalance({ chainId: elysium.id, address, query: { enabled: Boolean(address) } });

  if (!isConnected) {
    return (
      <div className="panel connect-card">
        <img src="/media/jelly-cube.png" alt="" />
        <span className="eyebrow">Wallet</span>
        <h2>Connect a wallet to pay for jobs.</h2>
        <p className="muted">
          Pick any EVM wallet. You'll pay in USDC on Elysium and need a little HYPE for gas. JellySwarm never sees your keys.
        </p>
        <button className="button primary" type="button" onClick={() => ensureWallet().catch((e) => toast(e.message, "warn"))}>
          Connect wallet
        </button>
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      toast("Address copied.", "success");
    } catch {
      toast("Couldn't copy. Select the address and copy it instead.", "warn");
    }
  };
  const show = (q, fmt) => (q.isLoading ? "…" : q.isError || q.data == null ? "—" : fmt(q.data));

  return (
    <div className="wallet-grid">
      <div>
        <div className="address-card">
          <span className="eyebrow">Connected wallet</span>
          <div className="addr">{address}</div>
          <div className="actions">
            <button className="button light small" type="button" onClick={copy}>
              Copy address
            </button>
            <a className="button light small" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noopener">
              View on explorer
            </a>
            <button className="button light small" type="button" onClick={openAccountModal}>
              Manage
            </button>
          </div>
        </div>
        <div className="balance-row">
          <div className="balance">
            <span className="eyebrow">USDC</span>
            <strong>{show(usdc, formatUsdc)}</strong>
            <small>For paying jobs</small>
          </div>
          <div className="balance">
            <span className="eyebrow">HYPE</span>
            <strong>{show(hype, (b) => (Number(b.value) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 4 }))}</strong>
            <small>For gas</small>
          </div>
        </div>
        {chainId !== elysium.id && (
          <div className="notice" style={{ marginTop: 14 }}>
            Your wallet is on another network.{" "}
            <button className="copy-btn" type="button" onClick={openChainModal}>
              Switch to Elysium
            </button>
          </div>
        )}
      </div>
      <aside className="panel">
        <span className="eyebrow">Network</span>
        <h2 style={{ fontSize: 24, margin: "8px 0 14px" }}>Elysium</h2>
        <dl className="kv">
          <div>
            <dt>Chain ID</dt>
            <dd>99901</dd>
          </div>
          <div>
            <dt>Gas token</dt>
            <dd>HYPE</dd>
          </div>
          <div>
            <dt>USDC</dt>
            <dd>{short(USDC, 8, 6)}</dd>
          </div>
          <div>
            <dt>Explorer</dt>
            <dd>
              <a href={EXPLORER} target="_blank" rel="noopener">
                elysium.kinetiq.xyz
              </a>
            </dd>
          </div>
        </dl>
        <p className="fine left" style={{ marginTop: 16 }}>
          Each job is one USDC transfer you approve yourself. JellySwarm never asks for approvals or signatures beyond that.
        </p>
      </aside>
    </div>
  );
}
