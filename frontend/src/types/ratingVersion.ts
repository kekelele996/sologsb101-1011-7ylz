/**
 * 定线状态与报出版本（资料室侧职责）。
 * - RatingLineState：每条定线号当前是否已定案。零点改动后只有「未定案（draft）」的线需要重算；
 * - RatingVersion：定案时生成的只读快照，报出去的那版连同当时的比测结论原样可查，永不被重算覆盖。
 */
import type { CompareVerdict } from './compare'
import type { RatingFitResult } from './rating'

/** 定线状态：draft 未定案（零点变动后要重算）；finalized 已定案报出（只读快照留档） */
export type RatingLineStatus = 'draft' | 'finalized'

export interface RatingLineState {
  id: string
  /** 定线号（全站统一编号，一条定线号对应一个状态行） */
  lineNo: string
  /** 主要归属测站（点据可能跨站时取首个，仅用于展示） */
  stationId: string
  status: RatingLineStatus
  /** 最近一次生效的接测变化时间（水尺零点改动后标记，供页面提示重算） */
  lastSurveyAt: string | null
  /** 当前定线是否需要按最新零点折算结果重算 */
  needsRecalc: boolean
  /** 最近一次重算时间 */
  lastRecalcAt: number | null
  createdAt: number
  updatedAt: number
}

/** 定案报出时的点据快照（统一基面水位 + 实测流量） */
export interface RatingVersionPoint {
  ratingId: string
  stationId: string
  measureNo: string
  measuredAt: string
  /** 定案当时采用的接测记录 id */
  surveyId: string | null
  /** 水尺读数（m，原始） */
  stageM: number
  /** 折算到统一基面的水位（m） */
  datumStageM: number
  flowM3s: number
  /** 定案当时的曲线流量（m³/s） */
  curveFlowM3s: number
  /** 定案当时的偏差（%）与判定 */
  deviationPct: number
  verdict: CompareVerdict
}

/** 定案报出版本快照：只追加、不可修改，随时可查 */
export interface RatingVersion {
  id: string
  lineNo: string
  stationId: string
  /** 版本号，如 A-V1、A-V2 */
  versionNo: string
  /** 幂函数定线参数与残差（报出当时） */
  fit: RatingFitResult
  /** 报出当时参与定线的点据与比测结论 */
  points: RatingVersionPoint[]
  /** 报出时的比测合格情况汇总 */
  compareCount: number
  overLimitCount: number
  qualifyRatePct: number
  /** 定案 / 报出说明 */
  note: string
  operator: string
  publishedAt: string
  createdAt: number
}
