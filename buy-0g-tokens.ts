/**
 * Demo: headless purchase of 0G token via @tokenflight/api
 *
 * Two flows:
 *   1. Crypto  — swap any supported token from any chain into 0G on 0G mainnet
 *   2. Card    — fiat on-ramp (credit/debit card) → 0G on 0G mainnet
 *
 * @tokenflight/api is installed transitively via @0gfoundation/0g-pay-sdk.
 * To use it standalone: npm install @tokenflight/api
 *
 * Docs: https://embed.tokenflight.ai/reference/api-client/
 */

import {
  DEFAULT_API_ENDPOINT,
  DEFAULT_FIAT_API_ENDPOINT,
  FiatApi,
  type FiatCheckoutResult,
  type FiatStatusResponse,
  HyperstreamApi,
  TERMINAL_ORDER_STATUSES,
} from '@tokenflight/api';

// ── Chain / token constants ────────────────────────────────────────────────────

/** 0G mainnet chain id */
const ZG_CHAIN_ID = 16661;

/** Native 0G token (EVM zero-address = chain's native coin) */
const ZG_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

/** CAIP-10 identifier for the native 0G token on 0G mainnet */
const ZG_TOKEN_CAIP10 = `eip155:${ZG_CHAIN_ID}:${ZG_TOKEN_ADDRESS}`;

// ── Shared API client instances ────────────────────────────────────────────────

const hyperstreamApi = new HyperstreamApi({ baseUrl: DEFAULT_API_ENDPOINT });
const fiatApi = new FiatApi({ baseUrl: DEFAULT_FIAT_API_ENDPOINT });

// ── EIP-1193 provider type (minimal interface) ─────────────────────────────────

