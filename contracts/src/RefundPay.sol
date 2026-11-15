// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBalanceVault} from "./Interfaces.sol";

/// @notice How every refund is paid. A refund to a wallet is a plain transfer. A refund
///         for a vault-funded job is credited back to the owner's vault balance; if that
///         credit fails for any reason, the money goes straight to the owner instead, so
///         a refund can never be blocked by the vault.
library RefundPay {
    using SafeERC20 for IERC20;

    function pay(IERC20 token, address vault, address client, address refundTo, uint256 amount) internal {
        if (amount == 0) return;
        if (refundTo == vault && vault != address(0)) {
            token.forceApprove(vault, amount);
            try IBalanceVault(vault).depositFor(client, amount) {
                return;
            } catch {
                token.forceApprove(vault, 0);
                token.safeTransfer(client, amount);
                return;
            }
        }
        token.safeTransfer(refundTo, amount);
    }
}
