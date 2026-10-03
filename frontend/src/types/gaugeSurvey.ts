/**
 * 水尺接测（站上限界）。
 * 洪水后水尺重新接测时，由站上登记一次记录：零点高程、接测时间、接测人。
 * 资料室只允许读取这些记录用于基面折算，不允许改、不允许删。
 */

/** 水尺零点高程记录：一次接测一条，同一测站按时间先后衔接 */
export interface GaugeSurvey {
  id: string
  /** 所属测站 */
  stationId: string
  /** 接测序号（同一测站自增，仅用于台账展示） */
  surveyNo: number
  /** 水尺零点高程（m，统一基面，如假定基面 / 黄海基面） */
  zeroElevM: number
  /** 接测时间：该零点自此刻起生效，直到下一次接测 */
  surveyedAt: string
  /** 接测人 */
  surveyor: string
  /** 备注（如：洪水过后水尺下沉 0.12m，重新接测） */
  note: string
  createdAt: number
  updatedAt: number
}

/**
 * 关系点据基面来源状态（资料室侧标记）：
 * - resolved 已折算：测流当时能匹配到生效的接测记录
 * - backfilled 回填：旧数据无零点记录，升级时按最近一次接测回填
 * - pending 待站上认：时间对不上任何接测，挑出来交站上认定
 */
export type DatumStatus = 'resolved' | 'backfilled' | 'pending'

export const DATUM_STATUS_LABEL: Record<DatumStatus, string> = {
  resolved: '已折算',
  backfilled: '回填零点',
  pending: '待站上认'
}

export const DATUM_STATUS_TONE: Record<DatumStatus, 'success' | 'warning' | 'danger'> = {
  resolved: 'success',
  backfilled: 'warning',
  pending: 'danger'
}

/**
 * 基面解析结果：按测流当时那一次接测的零点，把水尺读数折到同一基面。
 * 统一基面水位 = 水尺读数 + 该时刻生效零点高程。
 */
export interface DatumResolution {
  /** 基面来源状态 */
  status: DatumStatus
  /** 生效的接测记录（pending 时为 null） */
  survey: GaugeSurvey | null
  /** 生效零点高程（m）；pending 时为 null */
  zeroElevM: number | null
  /** 折到统一基面后的水位（m）；pending 时为 null，不参与定线 */
  datumStageM: number | null
  /** 说明文案（回填 / 对不上的原因，供页面与异常清单展示） */
  reason: string
}

/**
 * 取某时刻对某测站生效的接测记录：
 * surveyedAt ≤ 该时刻的最后一次接测；一次都没有则返回 null。
 */
export function surveyEffectiveAt(
  surveys: GaugeSurvey[],
  stationId: string,
  measuredAtIso: string
): GaugeSurvey | null {
  const t = Date.parse(measuredAtIso)
  if (!Number.isFinite(t)) return null
  let picked: GaugeSurvey | null = null
  for (const survey of surveys) {
    if (survey.stationId !== stationId) continue
    const st = Date.parse(survey.surveyedAt)
    if (Number.isFinite(st) && st <= t) {
      if (picked === null || st >= Date.parse(picked.surveyedAt)) picked = survey
    }
  }
  return picked
}

/**
 * 升级 / 回填策略：旧数据没有零点记录时，
 * 优先按「测流当时那一次」（surveyedAt ≤ 测流时间）取最近接测；
 * 若该测站在测流时间之后才有接测记录，时间对不上，返回 pending 交站上认。
 */
export function resolveDatum(
  surveys: GaugeSurvey[],
  stationId: string,
  gaugeStageM: number,
  measuredAtIso: string,
  /** true 表示历史旧数据（升级回填场景），会给出 backfilled 状态 */
  legacy = false
): DatumResolution {
  const effective = surveyEffectiveAt(surveys, stationId, measuredAtIso)
  if (effective) {
    return {
      status: legacy ? 'backfilled' : 'resolved',
      survey: effective,
      zeroElevM: effective.zeroElevM,
      datumStageM: Number((gaugeStageM + effective.zeroElevM).toFixed(3)),
      reason: legacy
        ? `旧数据无零点记录，按最近一次接测（${effective.surveyedAt.slice(0, 10)}，${effective.surveyor}）回填`
        : `按测流当时生效零点折算（接测 ${effective.surveyedAt.slice(0, 10)}，${effective.surveyor}）`
    }
  }
  const later = surveys
    .filter((survey) => survey.stationId === stationId && Date.parse(survey.surveyedAt) > Date.parse(measuredAtIso))
    .sort((a, b) => Date.parse(a.surveyedAt) - Date.parse(b.surveyedAt))
  const reason =
    later.length > 0
      ? `测流时间 ${measuredAtIso.slice(0, 10)} 早于该站最早接测 ${later[0].surveyedAt.slice(0, 10)}，时间对不上，待站上认定`
      : '该测站尚无任何水尺接测记录，待站上认定零点'
  return { status: 'pending', survey: null, zeroElevM: null, datumStageM: null, reason }
}

/** 下一个接测序号 */
export function nextSurveyNo(surveys: GaugeSurvey[], stationId: string): number {
  const owned = surveys.filter((survey) => survey.stationId === stationId)
  return owned.reduce((max, survey) => Math.max(max, survey.surveyNo), 0) + 1
}