interface EIP1193Provider {
  // eslint-disable-next-line no-unused-vars
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

// ══════════════════════════════════════════════════════════════════════════════
// Flow 1 — Crypto: swap any token → 0G
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Buy 0G token by swapping from any supported crypto.
 *
 * @param provider    EIP-1193 wallet provider (e.g. window.ethereum)
 * @param fromAddress Sender's wallet address
 * @param fromChainId Source chain id (e.g. 1 = Ethereum, 8453 = Base)
 * @param fromToken   Source token address on fromChainId
 * @param amount      Amount to spend, in the source token's smallest unit (wei)
 *
 * @example
 * // Swap 10 USDC (6 decimals) from Base → 0G on 0G mainnet
 * await buyCryptoFlow(
 *   window.ethereum,
 *   '0xYourAddress',
 *   8453,
 *   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
 *   '10000000',
 * );
 */
export async function buyCryptoFlow(
  provider: EIP1193Provider,
  fromAddress: string,
  fromChainId: number,
  fromToken: string,
  amount: string,
): Promise<{ orderId: string; txHash: string }> {
  // ── Step 1: request quotes ─────────────────────────────────────────────────
  console.log('Requesting quotes...');
  const { quoteId, routes } = await hyperstreamApi.getQuotes({
    tradeType: 'EXACT_INPUT',
    fromChainId,
    fromToken,
    toChainId: ZG_CHAIN_ID,
    toToken: ZG_TOKEN_ADDRESS,
    amount,
    fromAddress,
    // recipient defaults to fromAddress; set explicitly for payment-layer deposit:
    // recipient: '0xeB5681bB6c5a19478D7B3A258528Fb965da9d93D',
    refundTo: fromAddress,
  });

  if (routes.length === 0) throw new Error('No routes available');

  // Pick fastest / cheapest route — here we just take the first one
  const route = routes[0];
  console.log(
    `Best route: ${route.type} | in ${route.quote.amountIn} → out ${route.quote.amountOut}`,
    `| ~${route.quote.expectedDurationSeconds}s`,
  );

  // ── Step 2: build deposit actions ──────────────────────────────────────────
  console.log('Building deposit...');
  const deposit = await hyperstreamApi.buildDeposit({
    from: fromAddress,
    quoteId,
    routeId: route.routeId,
  });

  // deposit.approvals is an ordered list of wallet actions to execute.
  // Each action is either an EIP-1193 request (approve ERC-20 + deposit call)
  // or a Solana transaction. The last one with deposit:true is the main tx.
  let depositTxHash: string | undefined;

  // ── Step 3: execute wallet actions ────────────────────────────────────────
  if (deposit.kind === 'CONTRACT_CALL' && deposit.approvals) {
    for (const approval of deposit.approvals) {
      if (approval.type !== 'eip1193_request') continue;

      console.log(`Sending wallet request: ${approval.request.method}`);
      const result = await provider.request(approval.request);

      if (approval.deposit) {
        // This is the deposit transaction — capture its hash
        depositTxHash = result as string;
        console.log(`Deposit tx: ${depositTxHash}`);
      }

      if (approval.waitForReceipt && depositTxHash) {
        // Wait for on-chain confirmation before continuing
        await waitForReceipt(provider, depositTxHash);
      }
    }
  }

  if (!depositTxHash) throw new Error('No deposit tx hash captured');

  // ── Step 4: notify the backend ────────────────────────────────────────────
  console.log('Submitting deposit...');
  const { orderId } = await hyperstreamApi.submitDeposit({
    quoteId,
    routeId: route.routeId,
    txHash: depositTxHash,
  });

  console.log(`Order created: ${orderId}`);

  // ── Step 5: track until completion ───────────────────────────────────────
  console.log('Tracking order...');
  const finalOrder = await hyperstreamApi.trackOrder(orderId, {
    intervalMs: 3000,
    onStatus: order => console.log(`  Status: ${order.status}`),
  });

  console.log(`Order ${orderId} settled with status: ${finalOrder.status}`);
  if (!TERMINAL_ORDER_STATUSES.includes(finalOrder.status)) {
    throw new Error(`Order ended in unexpected status: ${finalOrder.status}`);
  }

  return { orderId, txHash: depositTxHash };
}

/** Poll provider for a tx receipt (basic implementation). */
async function waitForReceipt(
  provider: EIP1193Provider,
  txHash: string,
  pollMs = 2000,
): Promise<void> {
  while (true) {
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });
    if (receipt) return;
    await new Promise(r => setTimeout(r, pollMs));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Flow 2 — Credit card: fiat on-ramp → 0G
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Buy 0G token with a credit/debit card via a fiat on-ramp provider.
 * Opens the provider's checkout popup; resolves when the user completes
 * or cancels payment.
 *
 * Browser-only — requires `window.open` to not be blocked.
 *
 * @param recipientAddress Wallet address that will receive the 0G tokens
 * @param fiatAmount       Fiat amount to spend, as a decimal string (e.g. "50")
 * @param fiatCurrency     ISO 4217 currency code (e.g. "USD", "EUR")
 * @param paymentMethod    Provider payment method id (e.g. "credit_debit_card")
 *
 * @example
 * const result = await buyCardFlow('0xYourAddress', '50', 'USD');
 * if (result.outcome === 'completed') console.log('Payment succeeded');
 */
export async function buyCardFlow(
  recipientAddress: string,
  fiatAmount: string,
  fiatCurrency = 'USD',
  paymentMethod?: string,
): Promise<FiatCheckoutResult> {
  // ── Step 1: list supported providers (optional — useful to show UI) ────────
  const { providers } = await fiatApi.getProviders();
  console.log(
    'Available providers:',
    providers.map(p => `${p.name} (${p.id})`).join(', '),
  );

  // ── Step 2: fetch quotes from all providers for this amount ────────────────
  console.log(`Requesting fiat quote: ${fiatAmount} ${fiatCurrency} → 0G...`);
  const { quotes } = await fiatApi.getQuote({
    fiatCurrency,
    fiatAmount,
    toChainId: ZG_CHAIN_ID,
    toToken: ZG_TOKEN_ADDRESS,
    recipient: recipientAddress,
    refundTo: recipientAddress,
    paymentMethod,
  });

  if (quotes.length === 0) throw new Error('No fiat quotes available');

  // Pick the quote that gives the most 0G output
  const best = quotes.reduce((a, b) =>
    BigInt(a.cryptoAmount) >= BigInt(b.cryptoAmount) ? a : b,
  );

  console.log(
    `Best quote: ${best.providerName} | fee ${best.totalFee} ${fiatCurrency}`,
    `| ~${best.cryptoAmount} raw 0G | expires ${best.expiresAt}`,
  );

  // ── Step 3: commit to the quote ────────────────────────────────────────────
  console.log('Creating order...');
  const order = await fiatApi.createOrder({
    quoteId: best.quoteId,
    author: recipientAddress,
    refundTo: recipientAddress,
    // For jump strategy quotes, pick a routeId from best.routes
    routeId: best.routes?.[0]?.routeId,
  });

  console.log(`Order ${order.orderId} created | provider: ${order.provider}`);
  console.log(`Checkout URL: ${order.wrapperUrl}`);

  // ── Step 4: open provider popup and wait for completion ───────────────────
  // startCheckout opens order.wrapperUrl in a popup, drives the FIAT_WIDGET_EVENT
  // postMessage protocol, polls getStatus, and resolves when done.
  console.log('Opening checkout popup...');
  const result = await fiatApi.startCheckout(order, {
    popup: { width: 500, height: 700 },
    minPollIntervalMs: 3000,
    onStatus: (status: FiatStatusResponse) =>
      console.log(`  Fiat status: ${status.status} (${status.progress})`),
  });

  console.log(`Checkout ${result.outcome} | orderId: ${result.orderId}`);
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// Bonus: streaming quotes (HyperstreamApi.streamQuotes)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Stream quotes as each filler responds — useful for showing live route
 * discovery in a UI before the user picks a route.
 *
 * @example
 * for await (const route of streamQuotesFor0G('0xYour', 1, '0xA0b...', '1000000')) {
 *   console.log(route.type, route.quote.amountOut);
 * }
 */
export function streamQuotesFor0G(
  fromAddress: string,
  fromChainId: number,
  fromToken: string,
  amount: string,
) {
  return hyperstreamApi.streamQuotes({
    tradeType: 'EXACT_INPUT',
    fromChainId,
    fromToken,
    toChainId: ZG_CHAIN_ID,
    toToken: ZG_TOKEN_ADDRESS,
    amount,
    fromAddress,
    refundTo: fromAddress,
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Usage examples (run with ts-node or in a browser console)
// ══════════════════════════════════════════════════════════════════════════════

/*
// Crypto flow — swap 10 USDC from Base → 0G
const provider = window.ethereum;
const address = (await provider.request({ method: 'eth_requestAccounts' }))[0];
const { orderId } = await buyCryptoFlow(
  provider,
  address,
  8453,                                             // Base
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',    // USDC on Base
  '10000000',                                       // 10 USDC (6 decimals)
);
console.log('Done, order:', orderId);

// Card flow — buy 0G with $50 USD via credit card (browser only)
const result = await buyCardFlow(address, '50', 'USD');
console.log('Outcome:', result.outcome);

// Streaming quotes — show routes as they arrive
for await (const route of streamQuotesFor0G(address, 1, '0xA0b86991c...', '10000000')) {
  console.log(route.type, '->', route.quote.amountOut, 'raw 0G');
}
*/

export { ZG_CHAIN_ID, ZG_TOKEN_ADDRESS, ZG_TOKEN_CAIP10 };
