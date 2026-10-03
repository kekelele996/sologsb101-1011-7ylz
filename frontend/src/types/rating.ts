import type { DatumStatus } from './gaugeSurvey'

/** 水位流量关系点据：参与幂函数定线的实测点 */
export interface Rating {
  id: string
  /** 所属测站 */
  stationId: string
  /**
   * 水尺读数（m，水尺零点起算，站上观测原值）。
   * 旧字段 stageM 保留为兼容别名，两者始终同值。
   */
  stageM: number
  /** 流量（m³/s） */
  flowM3s: number
  /** 定线号：同一定线号的点据参与同一组拟合 */
  lineNo: string
  /** 点据来源测次号 */
  measureNo: string
  /** 点据时间 */
  measuredAt: string
  /** 测流当时生效的水尺接测记录 id（无零点记录的旧数据为 null） */
  datumSurveyId: string | null
  /** 当时生效的零点高程（m）；折算基准，与 datumSurveyId 对应 */
  datumZeroElevM: number | null
  /** 折到统一基面后的水位（m）= 水尺读数 + 生效零点；资料室按它定线 */
  datumStageM: number | null
  /** 基面来源状态：已折算 / 回填零点 / 待站上认 */
  datumStatus: DatumStatus
  /** 基面折算说明（回填或对不上时间的原因） */
  datumNote: string
  /** 最近一次参与定线并发布的版本 id；null 表示零点改动后尚未重算定案 */
  publishedVersionId: string | null
  createdAt: number
  updatedAt: number
}

/**
 * 已报出的定线版本（资料室侧，只追加、不改写）。
 * 零点改动后重算会生成新版本；旧版本连同当时的比测结论照样可查。
 */
export interface RatingVersion {
  id: string
  /** 定线号 */
  lineNo: string
  /** 发布序号（同一线自增，报出版本 v1/v2…） */
  versionNo: number
  /** 发布说明：初版 / 洪水后水尺接测重算 等 */
  reason: string
  /** 发布时的定线参数快照 */
  a: number
  b: number
  h0: number
  sampleCount: number
  meanResidualPct: number
  maxResidualPct: number
  r2: number
  valid: boolean
  message: string
  /** 发布时各点据的基面水位与流量快照（留档当时那版的点据，不随后续改动漂移） */
  points: Array<{
    ratingId: string
    stationId: string
    gaugeStageM: number
    datumZeroElevM: number | null
    datumStageM: number
    flowM3s: number
    datumSurveyId: string | null
  }>
  /** 发布当时的比测结论快照（曲线流量、偏差、合格/超限一并留档可查） */
  compares: Array<{
    ratingId: string
    measuredFlow: number
    curveFlow: number
    deviationPct: number
    verdict: '合格' | '超限'
    operator: string
    comparedAt: string
  }>
  /** 发布人 */
  publisher: string
  /** 发布时间（报出时间） */
  publishedAt: string
  createdAt: number
  updatedAt: number
}

/** 幂函数定线结果：Q = a * (H - H0)^b */
export interface RatingFitResult {
  lineNo: string
  /** 系数 a */
  a: number
  /** 指数 b */
  b: number
  /** 基线水位 H0（由点据自动搜索获得） */
  h0: number
  /** 参与拟合的点数 */
  sampleCount: number
  /** 拟合残差（相对误差绝对值均值，%） */
  meanResidualPct: number
  /** 最大残差（%） */
  maxResidualPct: number
  /** 决定系数 R²（对数域） */
  r2: number
  /** 是否可定线（点数 ≥ 3 且 b 为正） */
  valid: boolean
  /** 不可定线时的说明 */
  message: string
}

/** 关系点据页筛选条件（存于 ratingStore） */
export interface RatingFilterState {
  keyword: string
  stationIds: string[]
  lineNos: string[]
  verdicts: Array<'合格' | '超限'>
}

export function createEmptyRatingFilter(): RatingFilterState {
  return {
    keyword: '',
    stationIds: [],
    lineNos: [],
    verdicts: []
  }
}

/** 对 ln(Q) 与 ln(H - H0) 做最小二乘直线拟合，给定 H0 返回参数与残差 */
function fitWithBase(
  samples: Array<{ stageM: number; flowM3s: number }>,
  h0: number
): { a: number; b: number; residuals: number[] } | null {
  const points = samples.map((point) => ({
    x: Math.log(Math.max(point.stageM - h0, 1e-6)),
    y: Math.log(point.flowM3s)
  }))
  const n = points.length
  const sumX = points.reduce((sum, item) => sum + item.x, 0)
  const sumY = points.reduce((sum, item) => sum + item.y, 0)
  const sumXY = points.reduce((sum, item) => sum + item.x * item.y, 0)
  const sumXX = points.reduce((sum, item) => sum + item.x * item.x, 0)
  const denominator = n * sumXX - sumX * sumX
  if (Math.abs(denominator) < 1e-9) return null
  const b = (n * sumXY - sumX * sumY) / denominator
  const lnA = (sumY - b * sumX) / n
  const a = Math.exp(lnA)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null
  const residuals = samples.map((point) => {
    const predicted = a * Math.pow(Math.max(point.stageM - h0, 1e-6), b)
    return Math.abs((predicted - point.flowM3s) / point.flowM3s) * 100
  })
  return { a, b, residuals }
}

