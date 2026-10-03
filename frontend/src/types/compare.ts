import type { Rating } from './rating'

/** 比测判定结论 */
export type CompareVerdict = '合格' | '超限'

/** 比测偏差允许限值（%）：超过则判定超限并挂红 */
export const DEVIATION_LIMIT_PCT = 8

/** 比测记录：实测流量与曲线流量的偏差分析 */
export interface Compare {
  id: string
  /** 被比测的关系点据 */
  ratingId: string
  /**
   * 该条比测随哪一版定线报出：
   * 非空时属于历史报出版本（与当时的定线、偏差、判定一并冻结，照样可查）；
   * null 时是当前工作版（零点改动、基面重折后跟着重算、尚未重新定案）。
   */
  ratingVersionId: string | null
  /** 比测时采用的统一基面水位（m），留档复核 */
  datumStageM: number | null
  /** 实测流量（m³/s） */
  measuredFlow: number
  /** 曲线流量（m³/s） */
  curveFlow: number
  /** 偏差（%）：(曲线 - 实测) / 实测 × 100 */
  deviationPct: number
  /** 合格 / 超限 */
  verdict: CompareVerdict
  /** 比测人 */
  operator: string
  /** 比测日期 */
  comparedAt: string
  createdAt: number
  updatedAt: number
}

/** 按偏差计算判定结论 */
export function judgeDeviation(deviationPct: number, limit = DEVIATION_LIMIT_PCT): CompareVerdict {
  return Math.abs(deviationPct) > limit ? '超限' : '合格'
}

/** 计算偏差百分比 */
export function calcDeviationPct(measuredFlow: number, curveFlowValue: number): number {
  if (!Number.isFinite(measuredFlow) || measuredFlow === 0) return 0
  return Number((((curveFlowValue - measuredFlow) / measuredFlow) * 100).toFixed(2))
}

/** 比测行：比测记录 + 所属点据，供导出页与分析清单展示 */
export interface CompareRow {
  compare: Compare
  rating: Rating | null
  stationName: string
  lineNo: string
}
