/**
 * 资料室侧重算与定案（持久化编排）。
 * 边界：本模块只写资料室侧的表（ratings 折算字段、ratingLineStates、recalcJobs、
 * compares、ratingVersions）；站上的 gaugeSurveys 只以只读方式参与折算。
 * 因此一次重算失败时，站上水尺接测记录完全不受影响，可从本任务直接重试。
 */
import { db, createId } from '@/utils/db'
import type { Rating } from '@/types/rating'
import { curveFlow, fitPowerCurve } from '@/types/rating'
import { calcDeviationPct, judgeDeviation, type Compare } from '@/types/compare'
import type { GaugeSurvey } from '@/types/gaugeSurvey'
import type { RatingLineState, RatingVersion, RatingVersionPoint } from '@/types/ratingVersion'
import type { RecalcJob } from '@/types/recalc'
import { foldRatings } from '@/utils/datum'

export type RecalcReason = RecalcJob['reason']

const DATUM_TABLES = [db.ratings, db.compares, db.ratingLineStates, db.recalcJobs] as const

/**
 * 登记重算任务。同一条未定案定线已有待执行 / 失败任务时不重复入队；
 * 已定案定线只有在 reopen（新开版本）后才会产生任务。
 */
export async function enqueueRecalc(
  lineNo: string,
  stationId: string,
  reason: RecalcReason
): Promise<RecalcJob> {
  const existing = await db.recalcJobs
    .where('lineNo')
    .equals(lineNo)
    .filter((job) => job.status === 'pending' || job.status === 'failed')
    .first()
  if (existing) {
    await db.recalcJobs.update(existing.id, { reason, updatedAt: Date.now() })
    return { ...existing, reason }
  }
  const now = Date.now()
  const job: RecalcJob = {
    id: createId('job'),
    lineNo,
    stationId,
    reason,
    status: 'pending',
    attempts: 0,
    errorMessage: '',
    forceFailOnce: false,
    createdAt: now,
    updatedAt: now,
    lastTriedAt: null,
    succeededAt: null
  }
  await db.recalcJobs.put(job)
  return job
}

/** 零点改动后，把受影响测站的「未定案」定线全部挂上重算任务（资料室侧发起） */
export async function enqueueAffectedLines(survey: GaugeSurvey, reason: RecalcReason): Promise<string[]> {
  const lineRows = await db.ratings.where('stationId').equals(survey.stationId).toArray()
  const lineNos = Array.from(new Set(lineRows.map((rating) => rating.lineNo)))
  if (lineNos.length === 0) return []
  const states = await db.ratingLineStates.where('lineNo').anyOf(lineNos).toArray()
  const draftLines = lineNos.filter((lineNo) => {
    const state = states.find((item) => item.lineNo === lineNo)
    return !state || state.status !== 'finalized'
  })
  for (const lineNo of draftLines) {
    await db.ratingLineStates.put({
      id: states.find((item) => item.lineNo === lineNo)?.id ?? createId('rls'),
      lineNo,
      stationId: survey.stationId,
      status: 'draft',
      lastSurveyAt: survey.surveyedAt,
      needsRecalc: true,
      lastRecalcAt: states.find((item) => item.lineNo === lineNo)?.lastRecalcAt ?? null,
      createdAt: states.find((item) => item.lineNo === lineNo)?.createdAt ?? Date.now(),
      updatedAt: Date.now()
    })
    await enqueueRecalc(lineNo, survey.stationId, reason)
  }
  return draftLines
}

interface RecalcOutcome {
  job: RecalcJob
  /** 参与本次定线（已折基面）的点数 */
  foldedCount: number
  /** 时间对不上、挑出交站上确认的点数 */
  unmatchedCount: number
}

/**
 * 执行单个重算任务：按测流当时零点重折基面 → 未定案线重新定线 → 比测偏差与判定重算。
 * 失败只落在任务记录上（attempts / errorMessage / forceFailOnce 复位），
 * 事务不触碰 gaugeSurveys，站上档案不受影响；随后可重试。
 */
