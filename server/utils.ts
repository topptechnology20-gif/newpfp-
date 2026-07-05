/**
 * Helper functions for challenge system
 */

export interface ChallengeImbalance {
  weakerSide: "YES" | "NO" | null;
  imbalancePercent: number;
}

/**
 * Calculate challenge imbalance between YES and NO sides
 * @param yesStakeTotal - Total stake on YES side
 * @param noStakeTotal - Total stake on NO side
 * @returns Object with weakerSide and imbalancePercent
 */
export function calculateChallengeImbalance(
  yesStakeTotal: number,
  noStakeTotal: number
): ChallengeImbalance {
  const totalPool = yesStakeTotal + noStakeTotal;

  // If no stakes yet, no imbalance
  if (totalPool === 0) {
    return {
      weakerSide: null,
      imbalancePercent: 0,
    };
  }

  // If totals equal, no imbalance
  if (yesStakeTotal === noStakeTotal) {
    return {
      weakerSide: null,
      imbalancePercent: 0,
    };
  }

  // If one side is zero, maximum imbalance
  if (yesStakeTotal === 0 || noStakeTotal === 0) {
    return {
      weakerSide: yesStakeTotal === 0 ? "YES" : "NO",
      imbalancePercent: 100,
    };
  }

  // Calculate imbalance percentage
  const difference = Math.abs(yesStakeTotal - noStakeTotal);
  const imbalancePercent = (difference / totalPool) * 100;

  // Determine weaker side
  const weakerSide = yesStakeTotal < noStakeTotal ? "YES" : "NO";

  return {
    weakerSide,
    imbalancePercent: Math.round(imbalancePercent * 100) / 100, // Round to 2 decimal places
  };
}