import { ethers } from 'ethers';

let provider: ethers.JsonRpcProvider | null = null;

export async function initRpcApi(
  apiUrl: string,
  chainId: number,
): Promise<void> {
  const tempProvider = new ethers.JsonRpcProvider(apiUrl, chainId);
  const network = await tempProvider._detectNetwork();
  if (BigInt(chainId) !== network.chainId) {
    throw new Error(
      `Chain ID ${chainId.toString()} provided, but the configured API URL ${apiUrl} is for chain ID ${network.chainId.toString()} (${
        network.name
      })`,
    );
  }
  provider = new ethers.JsonRpcProvider(apiUrl, chainId, {
    staticNetwork: network,
  });
}

export function loadProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    throw new Error(
      'RPC API not configured. Call initRpcApi before making API calls.',
    );
  }
  return provider;
}

/**
 * Wrapper around ethers `waitForDeployment` that retries with exponential
 * backoff on "transaction not found" errors. Load-balanced RPCs may not
 * propagate a newly-broadcast transaction to every read replica immediately,
 * so the first few look-ups can fail transiently.
 */
export async function waitForDeployment<T extends ethers.BaseContract>(
  contract: T,
  maxRetries = 5,
  baseDelayMs = 1000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await contract.waitForDeployment();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const isTransient = message.includes('transaction not found');
      if (!isTransient || attempt === maxRetries) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, baseDelayMs * 2 ** attempt);
      });
    }
  }
  throw new Error('waitForDeployment: max retries exceeded');
}
