/**
 * 定线 store（资料室限界）：维护水位流量关系点据、比测记录、定线版本与残差派生值。
 * 供关系点据页（/ratings）与导出页（/export）共用。
 *
 * 基面口径：点据 stageM 是站上水尺读数（零点起算）；
 * 定线一律使用 datumStageM —— 按「测流当时那一次接测零点」折到同一基面后的水位。
 * datumStatus=pending（对不上时间、待站上认）的点据不参与定线。
 *
 * 重算边界：recomputeDatum / publishVersion 只写资料室表，
 * 不增改站上的 gaugeSurveys；重算失败可从本侧重试。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, type CompareRow } from '@/types/compare'
import type { Rating, RatingFitResult, RatingVersion } from '@/types/rating'
import {
  createEmptyRatingFilter,
  curveFlow,
  fitRatingsOnDatum,
  type RatingFilterState
} from '@/types/rating'
import type { Station } from '@/types/station'
import type { GaugeSurvey } from '@/types/gaugeSurvey'
import { surveyEffectiveAt } from '@/types/gaugeSurvey'
import {
  publishRatingVersion,
  recalcRatingsDatum,
  workingCompareId,
  type RecalcResult
} from '@/utils/datum'

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const versions = ref<RatingVersion[]>([])
  const surveys = ref<GaugeSurvey[]>([])
  const stations = ref<Station[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const recalculating = ref(false)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  /** 当前定线号与定线参数（跨页保留） */
  const activeLineNo = ref<string>('A')
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Compare>(() => db.compares).subscribe((rows) => {
      compares.value = rows
    })
    watchTable<RatingVersion>(() => db.ratingVersions).subscribe((rows) => {
      versions.value = rows
    })
    watchTable<GaugeSurvey>(() => db.gaugeSurveys).subscribe((rows) => {
      surveys.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
  }

  /** 当前工作版比测（未定案，随零点改动重算） */
  const workingCompares = computed<Compare[]>(() =>
    compares.value.filter((compare) => compare.ratingVersionId === null)
  )

  /** 已报出版本的归档比测（冻结，只用于历史查询） */
  const archivedCompares = computed<Compare[]>(() =>
    compares.value.filter((compare) => compare.ratingVersionId !== null)
  )

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 逐定线号、按统一基面水位拟合（pending 点据不参与） */
  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.map((lineNo) => fitRatingsOnDatum(ratings.value, lineNo))
  )

  const activeFit = computed<RatingFitResult>(() => {
    const found = allFits.value.find((fit) => fit.lineNo === activeLineNo.value)
    return found ?? fitRatingsOnDatum([], activeLineNo.value)
  })

  /** 某线最近一次报出版本 */
  function latestVersionOfLine(lineNo: string): RatingVersion | null {
    const owned = versions.value.filter((version) => version.lineNo === lineNo)
    if (owned.length === 0) return null
    return owned.reduce((latest, version) => (version.versionNo > latest.versionNo ? version : latest))
  }

  /**
   * 零点改动后该线是否还没定案（需重算后重新报出）：
   * 有点据未挂最近版本，或某点据当前生效的接测晚于最近版本的报出时间
   * （即报出之后站上又重新接测、零点变了，这版就过时了）。
   */
  function isLineStale(lineNo: string): boolean {
    const latestVersion = latestVersionOfLine(lineNo)
    const lineRatings = ratings.value.filter(
      (rating) => rating.lineNo === lineNo && rating.datumStatus !== 'pending'
    )
    if (lineRatings.length === 0) return false
    if (!latestVersion) return true
    const publishedAt = Date.parse(latestVersion.publishedAt)
    return lineRatings.some((rating) => {
      if (rating.publishedVersionId !== latestVersion.id) return true
      const survey = rating.datumSurveyId
        ? surveys.value.find((item) => item.id === rating.datumSurveyId)
        : null
      return survey !== null && survey !== undefined && Date.parse(survey.surveyedAt) > publishedAt
    })
  }

  /** 当前线待重算标记 */
  const activeLineStale = computed<boolean>(() => isLineStale(activeLineNo.value))

  /** 点据 + 曲线流量 + 残差（工作版口径，使用统一基面水位） */
  const pointRows = computed(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => (a.datumStageM ?? a.stageM) - (b.datumStageM ?? b.stageM))
      .map((rating) => {
        const fit = activeFit.value
        const stageForFit = rating.datumStageM ?? rating.stageM
        const predicted =
          fit.valid && rating.datumStatus !== 'pending' ? curveFlow(fit, stageForFit) : 0
        const residualPct =
          fit.valid && rating.datumStatus !== 'pending' && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return { rating, predicted, residualPct }
      })
  )

  /** 待站上认定的点据（时间对不上任何接测零点） */
  const pendingRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => rating.datumStatus === 'pending')
  )

  /** 按筛选条件过滤后的点据 */
  const filteredRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${rating.measureNo}${rating.lineNo}${stationNameOf(rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(rating.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(rating.lineNo)) return false
      if (filter.value.verdicts.length > 0) {
        const compare = workingCompares.value.find((item) => item.ratingId === rating.id)
        if (!compare || !filter.value.verdicts.includes(compare.verdict)) return false
      }
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.stationIds.length > 0 ||
      filter.value.lineNos.length > 0 ||
      filter.value.verdicts.length > 0
  )

  /** 比测行（当前工作版）：比测记录 + 点据 + 测站名，导出页与分析清单消费 */
  const compareRows = computed<CompareRow[]>(() =>
    workingCompares.value
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        return {
          compare,
          rating,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: rating?.lineNo ?? '-'
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  )

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  /** 定线质量派生值：平均残差与合格点占比 */
  const fitQuality = computed(() => {
    const valid = allFits.value.filter((fit) => fit.valid)
    const meanResidual = valid.length
      ? Number((valid.reduce((sum, fit) => sum + fit.meanResidualPct, 0) / valid.length).toFixed(2))
      : 0
    const total = compareRows.value.length
    const over = overLimitRows.value.length
    return {
      validLineCount: valid.length,
      meanResidualPct: meanResidual,
      compareCount: total,
      overLimitCount: over,
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

  function patchFilter(patch: Partial<RatingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRatingFilter()
  }

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setDeviationLimit(limit: number): void {
    deviationLimitPct.value = limit
  }

  /** 新增点据时按测流当时那一次接测零点即时折算基面（不落接测记录） */
  function resolveNewDatum(
    stationId: string,
    gaugeStageM: number,
    measuredAtIso: string
  ): Pick<Rating, 'datumSurveyId' | 'datumZeroElevM' | 'datumStageM' | 'datumStatus' | 'datumNote'> {
    const resolution = surveyEffectiveAt(surveys.value, stationId, measuredAtIso)
    if (resolution) {
      return {
        datumSurveyId: resolution.id,
        datumZeroElevM: resolution.zeroElevM,
        datumStageM: Number((gaugeStageM + resolution.zeroElevM).toFixed(3)),
        datumStatus: 'resolved',
        datumNote: `按测流当时生效零点折算（接测 ${resolution.surveyedAt.slice(0, 10)}，${resolution.surveyor}）`
      }
    }
    return {
      datumSurveyId: null,
      datumZeroElevM: null,
      datumStageM: null,
      datumStatus: 'pending',
      datumNote: '该测次时间对不上任何水尺接测记录，待站上认定零点'
    }
  }

  async function createRating(
    payload: Omit<Rating, 'id' | 'createdAt' | 'updatedAt' | 'publishedVersionId'>
  ): Promise<Rating> {
    const now = Date.now()
    const row: Rating = {
      ...payload,
      publishedVersionId: null,
      id: createId('rat'),
      createdAt: now,
      updatedAt: now
    }
    await db.ratings.put(row)
    return row
  }

  async function updateRating(id: string, patch: Partial<Rating>): Promise<void> {
    await db.ratings.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeRating(id: string): Promise<void> {
    await db.transaction('rw', [db.ratings, db.compares], async () => {
      // 仅删该点据的工作版比测；已报出版本的归档比测作为历史结论保留
      await db.compares.delete(workingCompareId(id))
      await db.ratings.delete(id)
    })
  }

  /**
   * 资料室重算：按当前接测零点把点据折到同一基面，并重算各线定线、工作版比测。
   * 幂等可重试；可限定测站（站上某次接测后）或全量（手动重试）。
   * 抛出异常时调用方可再次调用 —— 不触碰站上接测记录。
   */
  async function recomputeDatum(options: { stationIds?: string[]; legacy?: boolean } = {}): Promise<RecalcResult> {
    recalculating.value = true
    try {
      return await recalcRatingsDatum(options)
    } finally {
      recalculating.value = false
    }
  }

  /** 报出当前定线：冻结点据基面快照与比测结论为新版本（只追加） */
  async function publishVersion(lineNo: string, reason: string, publisher: string): Promise<RatingVersion> {
    return publishRatingVersion(lineNo, { reason, publisher })
  }

  /** 某线全部报出版本（按版本号倒序） */
  function versionsOfLine(lineNo: string): RatingVersion[] {
    return versions.value
      .filter((version) => version.lineNo === lineNo)
      .slice()
      .sort((a, b) => b.versionNo - a.versionNo)
  }

  return {
    ratings,
    compares,
    workingCompares,
    archivedCompares,
    versions,
    surveys,
    stations,
    ready,
    error,
    recalculating,
    filter,
    activeLineNo,
    activeFit,
    deviationLimitPct,
    lineNos,
    allFits,
    pointRows,
    pendingRatings,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    activeLineStale,
    start,
    stationNameOf,
    patchFilter,
    resetFilter,
    setActiveLine,
    setDeviationLimit,
    resolveNewDatum,
    createRating,
    updateRating,
    removeRating,
    recomputeDatum,
    publishVersion,
    versionsOfLine,
    latestVersionOfLine,
    isLineStale
  }
})
