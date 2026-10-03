/**
 * 资料室侧「统一基面折算 + 重新定线」任务。
 * 水尺零点改动后，未定案定线需要按各点据测流当时的零点重算；任务由资料室发起、
 * 在资料室侧重试。重算事务只读写资料室侧表（点据折算水位、定线状态、比测），
 * 站上的水尺接测记录不参与写入，因此重算失败不影响站上档案，可从本任务直接重试。
 */

/** 重算任务状态 */
export type RecalcJobStatus = 'pending' | 'running' | 'succeeded' | 'failed'

export interface RecalcJob {
  id: string
  /** 重算范围：某条定线号；stationId 仅用于展示与触发来源 */
  lineNo: string
  stationId: string
  /** 触发原因：新接测零点生效 / 站上确认零点 / 手动重算 / 新版本 */
  reason: '零点接测生效' | '站上确认零点' | '手动重算' | '新开版本'
  status: RecalcJobStatus
  /** 已尝试次数：失败后每重试一次累加 */
  attempts: number
  /** 失败时的错误信息，供资料室定位 */
  errorMessage: string
  /** 仅用于演练「重算失败 → 从资料室重试、站上记录不受影响」：置位后本次执行强制失败 */
  forceFailOnce: boolean
  createdAt: number
  updatedAt: number
  lastTriedAt: number | null
  succeededAt: number | null
}

/** 定线重算的逐点折算结果 */
export interface DatumPointResult {
  ratingId: string
  stationId: string
  measuredAt: string
  /** 水尺读数（m，原始，不改） */
  stageM: number
  /** 采用的接测记录 */
  surveyId: string | null
  zeroElevationM: number | null
  /** 统一基面水位（m）；对不上时间时为 null */
  datumStageM: number | null
  /** 是否时间对不上、挑出交站上确认 */
  unmatched: boolean
}
