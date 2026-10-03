/**
 * 站上侧 store：水尺接测记录（只追加）与待站上确认的基面异常点据。
 * 站上只管接测：每接一次记零点、接测时间与接测人；不直接改资料室的定线。
 * 新增接测后通知资料室侧把受影响的未定案定线挂上重算任务（enqueueAffectedLines）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { GaugeSurvey, GaugeSurveyInput } from '@/types/gaugeSurvey'
import { latestSurvey } from '@/types/gaugeSurvey'
import type { Rating } from '@/types/rating'
import type { Station } from '@/types/station'
import { enqueueAffectedLines, confirmDatumForRating } from '@/utils/recalc'

export const useSurveyStore = defineStore('survey', () => {
  const surveys = ref<GaugeSurvey[]>([])
  const ratings = ref<Rating[]>([])
  const stations = ref<Station[]>([])
  const ready = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<GaugeSurvey>(() => db.gaugeSurveys).subscribe((rows) => {
      surveys.value = rows
      ready.value = true
    })
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
  }

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 接测记录按时间倒序（最新一次在前） */
  function surveysOfStation(stationId: string): GaugeSurvey[] {
    return surveys.value
      .filter((survey) => survey.stationId === stationId)
      .sort((a, b) => Date.parse(b.surveyedAt) - Date.parse(a.surveyedAt))
  }

  /** 站上回显的现行零点（最近一次接测） */
  function currentZero(stationId: string): GaugeSurvey | null {
    return latestSurvey(surveys.value, stationId)
  }

  /** 资料室折算时时间对不上、挑出来交站上认的点据 */
  const unmatchedRatings = computed<Rating[]>(() =>
    ratings.value
      .filter((rating) => rating.datumStatus === 'unmatched')
      .sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt))
  )

  function unmatchedOfStation(stationId: string): Rating[] {
    return unmatchedRatings.value.filter((rating) => rating.stationId === stationId)
  }

  /**
   * 登记一次水尺接测（只追加，不修改不删除）。
   * 落账后由资料室侧把该站未定案定线挂重算任务；接测记录本身不受后续重算成败影响。
   */
  async function addSurvey(input: GaugeSurveyInput): Promise<GaugeSurvey> {
    const now = Date.now()
    const row: GaugeSurvey = { ...input, id: createId('gsv'), createdAt: now, updatedAt: now }
    await db.gaugeSurveys.put(row)
    await enqueueAffectedLines(row, '零点接测生效')
    return row
  }

  /**
   * 站上认点：确认某条对不上时间的点据按指定接测（通常是更早的一次补测）零点折基面。
   * 折账与重算由资料室侧逻辑处理；站上的接测记录不做任何改写。
   */
  async function confirmRatingDatum(ratingId: string, surveyId: string): Promise<void> {
    const rating = ratings.value.find((item) => item.id === ratingId)
    const survey = surveys.value.find((item) => item.id === surveyId)
    if (!rating || !survey) throw new Error('点据或接测记录不存在')
    await confirmDatumForRating(rating, survey)
  }

  /** 该站一次认掉全部对不上时间的点据（按指定接测零点折基面） */
  async function confirmAllForStation(stationId: string, surveyId: string): Promise<number> {
    const survey = surveys.value.find((item) => item.id === surveyId)
    if (!survey) throw new Error('接测记录不存在')
    const targets = unmatchedOfStation(stationId)
    for (const rating of targets) {
      await confirmDatumForRating(rating, survey)
    }
    return targets.length
  }

  return {
    surveys,
    ratings,
    stations,
    ready,
    start,
    stationNameOf,
    surveysOfStation,
    currentZero,
    unmatchedRatings,
    unmatchedOfStation,
    addSurvey,
    confirmRatingDatum,
    confirmAllForStation
  }
})
