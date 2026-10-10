import { type Address, type Hex, encodeFunctionData } from 'viem';
import { Abis } from 'viem/tempo';
import { memoBytes } from './memo';

/** The one function a payout key is scoped to. */
export const TRANSFER_WITH_MEMO = 'transferWithMemo(address,uint256,bytes32)';
export const TRANSFER_WITH_MEMO_SELECTOR: Hex = '0x95777d59';
export const TRANSFER_SELECTOR: Hex = '0xa9059cbb';

/** keccak256 of `TransferWithMemo(address,address,uint256,bytes32)` and of `Transfer(address,address,uint256)`. */
export const TRANSFER_WITH_MEMO_TOPIC: Hex = '0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0';
export const TRANSFER_TOPIC: Hex = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface Call {
  to: Address;
  data: Hex;
}

/** `memo` is the readable reference; it is encoded here, left-aligned, as the chain expects it. */
export function transferWithMemoCall(token: Address, to: Address, amount: bigint, memo: string): Call {
  return {
    to: token,
    data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo', args: [to, amount, memoBytes(memo)] }),
  };
}

export function transferCall(token: Address, to: Address, amount: bigint): Call {
  return { to: token, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transfer', args: [to, amount] }) };
}
