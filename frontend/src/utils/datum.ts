/**
 * 基面折算与定线重算服务（资料室侧）。
 *
 * 边界：
 * - 站上侧（gaugeSurvey 记录）只读：本服务不增、不改、不删任何接测记录；
 *   资料室重算失败时从本侧重试即可，站上的接测记录不受影响。
 * - 资料室侧可写：关系点据的基面字段、当前工作版比测记录、报出版本（只追加）。
 */
import { db, createId } from '@/utils/db'
import {
  resolveDatum,
  type GaugeSurvey,
  type DatumResolution
} from '@/types/gaugeSurvey'
import {
  curveFlow,
  fitRatingsOnDatum,
  type Rating,
  type RatingVersion
} from '@/types/rating'
import { calcDeviationPct, judgeDeviation, type Compare } from '@/types/compare'

/** 工作版（未定案、可随零点改动重算）的比测记录 id */
export function workingCompareId(ratingId: string): string {
  return `cmp_cur_${ratingId}`
}

/** 报出版本归档比测记录 id */
export function archivedCompareId(versionId: string, ratingId: string): string {
  return `cmp_${versionId}_${ratingId}`
}

/** 按站上接测记录，把单条点据的水尺读数折到统一基面（不落库） */
export function resolveRatingDatum(
  rating: Rating,
  surveys: GaugeSurvey[],
  legacy = false
): DatumResolution {
  return resolveDatum(surveys, rating.stationId, rating.stageM, rating.measuredAt, legacy)
}

export interface RecalcResult {
  /** 重新折算基面的点据数 */
  ratingsRecalculated: number
  /** 对不上时间、挑出待站上认的点据数 */
  pendingCount: number
  /** 回填零点的点据数 */
  backfilledCount: number
  /** 重算的定线号及对应比测条数 */
  lines: Array<{ lineNo: string; compareCount: number; valid: boolean }>
}

/**
 * 资料室重算：按测流当时那一次零点，把关系点据水位折到同一基面，
 * 然后逐线重算定线、重算工作版比测偏差与判定。
 *
 * 幂等、可安全重试：只覆盖点据基面字段与 ratingVersionId 为 null 的工作版比测；
 * 已报出版本的冻结比测记录一律不动。
 *
 * @param options.stationIds 仅重算指定测站（站上新增/修改某次接测后使用）；
 *   不传则全量重算（升级回填、手动重试使用）。
 * @param options.legacy 旧数据无零点记录场景：命中接测记为 backfilled。
 */
export async function recalcRatingsDatum(options: {
  stationIds?: string[]
  legacy?: boolean
} = {}): Promise<RecalcResult> {
  const { stationIds, legacy = false } = options
  const [allRatings, surveys] = await Promise.all([db.ratings.toArray(), db.gaugeSurveys.toArray()])
  const stationSet = stationIds ? new Set(stationIds) : null
  const targets = stationSet
    ? allRatings.filter((rating) => stationSet.has(rating.stationId))
    : allRatings
  const affectedLineNos = new Set(targets.map((rating) => rating.lineNo))

  // 第一步：基面折算。站上接测记录只读，本事务只写 ratings 与 compares。
  await db.transaction('rw', [db.ratings, db.compares], async () => {
    for (const rating of targets) {
      const resolution = resolveRatingDatum(rating, surveys, legacy)
      const patch: Partial<Rating> = {
        datumSurveyId: resolution.survey?.id ?? null,
        datumZeroElevM: resolution.zeroElevM,
        datumStageM: resolution.datumStageM,
        datumStatus: resolution.status,
        datumNote: resolution.reason,
        updatedAt: Date.now()
      }
      await db.ratings.update(rating.id, patch as never)
    }

    // 第二步：受影响的各线重算工作版比测（已报出版本的归档比测不动）
    for (const lineNo of affectedLineNos) {
      // 先清掉该线全部工作版比测，再按当前可定线点据重建：
      // 翻成 pending（待站上认）的点据不再保留过时的工作版结论。
      const lineRatings = await db.ratings.where('lineNo').equals(lineNo).toArray()
      const staleIds = lineRatings.map((rating) => workingCompareId(rating.id))
      if (staleIds.length > 0) {
        await db.compares.bulkDelete(staleIds)
      }
      await rebuildLineWorkingComparesTx(lineNo)
    }
  })

  const refreshed = await db.ratings.toArray()
  const scoped = stationSet
    ? refreshed.filter((rating) => stationSet.has(rating.stationId))
    : refreshed
  const lines = Array.from(affectedLineNos).map((lineNo) => {
    const fit = fitRatingsOnDatum(refreshed, lineNo)
    const count = refreshed.filter(
      (rating) => rating.lineNo === lineNo && rating.datumStatus !== 'pending'
    ).length
    return { lineNo, compareCount: count, valid: fit.valid }
  })

  return {
    ratingsRecalculated: scoped.length,
    pendingCount: scoped.filter((rating) => rating.datumStatus === 'pending').length,
    backfilledCount: scoped.filter((rating) => rating.datumStatus === 'backfilled').length,
    lines
  }
}

