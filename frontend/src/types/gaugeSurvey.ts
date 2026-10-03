/**
 * 水尺接测记录（站上侧职责）。
 * 洪水过后水尺重新接测，零点高程可能变动；记录只允许追加，不允许改写或删除，
 * 资料室按「测流当时最近一次已生效接测」的零点把水尺读数折算到统一基面。
 */

/** 水尺接测记录：每接一次记一条 */
export interface GaugeSurvey {
  id: string
  /** 所属测站 */
  stationId: string
  /** 水尺编号（同站多支水尺时区分） */
  gaugeCode: string
  /**
   * 接测时间，也是本次零点的生效时间。
   * 生效规则：测流时间 >= 接测时间的点据，采用本条零点；直到下一次接测。
   */
  surveyedAt: string
  /** 水尺零点高程（m，统一基面对应值）：统一基面水位 = 水尺读数 + 零点高程 */
  zeroElevationM: number
  /** 接测人 */
  operator: string
  /** 接测说明（如洪水后零点下沉、引测来源） */
  remark: string
  /** 是否升级时按「最近一次接测」回填生成（非站上实登记） */
  backfilled: boolean
  createdAt: number
  updatedAt: number
}

/** 新增接测记录的入参（id 与时间戳由持久层补） */
export type GaugeSurveyInput = Omit<GaugeSurvey, 'id' | 'createdAt' | 'updatedAt'>

/** 新建接测记录时的空白表单 */
export function createEmptySurveyInput(stationId: string): Omit<GaugeSurveyInput, 'stationId'> {
  return {
    gaugeCode: 'P1',
    surveyedAt: new Date().toISOString().slice(0, 16),
    zeroElevationM: 0,
    operator: '',
    remark: '',
    backfilled: false
  }
}

/**
 * 取测流当时生效的接测记录：同站、同水尺（缺省 P1）中接测时间不晚于测流时间的最近一条。
 * 返回 null 表示没有任何一条接测能对上测流时间，该点据要挑出来交站上确认。
 */
export function effectiveSurvey(
  surveys: GaugeSurvey[],
  stationId: string,
  measuredAt: string,
  gaugeCode = 'P1'
): GaugeSurvey | null {
  const measuredTime = Date.parse(measuredAt)
  const candidates = surveys
    .filter(
      (survey) =>
        survey.stationId === stationId &&
        (survey.gaugeCode === gaugeCode || survey.gaugeCode === 'P1') &&
        Date.parse(survey.surveyedAt) <= measuredTime
    )
    .sort((a, b) => Date.parse(b.surveyedAt) - Date.parse(a.surveyedAt))
  return candidates[0] ?? null
}

/** 取某站当前（最近一次）接测记录，供站上页面回显现行零点 */
export function latestSurvey(surveys: GaugeSurvey[], stationId: string, gaugeCode = 'P1'): GaugeSurvey | null {
  return (
    surveys
      .filter((survey) => survey.stationId === stationId && (survey.gaugeCode === gaugeCode || survey.gaugeCode === 'P1'))
      .sort((a, b) => Date.parse(b.surveyedAt) - Date.parse(a.surveyedAt))[0] ?? null
  )
}
