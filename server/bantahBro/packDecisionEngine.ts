export type AgentMetrics = {
  agentId?: string
  winRate: number // 0..1
  lossStreak?: number
  opponentTierGap?: number // 0..1
  missingSynergies?: number // small integer
  seasonPressure?: number // 0..1
  bcSpendPressure?: number // 0..1
  packScarcityPenalty?: number // 0..1
  strategyMode?: 'aggressive' | 'adaptive' | 'defensive' | 'economy'
}

export type PackDecision = {
  decision: 'OPEN_PACK' | 'WAIT' | 'SAVE_FOR_BATTLE'
  confidence: number // 0..100
  reasonTags: string[]
}

export function decidePackOpen(metrics: AgentMetrics): PackDecision {
  const winRate = Number(metrics.winRate || 0)
  const lossStreak = Math.max(0, Math.round(metrics.lossStreak || 0))
  const opponentTierGap = Number(metrics.opponentTierGap || 0)
  const missingSynergies = Math.max(0, Math.round(metrics.missingSynergies || 0))
  const seasonPressure = Number(metrics.seasonPressure || 0)
  const bcSpendPressure = Number(metrics.bcSpendPressure || 0)
  const packScarcityPenalty = Number(metrics.packScarcityPenalty || 0)
  const strategyMode = metrics.strategyMode || 'adaptive'

  const urgency =
    (1 - winRate) * 40 +
    Math.min(lossStreak, 20) * 2.5 +
    opponentTierGap * 25 +
    Math.min(missingSynergies, 10) * 6 +
    seasonPressure * 10

  const econCost = bcSpendPressure * 15 + packScarcityPenalty * 20

  const strategyModifierMap: Record<string, number> = {
    aggressive: 1.2,
    adaptive: 1.0,
    defensive: 0.75,
    economy: 0.45,
  }
  const strategyMod = strategyModifierMap[String(strategyMode)] || 1

  const raw = urgency * strategyMod - econCost

  // scale to confidence roughly across an expected raw range (~0..120)
  const confidence = Math.max(0, Math.min(100, Math.round((raw / 120) * 100)))

  const decision: PackDecision['decision'] = confidence > 70 ? 'OPEN_PACK' : confidence > 45 ? 'WAIT' : 'SAVE_FOR_BATTLE'

  const reasons: string[] = []
  if (winRate < 0.7) reasons.push('LOW_WINRATE')
  if (opponentTierGap > 0.4) reasons.push('HIGH_OPPONENT_THREAT')
  if (missingSynergies >= 3) reasons.push('MISSING_SYNERGIES')
  if (lossStreak >= 3) reasons.push('LOSS_STREAK')

  return { decision, confidence, reasonTags: reasons }
}

export default decidePackOpen
