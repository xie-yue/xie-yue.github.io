# xie-yue.github.io

flow for buy-0g-tokens with api

# 购买 0G Token — 无界面 API 指南

通过 [`@tokenflight/api`](https://embed.tokenflight.ai/reference/api-client/) 直接调用 API 购买原生 **0G Token**，无需组件库，无任何 UI 依赖。

> **依赖说明** `@tokenflight/api` 已通过 `@0gfoundation/0g-pay-sdk` 作为传递依赖安装。  
> 单独安装：`npm install @tokenflight/api`

---

## Token 基础信息

| 字段 | 值 |
|------|----|
| 链 | 0G 主网（`chainId: 16661`） |
| 代币 | 原生 0G（EVM 零地址） |
| 地址 | `0x0000000000000000000000000000000000000000` |
| CAIP-10 | `eip155:16661:0x0000000000000000000000000000000000000000` |

---

## Flow 1 — 加密货币兑换

将任意支持链上的代币跨链兑换为 0G 主网上的原生 0G Token。

**API 类：** `HyperstreamApi` (`https://api.hyperstream.dev`)

```
getQuotes() → buildDeposit() → 钱包签名 → submitDeposit() → trackOrder()
```

### 步骤

#### 1. 获取报价

```ts
const { quoteId, routes } = await hyperstreamApi.getQuotes({
  tradeType: 'EXACT_INPUT',
  fromChainId: 8453,                                        // Base 链
  fromToken:   '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
  toChainId:   16661,
  toToken:     '0x0000000000000000000000000000000000000000',
  amount:      '10000000',   // 10 USDC（6 位小数）
  fromAddress: '0xYour…',
  refundTo:    '0xYour…',
});
```

`routes` 由后端排序返回。每条路由包含 `quote.amountOut`（预计输出量）、`quote.expectedDurationSeconds`（预计耗时）以及下一步所需的 `routeId`。

#### 2. 构建存款操作

将选定路由转换为具体的钱包操作（ERC-20 授权 + 存款调用）。

```ts
const deposit = await hyperstreamApi.buildDeposit({
  from:    '0xYour…',
  quoteId,
  routeId: routes[0].routeId,
});
// deposit.kind === 'CONTRACT_CALL'
// deposit.approvals — 按序排列的 EIP-1193 请求列表
```

#### 3. 执行钱包操作

按顺序遍历 `deposit.approvals`，标记了 `deposit: true` 的操作是链上存款交易，需捕获其交易哈希。

```ts
let depositTxHash: string | undefined;

for (const approval of deposit.approvals ?? []) {
  if (approval.type !== 'eip1193_request') continue;

  const result = await provider.request(approval.request);

  if (approval.deposit) {
    depositTxHash = result as string; // 如 eth_sendTransaction
  }
  if (approval.waitForReceipt && depositTxHash) {
    await waitForReceipt(provider, depositTxHash);
  }
}
```

> **为什么需要 `waitForReceipt`？**  
> 某些路由要求 ERC-20 `approve` 上链确认后，存款调用才能成功执行。

#### 4. 提交存款

通知后端存款交易已广播。

```ts
const { orderId } = await hyperstreamApi.submitDeposit({
  quoteId,
  routeId: routes[0].routeId,
  txHash:  depositTxHash,
});
```

#### 5. 追踪至完成

轮询直到订单达到终态（`filled`、`refunded`、`failed`…）。

```ts
const finalOrder = await hyperstreamApi.trackOrder(orderId, {
  intervalMs: 3000,
  onStatus: order => console.log(order.status),
});
```

| 状态 | 含义 |
|------|------|
| `created` | 订单已创建 |
| `deposited` | 存款已链上确认 |
| `published` | 意图已发布给撮合方 |
| `filled` ✅ | 0G 已发送至接收地址 |
| `refunded` | 撮合失败，输入已退还 |
| `failed` ❌ | 不可恢复的错误 |

---

## Flow 2 — 信用卡购买（法币入金）

通过法币入金服务商使用信用卡/借记卡购买 0G Token。  
仅限浏览器环境，需确保 `window.open` 未被拦截。

**API 类：** `FiatApi` (`https://fiat.hyperstream.dev`)

```
getProviders() → getQuote() → createOrder() → startCheckout()
```

### 步骤

#### 1. 获取服务商列表 *(可选)*

用于在 UI 中渲染服务商选择器。

```ts
const { providers } = await fiatApi.getProviders();
// providers[].name, .id, .supportedChainIds, .paymentMethods
```

#### 2. 获取报价

```ts
const { quotes } = await fiatApi.getQuote({
  fiatCurrency: 'USD',
  fiatAmount:   '50',
  toChainId:    16661,
  toToken:      '0x0000000000000000000000000000000000000000',
  recipient:    '0xYour…',
  refundTo:     '0xYour…',
});
```

每个 `FiatQuoteItem` 包含：

| 字段 | 说明 |
|------|------|
| `quoteId` | 传给 `createOrder` 的报价 ID |
| `providerName` | 服务商名称，如 `"Transak"` |
| `fiatAmount` | 法币输入金额 |
| `totalFee` | 服务商手续费（法币计） |
| `cryptoAmount` | 预计获得的 0G 数量（最小单位） |
| `expiresAt` | 报价过期时间戳 |
| `swapStrategy` | `"direct"` 直接入金 或 `"jump"` 经 USDC 桥接 |

#### 3. 创建订单

确认报价，获取服务商的结账 URL。

```ts
const order = await fiatApi.createOrder({
  quoteId:   best.quoteId,
  author:    '0xYour…',
  refundTo:  '0xYour…',
  routeId:   best.routes?.[0]?.routeId, // jump 策略必填
});
// order.orderId    — 用于轮询状态
// order.widgetUrl  — 服务商原始支付页面
// order.wrapperUrl — 托管包装页面（配合 startCheckout 使用）
```

#### 4. 打开结账弹窗

`startCheckout` 在弹窗中打开 `order.wrapperUrl`，处理 `FIAT_WIDGET_EVENT` postMessage 协议，轮询 `getStatus`，用户完成或关闭窗口后 resolve。

```ts
const result = await fiatApi.startCheckout(order, {
  popup:            { width: 500, height: 700 },
  minPollIntervalMs: 3000,
  onStatus: s => console.log(s.status, s.progress),
  // signal: abortController.signal  ← 用于编程式取消
});

// result.outcome:    "completed" | "failed" | "canceled"
// result.finalStatus — 最后一次轮询的 FiatStatusResponse
// result.orderId
```

| `outcome` | 含义 |
|-----------|------|
| `completed` ✅ | 支付成功，0G 正在转入 |
| `failed` ❌ | 服务商拒绝支付 |
| `canceled` | 用户关闭了弹窗 |

---

## 流式报价 *(扩展)*

每当撮合方响应时即推送一条路由，适合在 UI 中实现路由发现的实时动效。

```ts
for await (const route of hyperstreamApi.streamQuotes({ /* 参数与 getQuotes 相同 */ })) {
  console.log(route.type, route.quote.amountOut);
  // 实时渲染路由卡片，无需等待全部路由返回
}
```

---

## 错误处理

所有方法抛出 `TokenFlightError` 子类，通过 `instanceof` 匹配具体错误类型：

```ts
import {
  CannotFillError,
  QuoteExpiredError,
  TokenFlightError,
} from '@tokenflight/api';

try {
  await buyCryptoFlow(…);
} catch (e) {
  if (e instanceof QuoteExpiredError) {
    // 报价已过期，重新获取后重试
  } else if (e instanceof CannotFillError) {
    // 当前路由无撮合方可用
  } else if (e instanceof TokenFlightError) {
    console.error(e.code, e.message);
  }
}
```

---

## 测试页面

交互式测试页面位于 `/buy-test` — 连接钱包后可在浏览器中直接运行两个 Flow。

