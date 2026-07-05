import { nanoid } from "nanoid";
import {
  bantahBroAlertSchema,
  bantahBroReceiptSchema,
  type BantahBroAlert,
  type BantahBroCreateMarketFromSignalRequest,
  type BantahBroReceipt,
  type BantahBroTokenAnalysis,
} from "@shared/bantahBro";

type AlertMode = "auto" | "rug" | "runner" | "watch";

function clampConfidence(value: number) {
  return Math.max(0, Math.min(1, value));
}

function formatPriceUsd(value: number | null) {
  if (!value || !Number.isFinite(value) || value <= 0) return "n/a";
  if (value >= 1) return `$${value.toFixed(4)}`;
  if (value >= 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toPrecision(4)}`;
}

function resolveAlertType(analysis: BantahBroTokenAnalysis, mode: AlertMode) {
  if (mode === "rug") return "rug_alert" as const;
  if (mode === "runner") return "runner_alert" as const;
  if (mode === "watch") return "watch_alert" as const;
  if (analysis.rug.riskLevel === "high") return "rug_alert" as const;
  if (analysis.momentum.momentumLevel === "hot") return "runner_alert" as const;
  return "watch_alert" as const;
}

function buildWatchBody(analysis: BantahBroTokenAnalysis) {
  const symbol = analysis.tokenSymbol ? `$${analysis.tokenSymbol}` : "This token";
  const price = formatPriceUsd(analysis.primaryPair?.priceUsd ?? null);
  const liquidity = analysis.primaryPair?.liquidityUsd || 0;
  return [
    `👀 ${symbol} is on watch.`,
    "",
    `💵 Price: ${price}`,
    `💧 Liquidity: $${Math.round(liquidity).toLocaleString()}`,
    `⚠️ Rug score: ${analysis.rug.score}/100`,
    `🚀 Momentum: ${analysis.momentum.score}/100`,
  ].join("\n");
}

export function buildHeadline(analysis: BantahBroTokenAnalysis, type: BantahBroAlert["type"]) {
  const symbol = analysis.tokenSymbol ? `$${analysis.tokenSymbol}` : "This token";
  if (type === "rug_alert") return `⚠️ ${symbol} looks shaky.`;
  if (type === "runner_alert") return `🚀 ${symbol} looks alive.`;
  if (type === "market_live") return `🎯 ${symbol} market is live.`;
  if (type === "boost_live") return `📣 ${symbol} market boost is live.`;
  if (type === "receipt") return `🧾 ${symbol} receipt logged.`;
  if (type === "aftermath") return `📉 ${symbol} aftermath is in.`;
  if (type === "wallet_status") return `👛 BantahBro wallet status updated.`;
  return `👀 ${symbol} is on watch.`;
}

function buildBody(
  analysis: BantahBroTokenAnalysis,
  type: BantahBroAlert["type"],
) {
  if (type === "rug_alert") return analysis.posts.rug || buildWatchBody(analysis);
  if (type === "runner_alert") return analysis.posts.runner || buildWatchBody(analysis);
  return buildWatchBody(analysis);
}

export function buildAlertFromAnalysis(
  analysis: BantahBroTokenAnalysis,
  mode: AlertMode = "auto",
): BantahBroAlert {
  const type = resolveAlertType(analysis, mode);
  const sentiment =
    type === "rug_alert" ? "bearish" : type === "runner_alert" ? "bullish" : "mixed";
  const confidence = clampConfidence(
    type === "rug_alert"
      ? analysis.rug.score / 100
      : type === "runner_alert"
        ? analysis.momentum.score / 100
        : Math.max(analysis.rug.score, analysis.momentum.score) / 100,
  );
  const now = new Date().toISOString();

  return bantahBroAlertSchema.parse({
    id: `bb_alert_${nanoid(12)}`,
    type,
    createdAt: now,
    updatedAt: now,
    chainId: analysis.chainId,
    tokenAddress: analysis.tokenAddress,
    tokenSymbol: analysis.tokenSymbol,
    tokenName: analysis.tokenName,
    headline: buildHeadline(analysis, type),
    body: buildBody(analysis, type),
    sentiment,
    confidence,
    rugScore: analysis.rug.score,
    momentumScore: analysis.momentum.score,
    referencePriceUsd: analysis.primaryPair?.priceUsd ?? null,
    sourceAnalysisAt: analysis.generatedAt,
    market: null,
    boost: null,
    metadata: {
      pairCount: analysis.aggregate.pairCount,
      holderStatus: analysis.holders.status,
      suggestedActions: analysis.suggestedActions,
    },
  });
}

export function buildMarketQuestionFromAnalysis(
  analysis: BantahBroTokenAnalysis,
  request: BantahBroCreateMarketFromSignalRequest,
) {
  if (request.question?.trim()) return request.question.trim();
  const symbol = analysis.tokenSymbol ? `$${analysis.tokenSymbol}` : "this token";
  const hours = request.durationHours;
  if (analysis.rug.riskLevel === "high") {
    return `Will ${symbol} drop 70% in ${hours}h?`;
  }
  if (analysis.momentum.momentumLevel === "hot") {
    return `Will ${symbol} 2x in ${Math.max(hours, 24)}h?`;
  }
  return `Will ${symbol} hold above current price in ${hours}h?`;
}

export function buildReceiptFromAlert(
  alert: BantahBroAlert,
  latestAnalysis: BantahBroTokenAnalysis,
): BantahBroReceipt {
  const entryPriceUsd = alert.referencePriceUsd;
  const latestPriceUsd = latestAnalysis.primaryPair?.priceUsd ?? null;
  if (!entryPriceUsd || entryPriceUsd <= 0 || !latestPriceUsd || latestPriceUsd <= 0) {
    throw new Error("Receipt evaluation requires both entry and latest USD prices.");
  }

  const multiple = latestPriceUsd / entryPriceUsd;
  let status: BantahBroReceipt["status"] = "watching";
  if (multiple >= 10) {
    status = "top_signal";
  } else if (multiple >= 2) {
    status = "printed";
  } else if (multiple <= 0.35) {
    status = "rekt";
  }

  const symbol = latestAnalysis.tokenSymbol ? `$${latestAnalysis.tokenSymbol}` : "This token";
  const now = new Date().toISOString();
  const headline =
    status === "top_signal"
      ? `🏆 ${symbol} went 10x.`
      : status === "printed"
        ? `📈 ${symbol} printed.`
        : status === "rekt"
          ? `📉 ${symbol} got smoked.`
          : `👀 ${symbol} is still moving.`;
  const body =
    status === "top_signal"
      ? `📍 Called at ${formatPriceUsd(entryPriceUsd)}. 💵 Now ${formatPriceUsd(latestPriceUsd)}.\n\n🏆 ${multiple.toFixed(2)}x receipt logged.`
      : status === "printed"
        ? `📍 Called at ${formatPriceUsd(entryPriceUsd)}. 💵 Now ${formatPriceUsd(latestPriceUsd)}.\n\n📈 ${multiple.toFixed(2)}x and counting.`
        : status === "rekt"
          ? `📍 Called at ${formatPriceUsd(entryPriceUsd)}. 💵 Now ${formatPriceUsd(latestPriceUsd)}.\n\n🧾 Receipts stay honest.`
          : `📍 Called at ${formatPriceUsd(entryPriceUsd)}. 💵 Now ${formatPriceUsd(latestPriceUsd)}.\n\n👀 Still watching.`;

  return bantahBroReceiptSchema.parse({
    id: `bb_receipt_${nanoid(12)}`,
    sourceAlertId: alert.id,
    createdAt: now,
    updatedAt: now,
    chainId: latestAnalysis.chainId,
    tokenAddress: latestAnalysis.tokenAddress,
    tokenSymbol: latestAnalysis.tokenSymbol,
    tokenName: latestAnalysis.tokenName,
    entryPriceUsd,
    latestPriceUsd,
    multiple,
    status,
    headline,
    body,
    rewardEligible: multiple >= 10,
    market: alert.market,
  });
}
