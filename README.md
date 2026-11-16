# Mint Runner

A Node.js script that mints NFTs from several wallets at once, on Ethereum and Robinhood Chain.
It supports OpenSea SeaDrop drops and plain `mint(quantity)` contracts.

Built for my own mints, with help from Claude.

## What it does

- **Mints from every wallet in parallel**, and runs each wallet independently, so one failure does not stop the rest.
- **Tests each mint before sending it.** A free simulated call runs first. If the mint would fail (not open yet, sold out, wrong price), that wallet is skipped and no gas is spent.
- **Speeds up stuck transactions.** If a transaction is not confirmed within a few seconds, it is re-sent with double gas and the same nonce. It then watches both the original and the sped-up transaction, so whichever confirms is reported correctly.
- **Switches to a backup RPC** if the main one does not answer.
- **Waits for cheap gas** (`wait-for-gas.js`), with a limit on attempts so it cannot keep spending gas on a closed mint.
- **Starts at an exact time** (`scheduled-run.js`) for timed drops.
- Writes a results log for every run, and never prints your RPC key in error messages.

## Files

| File | Purpose |
| --- | --- |
| `mint-mainnet.js` | The main script: mints every active slot in `mints.json` from every wallet in `wallets.json` |
| `mints.json` | Mint "slots" (ETH-1, ETH-2, RH-1...). Fill one in and set `"active": true` |
| `wait-for-gas.js` | Runs the mint once gas drops below a limit |
| `scheduled-run.js` | Runs the mint at a given Unix timestamp |
| `MintMultichain.js` | The original testnet version, kept as a simple example |
| `VPS_DEPLOY.md` | How to run it on a Linux VPS with PM2 |

## Setup

Needs Node.js 20 or newer.

```bash
npm install
cp .env.mainnet.example .env     # add your RPC URLs
```

Create `wallets.json` (never commit it):

```json
[
  { "label": "W1", "privateKey": "0x..." },
  { "label": "W2", "privateKey": "0x..." }
]
```

Then fill in a slot in `mints.json` and set it to active.

## Running

```bash
node mint-mainnet.js                 # mint now
node wait-for-gas.js 12 30 5         # mint when gas <= 12 gwei, check every 30s, max 5 attempts
node scheduled-run.js 1785424500     # mint at this Unix time
```

Optional per-slot settings in `mints.json`:

| Setting | Meaning |
| --- | --- |
| `stuckTimeoutMs` | How long to wait before speeding up a stuck transaction |
| `skipSimulation` | `true` sends without the test call (slightly faster, but a failing mint costs gas) |
| `gasLimit` | Raise it for larger quantities (default 300000) |

## Safety

- `.env` and `wallets.json` are git-ignored. Use fresh wallets that hold only what a mint needs.
- Every transaction goes either to the official SeaDrop contract or to the contract you put in `mints.json`.

## How it was tested

Against a local Ethereum test chain, in nine scenarios: a normal mint, a closed mint, a wrong price,
the main RPC down, both RPCs down, a stuck transaction that needs a speed-up, the gas watcher on a
closed mint and on an open one, and checking that RPC keys never appear in output.