/** 事务内：重建某定线号的工作版（ratingVersionId=null）比测记录 */
async function rebuildLineWorkingComparesTx(lineNo: string): Promise<number> {
  const ratings = await db.ratings.where('lineNo').equals(lineNo).toArray()
  const fit = fitRatingsOnDatum(ratings, lineNo)
  const fittable = ratings.filter((rating) => rating.datumStatus !== 'pending')
  if (fittable.length === 0) return 0
  const now = Date.now()
  const rows: Compare[] = fittable.map((rating) => {
    const datumStage = rating.datumStageM ?? rating.stageM
    const predicted = fit.valid ? curveFlow(fit, datumStage) : rating.flowM3s
    const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
    return {
      id: workingCompareId(rating.id),
      ratingId: rating.id,
      ratingVersionId: null,
      datumStageM: rating.datumStageM,
      measuredFlow: rating.flowM3s,
      curveFlow: predicted,
      deviationPct,
      verdict: judgeDeviation(deviationPct),
      operator: '资料室',
      comparedAt: rating.measuredAt,
      createdAt: now,
      updatedAt: now
    }
  })
  await db.compares.bulkPut(rows)
  return rows.length
}

/**
 * 发布（报出）某定线的当前成果：
 * 冻结当时的点据基面快照与比测结论为一个新版本（只追加），
 * 并把该线各点据的 publishedVersionId 指向新版本；
 * 同时归档一份带版本号的比测记录，之后零点再改也不影响这版结论可查。
 */
export async function publishRatingVersion(
  lineNo: string,
  options: { reason: string; publisher: string }
): Promise<RatingVersion> {
  const ratingsAll = await db.ratings.toArray()
  const lineRatings = ratingsAll.filter(
    (rating) => rating.lineNo === lineNo && rating.datumStatus !== 'pending'
  )
  const fit = fitRatingsOnDatum(ratingsAll, lineNo)
  const existing = await db.ratingVersions.where('lineNo').equals(lineNo).toArray()
  const versionNo = existing.reduce((max, item) => Math.max(max, item.versionNo), 0) + 1
  const now = Date.now()
  const publishedAt = new Date(now).toISOString()

  const points = lineRatings.map((rating) => ({
    ratingId: rating.id,
    stationId: rating.stationId,
    gaugeStageM: rating.stageM,
    datumZeroElevM: rating.datumZeroElevM,
    datumStageM: rating.datumStageM as number,
    flowM3s: rating.flowM3s,
    datumSurveyId: rating.datumSurveyId
  }))

  const compares = lineRatings.map((rating) => {
    const datumStage = rating.datumStageM ?? rating.stageM
    const predicted = fit.valid ? curveFlow(fit, datumStage) : rating.flowM3s
    const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
    return {
      ratingId: rating.id,
      measuredFlow: rating.flowM3s,
      curveFlow: predicted,
      deviationPct,
      verdict: judgeDeviation(deviationPct),
      operator: options.publisher,
      comparedAt: rating.measuredAt
    }
  })

  const version: RatingVersion = {
    id: createId('ver'),
    lineNo,
    versionNo,
    reason: options.reason,
    a: fit.a,
    b: fit.b,
    h0: fit.h0,
    sampleCount: fit.sampleCount,
    meanResidualPct: fit.meanResidualPct,
    maxResidualPct: fit.maxResidualPct,
    r2: fit.r2,
    valid: fit.valid,
    message: fit.message,
    points,
    compares,
    publisher: options.publisher,
    publishedAt,
    createdAt: now,
    updatedAt: now
  }

  await db.transaction('rw', [db.ratingVersions, db.ratings, db.compares], async () => {
    await db.ratingVersions.put(version)
    for (const rating of lineRatings) {
      await db.ratings.update(rating.id, { publishedVersionId: version.id, updatedAt: now } as never)
    }
    // 归档当版比测（独立 id，冻结）；工作版比测保留，供零点再改后继续重算
    const archivedRows: Compare[] = compares.map((item) => ({
      id: archivedCompareId(version.id, item.ratingId),
      ratingId: item.ratingId,
      ratingVersionId: version.id,
      datumStageM: points.find((point) => point.ratingId === item.ratingId)?.datumStageM ?? null,
      measuredFlow: item.measuredFlow,
      curveFlow: item.curveFlow,
      deviationPct: item.deviationPct,
      verdict: item.verdict,
      operator: item.operator,
      comparedAt: item.comparedAt,
      createdAt: now,
      updatedAt: now
    }))
    await db.compares.bulkPut(archivedRows)
  })

  return version
}
