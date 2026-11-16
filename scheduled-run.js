/**
 * Waits until a specific Unix timestamp, then runs mint-mainnet.js.
 * Usage: node scheduled-run.js <unixTimestamp>
 * Example: node scheduled-run.js 1785424500
 */

const { execSync } = require('child_process');

const targetTimestamp = Number(process.argv[2]);

if (!targetTimestamp) {
  console.error('Usage: node scheduled-run.js <unixTimestamp>');
  process.exit(1);
}

function nowSeconds() {
  return Date.now() / 1000;
}

async function waitUntil(target) {
  // Coarse wait: check every 5s until we're within 10s of target
  while (nowSeconds() < target - 10) {
    const remaining = target - nowSeconds();
    console.log(`Waiting... ${Math.round(remaining)}s until mint opens`);
    await new Promise(r => setTimeout(r, 5000));
  }

  // Fine wait: tight loop for the final approach, more precise than setTimeout alone
  while (nowSeconds() < target) {
    // busy-ish wait for the last few seconds, minimal sleep to avoid hammering CPU
    await new Promise(r => setTimeout(r, 50));
  }

  console.log(`Target time reached (${new Date(target * 1000).toISOString()}). Firing now.`);
}

async function main() {
  console.log(`Target mint time: ${new Date(targetTimestamp * 1000).toISOString()} (${targetTimestamp})`);
  await waitUntil(targetTimestamp);

  try {
    // Run the actual mint script, inheriting stdout/stderr so you see live output
    execSync('node mint-mainnet.js', { stdio: 'inherit' });
  } catch (err) {
    console.error('mint-mainnet.js exited with an error (see output above).');
  }
}

main();