export async function runRecalcJob(jobId: string): Promise<RecalcOutcome> {
  const job = await db.recalcJobs.get(jobId)
  if (!job) throw new Error('重算任务不存在')

  await db.recalcJobs.update(jobId, { status: 'running', lastTriedAt: Date.now(), updatedAt: Date.now() })

  try {
    let foldedCount = 0
    let unmatchedCount = 0
    // 站上接测记录只在事务外只读一次；事务表清单不含 gaugeSurveys，
    // 从机制上保证重算无论成败都不可能改动站上的接测档案。
    const surveys = await db.gaugeSurveys.toArray()
    const members = await db.ratings.where('lineNo').equals(job.lineNo).toArray()
    const folded = foldRatings(members, surveys)
    const foldedMap = new Map(folded.map((item) => [item.ratingId, item]))

    await db.transaction('rw', [...DATUM_TABLES], async () => {
      // 演练「重算失败」：强制抛错，验证可从资料室重试且站上接测不受影响
      const current = await db.recalcJobs.get(jobId)
      if (current?.forceFailOnce) {
        throw new Error('演练失败：资料室重算中断（站上接测记录未受影响，可直接重试）')
      }

      const now = Date.now()
      const compareRows: Compare[] = []
      for (const rating of members) {
        const result = foldedMap.get(rating.id)
        if (result && !result.unmatched) {
          await db.ratings.update(rating.id, {
            datumStageM: result.datumStageM,
            zeroSurveyId: result.surveyId,
            datumStatus: 'folded',
            updatedAt: now
          })
        } else {
          await db.ratings.update(rating.id, {
            datumStageM: null,
            zeroSurveyId: null,
            datumStatus: 'unmatched',
            updatedAt: now
          })
        }
      }

      const foldedRatings = members
        .map((rating) => ({ rating, result: foldedMap.get(rating.id) }))
        .filter(
          (entry): entry is { rating: Rating; result: NonNullable<(typeof folded)[number]> } =>
            !!entry.result && !entry.result.unmatched
        )
      foldedCount = foldedRatings.length
      unmatchedCount = members.length - foldedCount

      // 按统一基面水位重新定线
      const fit = fitPowerCurve(
        foldedRatings.map(({ rating, result }) => ({ stageM: result.datumStageM ?? rating.stageM, flowM3s: rating.flowM3s })),
        job.lineNo
      )

      // 比测偏差与判定跟着重算；对不上时间的点据不比测（保留旧记录会误导，先撤掉）
      for (const { rating, result } of foldedRatings) {
        const datumStage = result.datumStageM ?? rating.stageM
        const predicted = fit.valid ? curveFlow(fit, datumStage) : rating.flowM3s
        const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
        const existing = await db.compares.where('ratingId').equals(rating.id).first()
        compareRows.push({
          id: existing?.id ?? createId('cmp'),
          ratingId: rating.id,
          measuredFlow: rating.flowM3s,
          curveFlow: predicted,
          deviationPct,
          verdict: judgeDeviation(deviationPct),
          operator: existing?.operator ?? '林昭',
          comparedAt: existing?.comparedAt ?? rating.measuredAt,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        })
      }
      const unmatchedIds = members
        .filter((rating) => foldedMap.get(rating.id)?.unmatched)
        .map((rating) => rating.id)
      if (unmatchedIds.length > 0) {
        await db.compares.where('ratingId').anyOf(unmatchedIds).delete()
      }
      if (compareRows.length > 0) await db.compares.bulkPut(compareRows)

      const state = await db.ratingLineStates.where('lineNo').equals(job.lineNo).first()
      const stateRow: RatingLineState = {
        id: state?.id ?? createId('rls'),
        lineNo: job.lineNo,
        stationId: job.stationId,
        status: 'draft',
        lastSurveyAt: state?.lastSurveyAt ?? null,
        needsRecalc: false,
        lastRecalcAt: now,
        createdAt: state?.createdAt ?? now,
        updatedAt: now
      }
      await db.ratingLineStates.put(stateRow)

      await db.recalcJobs.update(jobId, {
        status: 'succeeded',
        attempts: job.attempts + 1,
        errorMessage: '',
        forceFailOnce: false,
        succeededAt: now,
        updatedAt: now
      })
    })

    const finalJob = (await db.recalcJobs.get(jobId)) as RecalcJob
    return { job: finalJob, foldedCount, unmatchedCount }
  } catch (error) {
    const message = error instanceof Error ? error.message : '资料室重算发生未知错误'
    const now = Date.now()
    await db.recalcJobs.update(jobId, {
      status: 'failed',
      attempts: job.attempts + 1,
      errorMessage: message,
      forceFailOnce: false,
      updatedAt: now
    })
    const failedJob = (await db.recalcJobs.get(jobId)) as RecalcJob
    return { job: failedJob, foldedCount: 0, unmatchedCount: 0 }
  }
}

/** 自动执行全部待处理任务；失败任务不自动重跑，须由资料室显式重试 */
export async function runPendingJobs(): Promise<RecalcOutcome[]> {
  const pending = await db.recalcJobs.where('status').equals('pending').sortBy('createdAt')
  const outcomes: RecalcOutcome[] = []
  for (const job of pending) {
    outcomes.push(await runRecalcJob(job.id))
  }
  return outcomes
}

