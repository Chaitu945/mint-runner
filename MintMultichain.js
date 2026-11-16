/**
 * Educational example: multi-wallet, multi-chain NFT mint script.
 *
 * Supports running the same mint logic across multiple chains (e.g.
 * Ethereum + Robinhood Chain) from one config, either sequentially
 * or in parallel.
 *
 * Install deps first:
 *   npm init -y && npm install ethers dotenv
 */

require('dotenv').config();
const { ethers } = require('ethers');

// ---- CHAIN CONFIG -------------------------------------------------------
// Add/remove chains here. Each chain has its own RPC, contract, wallets,
// and gas ceiling — L2 gas is usually far cheaper than L1, so don't share
// one ceiling across chains.

const CHAINS = {
  ethereum: {
    name: 'Ethereum',
    chainId: 11155111, // Sepolia testnet. Use 1 for mainnet.
    rpcUrl: process.env.ETH_RPC_URL,
    contractAddress: process.env.ETH_CONTRACT_ADDRESS,
    privateKeys: (process.env.ETH_PRIVATE_KEYS || '').split(',').filter(Boolean),
    mintPriceEth: '0.001',
    quantityPerWallet: 1,
    maxPriorityFeeGwei: 2,
    maxFeeGwei: 50,
  },
  robinhood: {
    name: 'Robinhood Chain',
    chainId: 46630, // Robinhood Chain testnet. Use 4663 for mainnet.
    rpcUrl: process.env.RH_RPC_URL,
    contractAddress: process.env.RH_CONTRACT_ADDRESS,
    privateKeys: (process.env.RH_PRIVATE_KEYS || '').split(',').filter(Boolean),
    mintPriceEth: '0.001',
    quantityPerWallet: 1,
    maxPriorityFeeGwei: 0.1,
    maxFeeGwei: 2, // L2 gas is much cheaper — don't reuse Ethereum's ceiling
  },
};

// Which chains to actually run this time. Comment one out to test a
// single chain first, or leave both in to fire simultaneously.
const CHAINS_TO_RUN = ['ethereum', 'robinhood'];

// Minimal ABI matching our TestMintNFT contract. Swap this for the real
// project's ABI (from Etherscan/explorer) when moving off the test contract.
const ABI = ['function mint(uint256 quantity) external payable'];

// ---- CORE LOGIC ----------------------------------------------------------

async function mintFromWallet(chainKey, chainConfig, provider, privateKey, index) {
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(chainConfig.contractAddress, ABI, wallet);
  const label = `[${chainConfig.name}] Wallet #${index} (${wallet.address.slice(0, 8)}…)`;

  try {
    const balance = await provider.getBalance(wallet.address);
    const value = ethers.parseEther(chainConfig.mintPriceEth) * BigInt(chainConfig.quantityPerWallet);

    if (balance < value) {
      console.log(`❌ ${label}: insufficient funds (has ${ethers.formatEther(balance)} ETH, needs ${ethers.formatEther(value)} ETH + gas)`);
      return { chain: chainKey, index, status: 'insufficient_funds' };
    }

    const maxPriorityFeePerGas = ethers.parseUnits(String(chainConfig.maxPriorityFeeGwei), 'gwei');
    const maxFeePerGas = ethers.parseUnits(String(chainConfig.maxFeeGwei), 'gwei');

    const tx = await contract.mint(chainConfig.quantityPerWallet, {
      value,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit: 300000, // rough ceiling; consider estimateGas() for production
    });

    console.log(`⏳ ${label}: submitted ${tx.hash}`);
    const receipt = await tx.wait();

    console.log(`✅ ${label}: minted in block ${receipt.blockNumber}`);
    return { chain: chainKey, index, status: 'success', tx: tx.hash, block: receipt.blockNumber };

  } catch (err) {
    console.log(`❌ ${label}: ${err.reason || err.message}`);
    return { chain: chainKey, index, status: 'error', error: err.reason || err.message };
  }
}

async function mintOnChain(chainKey) {
  const chainConfig = CHAINS[chainKey];

  if (!chainConfig.rpcUrl || !chainConfig.contractAddress || chainConfig.privateKeys.length === 0) {
    console.error(`⚠️  Skipping ${chainConfig.name}: missing RPC URL, contract address, or private keys in .env`);
    return [];
  }

  const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl, chainConfig.chainId);

  console.log(`\n=== ${chainConfig.name}: minting from ${chainConfig.privateKeys.length} wallet(s) ===`);

  return Promise.all(
    chainConfig.privateKeys.map((pk, i) => mintFromWallet(chainKey, chainConfig, provider, pk, i + 1))
  );
}

async function main() {
  // Run all selected chains in parallel. Switch to a for..of loop with
  // await inside if you'd rather run chains one at a time instead.
  const results = await Promise.all(CHAINS_TO_RUN.map(mintOnChain));
  const flat = results.flat();

  console.log('\n=== Summary ===');
  for (const chainKey of CHAINS_TO_RUN) {
    const chainResults = flat.filter(r => r.chain === chainKey);
    const successCount = chainResults.filter(r => r.status === 'success').length;
    console.log(`${CHAINS[chainKey].name}: ${successCount}/${chainResults.length} wallets minted successfully`);
  }
}

main().catch(console.error);