/**
 * 幂函数定线：Q = a×(H - H0)^b。
 * 在 [Hmin - 0.9×(Hmax-Hmin) , Hmin - 0.02] 区间内以 0.01 m 步长搜索 H0，
 * 取平均相对残差最小的一组参数，避免「基线贴近最低水位」造成幂函数畸变。
 */
export function fitPowerCurve(
  points: Array<{ stageM: number; flowM3s: number }>,
  lineNo = 'A'
): RatingFitResult {
  const usable = points.filter(
    (point) => Number.isFinite(point.stageM) && Number.isFinite(point.flowM3s) && point.flowM3s > 0
  )
  const base: RatingFitResult = {
    lineNo,
    a: 0,
    b: 0,
    h0: 0,
    sampleCount: usable.length,
    meanResidualPct: 0,
    maxResidualPct: 0,
    r2: 0,
    valid: false,
    message: ''
  }
  if (usable.length < 3) {
    return { ...base, message: '点据少于 3 个，无法定线（至少需要 3 个实测点）' }
  }
  const stageMin = Math.min(...usable.map((point) => point.stageM))
  const stageMax = Math.max(...usable.map((point) => point.stageM))
  const spread = Math.max(stageMax - stageMin, 0.05)
  const lowerH0 = stageMin - spread * 0.9
  const upperH0 = stageMin - 0.02

  let best: { a: number; b: number; h0: number; residuals: number[]; mean: number } | null = null
  const steps = Math.max(1, Math.round((upperH0 - lowerH0) / 0.01))
  for (let index = 0; index <= steps; index += 1) {
    const h0 = Number((lowerH0 + (index * (upperH0 - lowerH0)) / steps).toFixed(4))
    const candidate = fitWithBase(usable, h0)
    if (!candidate) continue
    const mean = candidate.residuals.reduce((sum, value) => sum + value, 0) / candidate.residuals.length
    if (!best || mean < best.mean) {
      best = { ...candidate, h0, mean }
    }
  }
  if (!best) {
    return { ...base, message: '水位点据过于集中，无法求解幂函数指数' }
  }

  // 对数域决定系数 R²
  const lnFlows = usable.map((point) => Math.log(point.flowM3s))
  const meanLnFlow = lnFlows.reduce((sum, value) => sum + value, 0) / lnFlows.length
  const totalSs = lnFlows.reduce((sum, value) => sum + (value - meanLnFlow) ** 2, 0)
  const residualSs = usable.reduce((sum, point) => {
    const predicted = best.a * Math.pow(Math.max(point.stageM - best.h0, 1e-6), best.b)
    const diff = Math.log(point.flowM3s) - Math.log(Math.max(predicted, 1e-6))
    return sum + diff * diff
  }, 0)
  const r2 = totalSs < 1e-9 ? 1 : Number(Math.max(0, 1 - residualSs / totalSs).toFixed(4))

  const valid = best.b > 0 && Number.isFinite(best.a)
  return {
    lineNo,
    a: Number(best.a.toFixed(4)),
    b: Number(best.b.toFixed(3)),
    h0: Number(best.h0.toFixed(3)),
    sampleCount: usable.length,
    meanResidualPct: Number(best.mean.toFixed(2)),
    maxResidualPct: Number(Math.max(...best.residuals).toFixed(2)),
    r2,
    valid,
    message: valid ? '定线有效' : '指数 b ≤ 0，点据趋势异常，请检查水位与流量的对应关系'
  }
}

/** 由定线参数计算曲线流量 */
export function curveFlow(fit: RatingFitResult, stageM: number): number {
  if (!fit.valid) return 0
  const value = fit.a * Math.pow(Math.max(stageM - fit.h0, 1e-6), fit.b)
  return Number(value.toFixed(2))
}

/** 参与基面折算定线的点据状态（「待站上认」的点据剔除，不参与） */
export const FITTABLE_DATUM_STATUSES: DatumStatus[] = ['resolved', 'backfilled']

/** 可参与基面定线的点据最小结构（种子数据可缺时间戳） */
export type DatumFittable = Pick<
  Rating,
  'lineNo' | 'flowM3s' | 'datumStatus' | 'datumStageM'
>

/**
 * 资料室定线口径：按各点据「测流当时那次零点」折到同一基面后的 datumStageM 拟合。
 * datumStatus 为 pending（对不上时间、待站上认）的点据不参与定线。
 */
export function fitRatingsOnDatum(ratings: DatumFittable[], lineNo: string): RatingFitResult {
  const points = ratings
    .filter(
      (rating) =>
        rating.lineNo === lineNo &&
        FITTABLE_DATUM_STATUSES.includes(rating.datumStatus) &&
        typeof rating.datumStageM === 'number' &&
        Number.isFinite(rating.datumStageM)
    )
    .map((rating) => ({ stageM: rating.datumStageM as number, flowM3s: rating.flowM3s }))
  return fitPowerCurve(points, lineNo)
}