/**
 * 站上确认某条对不上时间的点据：指定其应当采用的接测零点，折出基面并归入定线。
 * 确认动作只在资料室侧落折账结果并挂该线重算；站上接测记录仍由站上维护，不在这里改写。
 */
export async function confirmDatumForRating(
  rating: Rating,
  survey: GaugeSurvey
): Promise<void> {
  const now = Date.now()
  await db.transaction('rw', [db.ratings, db.ratingLineStates, db.recalcJobs], async () => {
    await db.ratings.update(rating.id, {
      datumStageM: Number((rating.stageM + survey.zeroElevationM).toFixed(3)),
      zeroSurveyId: survey.id,
      datumStatus: 'folded',
      updatedAt: now
    })
    const state = await db.ratingLineStates.where('lineNo').equals(rating.lineNo).first()
    if (!state || state.status !== 'finalized') {
      await enqueueRecalc(rating.lineNo, rating.stationId, '站上确认零点')
    }
  })
}

/** 定案报出：冻结当前折算点据下的定线参数与比测结论为只读版本，定线标记已定案 */
export async function publishLineVersion(
  lineNo: string,
  note: string,
  operator: string
): Promise<RatingVersion> {
  const now = Date.now()
  return db.transaction('rw', [db.ratings, db.compares, db.ratingLineStates, db.ratingVersions], async () => {
    const members = (await db.ratings.where('lineNo').equals(lineNo).toArray()).filter(
      (rating) => rating.datumStatus === 'folded' && rating.datumStageM !== null
    )
    if (members.length < 3) {
      throw new Error('已折基面的点据少于 3 个，无法定线报出')
    }
    const fit = fitPowerCurve(
      members.map((rating) => ({ stageM: rating.datumStageM ?? rating.stageM, flowM3s: rating.flowM3s })),
      lineNo
    )
    if (!fit.valid) throw new Error(fit.message || '当前点据不足以定线')

    const existingVersions = await db.ratingVersions.where('lineNo').equals(lineNo).toArray()
    const seq = existingVersions.length + 1
    const points: RatingVersionPoint[] = members.map((rating) => {
      const datumStage = rating.datumStageM ?? rating.stageM
      const predicted = curveFlow(fit, datumStage)
      const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
      return {
        ratingId: rating.id,
        stationId: rating.stationId,
        measureNo: rating.measureNo,
        measuredAt: rating.measuredAt,
        surveyId: rating.zeroSurveyId,
        stageM: rating.stageM,
        datumStageM: datumStage,
        flowM3s: rating.flowM3s,
        curveFlowM3s: predicted,
        deviationPct,
        verdict: judgeDeviation(deviationPct)
      }
    })
    const overLimitCount = points.filter((point) => point.verdict === '超限').length
    const version: RatingVersion = {
      id: createId('ver'),
      lineNo,
      stationId: members[0].stationId,
      versionNo: `${lineNo}-V${seq}`,
      fit,
      points,
      compareCount: points.length,
      overLimitCount,
      qualifyRatePct: Number((((points.length - overLimitCount) / points.length) * 100).toFixed(1)),
      note,
      operator,
      publishedAt: new Date(now).toISOString(),
      createdAt: now
    }
    await db.ratingVersions.put(version)

    const state = await db.ratingLineStates.where('lineNo').equals(lineNo).first()
    await db.ratingLineStates.put({
      id: state?.id ?? createId('rls'),
      lineNo,
      stationId: members[0].stationId,
      status: 'finalized',
      lastSurveyAt: state?.lastSurveyAt ?? null,
      needsRecalc: false,
      lastRecalcAt: state?.lastRecalcAt ?? now,
      createdAt: state?.createdAt ?? now,
      updatedAt: now
    })
    return version
  })
}

/** 已定案线新开版本：定线退回未定案并挂重算，历史报出版本原样保留可查 */
export async function reopenLine(lineNo: string, stationId: string): Promise<void> {
  const now = Date.now()
  await db.transaction('rw', [db.ratingLineStates, db.recalcJobs], async () => {
    const state = await db.ratingLineStates.where('lineNo').equals(lineNo).first()
    await db.ratingLineStates.put({
      id: state?.id ?? createId('rls'),
      lineNo,
      stationId,
      status: 'draft',
      lastSurveyAt: state?.lastSurveyAt ?? null,
      needsRecalc: true,
      lastRecalcAt: state?.lastRecalcAt ?? null,
      createdAt: state?.createdAt ?? now,
      updatedAt: now
    })
    await enqueueRecalc(lineNo, stationId, '新开版本')
  })
}
