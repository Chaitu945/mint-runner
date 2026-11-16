/**
 * Polls current Ethereum gas price and only runs mint-mainnet.js once
 * gas is at or below a target ceiling. Stops when a wallet mints,
 * or after a set number of attempts so it can't keep spending gas.
 *
 * Usage: node wait-for-gas.js <maxGweiToAttempt> <checkIntervalSeconds> [maxAttempts]
 * Example: node wait-for-gas.js 12 30 5
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ethers } = require('ethers');

const MAX_GWEI = Number(process.argv[2]) || 12;
const CHECK_INTERVAL_SEC = Number(process.argv[3]) || 30;
const MAX_ATTEMPTS = Number(process.argv[4]) || 5;

const provider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL, 1, { staticNetwork: true });

async function getCurrentGasGwei() {
  const feeData = await provider.getFeeData();
  return Number(ethers.formatUnits(feeData.gasPrice, 'gwei'));
}

// Read only the log written by this attempt, never an older one from a previous mint.
function resultsSince(startedAt) {
  const logs = fs.readdirSync(__dirname)
    .filter(f => /^mint-log-\d+\.json$/.test(f))
    .map(f => ({ f, t: Number(f.slice(9, -5)) }))
    .filter(x => x.t >= startedAt)
    .sort((a, b) => b.t - a.t);
  if (logs.length === 0) return null;
  return JSON.parse(fs.readFileSync(path.join(__dirname, logs[0].f), 'utf8'));
}

async function main() {
  console.log(`Watching gas. Will attempt mint when gas <= ${MAX_GWEI} gwei. Checking every ${CHECK_INTERVAL_SEC}s, at most ${MAX_ATTEMPTS} attempts.`);
  let attempts = 0;

  while (true) {
    const timestamp = new Date().toISOString();
    let currentGwei;
    try {
      currentGwei = await getCurrentGasGwei();
    } catch (err) {
      console.log(`[${timestamp}] Could not read gas price (${err.shortMessage || err.message}). Trying again shortly.`);
      await new Promise(r => setTimeout(r, CHECK_INTERVAL_SEC * 1000));
      continue;
    }

    if (currentGwei <= MAX_GWEI) {
      attempts++;
      console.log(`[${timestamp}] Gas is ${currentGwei.toFixed(2)} gwei -- within budget. Attempt ${attempts} of ${MAX_ATTEMPTS}...`);
      const startedAt = Date.now();
      try {
        execSync('node mint-mainnet.js', { stdio: 'inherit', cwd: __dirname });
      } catch (err) {
        console.log('mint-mainnet.js exited with a non-zero code (see output above).');
      }

      const results = resultsSince(startedAt);
      if (!results) {
        console.log('This attempt did not write a results log (it crashed early). Stopping so you can check the error above.');
        break;
      }
      if (results.some(r => r.status === 'success')) {
        console.log('At least one wallet minted successfully. Stopping watcher.');
        break;
      }
      if (results.length > 0 && results.every(r => r.status === 'would_revert')) {
        console.log('Every wallet was skipped because the mint would fail (not open, sold out, or wrong price). No gas was spent.');
      }
      if (attempts >= MAX_ATTEMPTS) {
        console.log(`Reached ${MAX_ATTEMPTS} attempts without a successful mint. Stopping so it can't keep spending gas.`);
        break;
      }
      console.log('No wallet minted this attempt. Continuing to watch...');
    } else {
      console.log(`[${timestamp}] Gas is ${currentGwei.toFixed(2)} gwei -- above your ${MAX_GWEI} gwei budget. Waiting...`);
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL_SEC * 1000));
  }
}

main().catch(err => { console.error(err.shortMessage || err.message); process.exitCode = 1; });
