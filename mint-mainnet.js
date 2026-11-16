/**
 * Mainnet multi-chain, multi-wallet mint script.
 *
 * Config files:
 *   .env         - infra, set once (RPC URLs)
 *   wallets.json - your wallets, add more anytime
 *   mints.json   - named project slots (ETH-1, ETH-2, ETH-3, RH-1, RH-2).
 *                  Fill in the ones you're minting today and set active:true.
 *                  Everything else in the slot stays false/ignored.
 *
 * Optional per-project settings in mints.json:
 *   "stuckTimeoutMs": 6000     how long to wait before speeding up a stuck transaction
 *   "skipSimulation": true     send without testing first (saves ~50-150 ms, but a
 *                              mint that would fail still costs gas)
 *   "gasLimit": 300000         raise for larger quantities
 *
 * Run:
 *   node mint-mainnet.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

// ---- LOAD WALLETS --------------------------------------------------------

const wallets = JSON.parse(fs.readFileSync(path.join(__dirname, 'wallets.json'), 'utf8'))
  .filter(w => w.privateKey && !w.privateKey.includes('REPLACE_ME'));

if (wallets.length === 0) {
  console.error('No valid wallets found in wallets.json. Fill in real private keys first.');
  process.exit(1);
}

// ---- LOAD MINT PROJECTS ---------------------------------------------------

const allMints = JSON.parse(fs.readFileSync(path.join(__dirname, 'mints.json'), 'utf8'));
const activeMints = allMints.filter(m => m.active === true && !String(m.contractAddress).includes('REPLACE_ME'));

if (activeMints.length === 0) {
  console.error('No active mints found in mints.json. Set active:true and fill in real values for at least one slot.');
  process.exit(1);
}

// ---- CHAIN INFRA CONFIG (set once, from .env) -----------------------------

const CHAIN_INFRA = {
  ethereum: {
    name: 'Ethereum',
    chainId: 1,
    rpcUrl: process.env.ETH_RPC_URL,
    backupRpcUrl: process.env.ETH_BACKUP_RPC_URL,
  },
  robinhood: {
    name: 'Robinhood Chain',
    chainId: 4663,
    rpcUrl: process.env.RH_RPC_URL,
    backupRpcUrl: process.env.RH_BACKUP_RPC_URL,
  },
};

const SEADROP_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'; // canonical, same on every chain

const DIRECT_ABI = ['function mint(uint256 quantity) external payable'];
const SEADROP_ABI = [
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) external payable'
];

// Default stuck-tx timeout before bumping gas and resubmitting, per chain.
// Fast public mints can sell out in 5-10s, so these are intentionally short.
// Override per-project via "stuckTimeoutMs" in mints.json.
const DEFAULT_STUCK_TIMEOUT_MS = {
  ethereum: 6000,   // ~half an Ethereum block (12s blocks)
  robinhood: 1500,  // 100ms blocks
};

// After a speed-up, how long to keep watching for either transaction to confirm.
const CONFIRM_TIMEOUT_MS = {
  ethereum: 180000,
  robinhood: 60000,
};
const RECEIPT_POLL_MS = { ethereum: 1000, robinhood: 200 };

const RPC_CHECK_TIMEOUT_MS = 3000;

// ---- HELPERS ---------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Error text without RPC URLs, which can contain your Alchemy key.
function cleanError(err) {
  const text = String(err?.shortMessage || err?.reason || err?.message || err);
  return text.replace(/https?:\/\/[^\s"')]+/g, '<rpc-url>');
}

// Use the main RPC if it answers on the right chain; otherwise fall back to the backup.
async function getProvider(infra) {
  const candidates = [['main', infra.rpcUrl], ['backup', infra.backupRpcUrl]].filter(([, url]) => url);
  for (const [which, url] of candidates) {
    const provider = new ethers.JsonRpcProvider(url, infra.chainId, { staticNetwork: true });
    try {
      const chainIdHex = await withTimeout(provider.send('eth_chainId', []), RPC_CHECK_TIMEOUT_MS, 'no answer within 3s');
      if (Number(chainIdHex) !== infra.chainId) {
        throw new Error(`RPC is on chain ${Number(chainIdHex)}, expected ${infra.chainId}`);
      }
      if (which === 'backup') console.log(`WARNING ${infra.name}: main RPC is down, using backup RPC`);
      return provider;
    } catch (err) {
      console.log(`RPC CHECK ${infra.name} (${which}) failed: ${cleanError(err)}`);
      provider.destroy();
    }
  }
  return null;
}

// Wait until either the original or the sped-up transaction confirms.
// Only one of them can ever confirm, because they share a nonce.
async function waitForEither(provider, hashes, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const hash of hashes) {
      const receipt = await provider.getTransactionReceipt(hash).catch(() => null);
      if (receipt) return receipt;
    }
    await sleep(pollMs);
  }
  return null;
}

// ---- CORE LOGIC ------------------------------------------------------------

async function mintFromWallet(mintConfig, infra, provider, walletInfo) {
  const wallet = new ethers.Wallet(walletInfo.privateKey, provider);
  const label = `[${mintConfig.slot} ${mintConfig.projectName}] ${walletInfo.label} (${wallet.address.slice(0, 8)}...)`;
  const base = { slot: mintConfig.slot, project: mintConfig.projectName, wallet: walletInfo.label };

  const isSeaDrop = mintConfig.mintType === 'seadrop';
  const targetAddress = isSeaDrop ? SEADROP_ADDRESS : mintConfig.contractAddress;
  const abi = isSeaDrop ? SEADROP_ABI : DIRECT_ABI;
  const contract = new ethers.Contract(targetAddress, abi, wallet);
  const mintFn = isSeaDrop ? contract.mintPublic : contract.mint;
  const mintArgs = isSeaDrop
    ? [mintConfig.contractAddress, mintConfig.feeRecipient, wallet.address, mintConfig.quantity]
    : [mintConfig.quantity];

  const callMint = overrides => mintFn(...mintArgs, overrides);

  try {
    if (isSeaDrop && (!mintConfig.feeRecipient || mintConfig.feeRecipient.includes('REPLACE_ME'))) {
      console.log(`FAILED ${label}: mintType is seadrop but feeRecipient is not set in mints.json`);
      return { ...base, status: 'config_error' };
    }

    const value = ethers.parseEther(String(mintConfig.mintPrice)) * BigInt(mintConfig.quantity);
    const gasLimit = BigInt(mintConfig.gasLimit || 300000);

    // Balance, nonce and the test call run at the same time, so the test adds little delay.
    const simulate = mintConfig.skipSimulation
      ? Promise.resolve(null)
      : mintFn.staticCall(...mintArgs, { value, gasLimit }).then(() => null, err => err);
    const [balance, nonce, simulationError] = await Promise.all([
      provider.getBalance(wallet.address),
      provider.getTransactionCount(wallet.address, 'pending'),
      simulate,
    ]);

    if (balance < value) {
      console.log(`FAILED ${label}: insufficient funds (has ${ethers.formatEther(balance)} ETH, needs ~${ethers.formatEther(value)} ETH + gas)`);
      return { ...base, status: 'insufficient_funds' };
    }

    if (simulationError) {
      const isRevert = simulationError.code === 'CALL_EXCEPTION';
      const why = cleanError(simulationError);
      console.log(`SKIPPED ${label}: ${isRevert ? 'mint would fail' : 'could not test the mint'} (${why}). Nothing sent, no gas spent.`);
      return { ...base, status: isRevert ? 'would_revert' : 'simulation_error', error: why };
    }

    const maxPriorityFeePerGas = ethers.parseUnits(String(mintConfig.maxPriorityGwei), 'gwei');
    const maxFeePerGas = ethers.parseUnits(String(mintConfig.maxFeeGwei), 'gwei');

    const tx = await callMint({ value, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit });
    console.log(`SUBMITTED ${label}: ${tx.hash}`);
    const hashes = [tx.hash];

    const stuckTimeoutMs = mintConfig.stuckTimeoutMs || DEFAULT_STUCK_TIMEOUT_MS[mintConfig.chain] || 6000;
    const pollMs = RECEIPT_POLL_MS[mintConfig.chain] || 1000;

    let receipt = await waitForEither(provider, hashes, stuckTimeoutMs, pollMs);

    if (!receipt) {
      console.log(`STUCK ${label}: no confirmation within ${stuckTimeoutMs}ms, resubmitting with double gas (same nonce ${nonce})`);
      try {
        const bumpedTx = await callMint({
          value, nonce,
          maxPriorityFeePerGas: maxPriorityFeePerGas * 2n,
          maxFeePerGas: maxFeePerGas * 2n,
          gasLimit,
        });
        hashes.push(bumpedTx.hash);
        console.log(`RESUBMITTED ${label}: ${bumpedTx.hash}`);
      } catch (bumpErr) {
        // Usually means the original confirmed in the meantime ("nonce too low").
        console.log(`SPEED-UP NOT SENT ${label}: ${cleanError(bumpErr)}. Still watching the original.`);
      }
      const timeoutMs = CONFIRM_TIMEOUT_MS[mintConfig.chain] || 180000;
      receipt = await waitForEither(provider, hashes, timeoutMs, pollMs);
      if (!receipt) {
        console.log(`UNCONFIRMED ${label}: nothing confirmed within ${timeoutMs / 1000}s. Check on the explorer: ${hashes.join(', ')}`);
        return { ...base, status: 'unconfirmed', tx: hashes[hashes.length - 1], txs: hashes };
      }
    }

    if (receipt.status !== 1) {
      console.log(`REVERTED ${label}: transaction ${receipt.hash} failed on-chain in block ${receipt.blockNumber} (gas was spent)`);
      return { ...base, status: 'reverted', tx: receipt.hash, block: receipt.blockNumber };
    }

    console.log(`SUCCESS ${label}: minted in block ${receipt.blockNumber} (${receipt.hash})`);
    return { ...base, status: 'success', tx: receipt.hash, block: receipt.blockNumber };

  } catch (err) {
    const why = cleanError(err);
    console.log(`FAILED ${label}: ${why}`);
    return { ...base, status: 'error', error: why };
  }
}

async function runMint(mintConfig) {
  const infra = CHAIN_INFRA[mintConfig.chain];

  if (!infra || !infra.rpcUrl) {
    console.error(`Skipping ${mintConfig.slot} (${mintConfig.projectName}): missing RPC URL for chain "${mintConfig.chain}" in .env`);
    return [];
  }

  const provider = await getProvider(infra);
  if (!provider) {
    console.error(`Skipping ${mintConfig.slot} (${mintConfig.projectName}): neither the main nor the backup RPC for ${infra.name} is answering`);
    return wallets.map(w => ({ slot: mintConfig.slot, project: mintConfig.projectName, wallet: w.label, status: 'rpc_down' }));
  }

  console.log(`\n=== ${mintConfig.slot} — ${mintConfig.projectName} (${infra.name}): minting from ${wallets.length} wallet(s) ===`);

  const results = await Promise.all(wallets.map(w => mintFromWallet(mintConfig, infra, provider, w)));
  provider.destroy();
  return results;
}

async function main() {
  console.log(`Active mints today: ${activeMints.map(m => `${m.slot} (${m.projectName})`).join(', ')}\n`);

  const results = (await Promise.all(activeMints.map(runMint))).flat();

  console.log('\n=== Summary ===');
  for (const mintConfig of activeMints) {
    const mintResults = results.filter(r => r.slot === mintConfig.slot);
    const successCount = mintResults.filter(r => r.status === 'success').length;
    const skipped = mintResults.filter(r => r.status === 'would_revert').length;
    console.log(`${mintConfig.slot} (${mintConfig.projectName}): ${successCount}/${mintResults.length} wallets minted successfully` +
      (skipped ? `, ${skipped} skipped because the mint would fail` : ''));
  }

  const logPath = path.join(__dirname, `mint-log-${Date.now()}.json`);
  fs.writeFileSync(logPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results written to ${logPath}`);
}

main().catch(err => { console.error(cleanError(err)); process.exitCode = 1; });
