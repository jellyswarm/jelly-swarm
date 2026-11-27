import React, { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { getAccount, switchChain, watchAccount } from "wagmi/actions";
import { config, elysium } from "./wallet.js";

const GateContext = createContext(async () => {
  throw new Error("Wallet not ready.");
});

/**
 * `ensureWallet()` resolves with the connected address once the user has picked a wallet in
 * RainbowKit and is on Elysium. Closing the picker without connecting rejects it.
 */
export function WalletGate({ children }) {
  const { openConnectModal, connectModalOpen } = useConnectModal();
  const closeWaiters = useRef(new Set());
  const wasOpen = useRef(false);
  const openRef = useRef(openConnectModal);
  openRef.current = openConnectModal;

  useEffect(() => {
    if (wasOpen.current && !connectModalOpen) {
      // Give wagmi a moment to report the new account before treating the close as a cancel.
      setTimeout(() => closeWaiters.current.forEach((fn) => fn()), 300);
    }
    wasOpen.current = connectModalOpen;
  }, [connectModalOpen]);

  const ensureWallet = useCallback(async () => {
    let account = getAccount(config);
    if (!account.isConnected) {
      if (!openRef.current) throw new Error("The wallet picker is still loading. Try again in a moment.");
      openRef.current();
      account = await new Promise((resolve, reject) => {
        const stop = watchAccount(config, {
          onChange(next) {
            if (!next.isConnected) return;
            cleanup();
            resolve(next);
          },
        });
        const onClose = () => {
          if (getAccount(config).isConnected) return;
          cleanup();
          reject(new Error("Connect a wallet to continue."));
        };
        closeWaiters.current.add(onClose);
        function cleanup() {
          stop();
          closeWaiters.current.delete(onClose);
        }
      });
    }
    if (account.chainId !== elysium.id) {
      try {
        await switchChain(config, { chainId: elysium.id });
      } catch (e) {
        if (e?.name === "UserRejectedRequestError" || e?.code === 4001) {
          throw new Error("You declined the network switch. JellySwarm runs on Elysium.");
        }
        throw new Error("Please switch your wallet to Elysium to continue.");
      }
    }
    return getAccount(config).address;
  }, []);

  return <GateContext.Provider value={ensureWallet}>{children}</GateContext.Provider>;
}

export const useEnsureWallet = () => useContext(GateContext);
