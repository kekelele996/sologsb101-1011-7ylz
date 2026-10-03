/**
 * 基面折算（资料室侧纯函数，不触碰 IndexedDB）。
 * 统一基面水位 = 水尺读数 + 测流当时生效接测的零点高程；
 * 时间对不上（没有任何一条不晚于测流时间的接测）的点据折算不出来，挑出来交站上确认。
 */
import type { GaugeSurvey } from '@/types/gaugeSurvey'
import { effectiveSurvey } from '@/types/gaugeSurvey'
import type { Rating } from '@/types/rating'
import type { DatumPointResult } from '@/types/recalc'

/** 零点高程参与基面相加时保留的小数位 */
export const DATUM_STAGE_PRECISION = 3

/**
 * 按测流当时那一次接测的零点，把点据水尺读数折到统一基面。
 * 同一测站同一场洪水中的点据各自匹配当时生效的零点，避免「零点改了但全站按一个数」
 * 造成的点据忽高忽低。
 */
export function foldRatings(ratings: Rating[], surveys: GaugeSurvey[]): DatumPointResult[] {
  return ratings.map((rating) => {
    const survey = effectiveSurvey(surveys, rating.stationId, rating.measuredAt)
    if (!survey) {
      return {
        ratingId: rating.id,
        stationId: rating.stationId,
        measuredAt: rating.measuredAt,
        stageM: rating.stageM,
        surveyId: null,
        zeroElevationM: null,
        datumStageM: null,
        unmatched: true
      }
    }
    return {
      ratingId: rating.id,
      stationId: rating.stationId,
      measuredAt: rating.measuredAt,
      stageM: rating.stageM,
      surveyId: survey.id,
      zeroElevationM: survey.zeroElevationM,
      datumStageM: Number((rating.stageM + survey.zeroElevationM).toFixed(DATUM_STAGE_PRECISION)),
      unmatched: false
    }
  })
}

/** 待站上确认的点据：折算不出基面水位的 */
export function unmatchedResults(results: DatumPointResult[]): DatumPointResult[] {
  return results.filter((result) => result.unmatched)
}

/**
 * 旧数据升级回填：没有任何零点记录的测站，按该站「最近一次测流（关系点据时间）」
 * 补一条回填接测记录，零点高程暂取 0 并标记 backfilled，待站上校核。
 * 回填时间取最近一次测流，因此早于该时间的点据仍然对不上时间，会被挑出来交站上认。
 * 已有接测记录的测站不回填，直接走正常折算。
 */
export function planLegacyBackfill(
  ratings: Rating[],
  existingSurveys: GaugeSurvey[],
  makeId: (prefix: string) => string,
  now: number = Date.now()
): GaugeSurvey[] {
  const stationIdsWithSurveys = new Set(existingSurveys.map((survey) => survey.stationId))
  const latestByStation = new Map<string, string>()
  ratings.forEach((rating) => {
    const current = latestByStation.get(rating.stationId)
    if (!current || Date.parse(rating.measuredAt) > Date.parse(current)) {
      latestByStation.set(rating.stationId, rating.measuredAt)
    }
  })

  const created: GaugeSurvey[] = []
  latestByStation.forEach((latestMeasuredAt, stationId) => {
    if (stationIdsWithSurveys.has(stationId)) return
    created.push({
      id: makeId('gsv'),
      stationId,
      gaugeCode: 'P1',
      surveyedAt: latestMeasuredAt,
      zeroElevationM: 0,
      operator: '',
      remark: '历史数据无零点记录，升级时按最近一次测流回填（零点高程暂取 0，待站上校核）',
      backfilled: true,
      createdAt: now,
      updatedAt: now
    })
  })
  return created
}
