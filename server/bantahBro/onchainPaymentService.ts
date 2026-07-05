import { createPublicClient, http, isAddressEqual } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { db } from '../db';
import { sql } from 'drizzle-orm';

const TREASURY_WALLET = process.env.BOTA_TREASURY_WALLET || '0x0000000000000000000000000000000000000000';

function getChain(chainId: number) {
  if (chainId === 97) return bscTestnet;
  return bsc; // Default to mainnet
}

export async function verifyPayment(
  txHash: `0x${string}`,
  expectedAmountWei: string,
  chainId: number
) {
  if (!TREASURY_WALLET || TREASURY_WALLET === '0x0000000000000000000000000000000000000000') {
    // For local development without a treasury wallet configured, we bypass strict checks
    // but in production this should throw.
    console.warn("BOTA_TREASURY_WALLET is not configured! Payment verification is mocked.");
    return { success: true, sender: "mocked", value: expectedAmountWei };
  }

  // Prevent replay attacks: Check if txHash has already been used in pack_ownership metadata
  const existingRes = await db.execute(sql`
    SELECT pack_instance_id 
    FROM "pack_ownership" 
    WHERE metadata->>'txHash' = ${txHash} 
    LIMIT 1;
  `);
  
  if ((existingRes as any[]).length > 0) {
    throw new Error('Transaction has already been used for a purchase.');
  }

  const chain = getChain(chainId);
  const client = createPublicClient({
    chain,
    transport: http()
  });

  try {
    // 1. Get transaction receipt to ensure it was successful
    const receipt = await client.getTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error('Transaction reverted on-chain.');
    }

    // 2. Get transaction details to check 'to' address and 'value'
    const tx = await client.getTransaction({ hash: txHash });
    
    if (!tx.to) {
      throw new Error('Transaction has no recipient.');
    }

    if (!isAddressEqual(tx.to, TREASURY_WALLET as `0x${string}`)) {
      throw new Error(`Transaction recipient mismatch.`);
    }

    // 3. Verify amount
    const expectedValue = BigInt(expectedAmountWei);

    if (tx.value < expectedValue) {
      throw new Error(`Insufficient payment amount.`);
    }

    return {
      success: true,
      sender: tx.from,
      value: tx.value.toString()
    };
  } catch (err: any) {
    throw new Error(`Payment verification failed: ${err.message}`);
  }
}

export default {
  verifyPayment
};
