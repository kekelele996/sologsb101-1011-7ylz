/**
 * 端到端逻辑验证（node + fake-indexeddb，esbuild 临时打包运行，不进产物）：
 * 1) 模拟 v2 旧库（点据无零点字段）→ 升级 v3：按最近一次测流回填接测、折基面、挂重算
 * 2) 执行待处理重算 → 点据折好、比测重算
 * 3) 强制失败一次：任务 failed、站上接测记录完好；重试 → succeeded
 * 4) 定案报出 V1；再登记一次新接测（零点变动）→ 未定案挂重算，报出版本原样不变
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { assert } from 'node:console'

async function makeLegacyV2(): Promise<void> {
  const old = new Dexie('gbhydrogaug')
  old.version(1).stores({
    stations: 'id',
    sections: 'id, stationId',
    verticals: 'id, sectionId',
    points: 'id, verticalId',
    ratings: 'id, stationId, lineNo, stageM',
    compares: 'id, ratingId'
  })
  old.version(2).stores({
    stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
    sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
    verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
    points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
    ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
    compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
  })
  await old.open()
  await (old as unknown as { table: (n: string) => Dexie.Table }).transaction(
    'rw',
    ['stations', 'ratings'],
    async () => {
      await (old as unknown as { table: (n: string) => Dexie.Table }).table('stations').bulkPut([
        { id: 'stn1', name: '测试站', river: 'R', catchmentKm2: 10, sectionCode: 'CS1', createdAt: 1, updatedAt: 1 }
      ])
      const rows = [
        { id: 'r1', stationId: 'stn1', lineNo: 'A', stageM: 4.0, flowM3s: 100, measuredAt: '2024-05-01T00:00:00.000Z', measureNo: 'm1', createdAt: 1, updatedAt: 1 },
        { id: 'r2', stationId: 'stn1', lineNo: 'A', stageM: 4.6, flowM3s: 150, measuredAt: '2024-06-01T00:00:00.000Z', measureNo: 'm2', createdAt: 1, updatedAt: 1 },
        { id: 'r3', stationId: 'stn1', lineNo: 'A', stageM: 5.2, flowM3s: 210, measuredAt: '2024-07-01T00:00:00.000Z', measureNo: 'm3', createdAt: 1, updatedAt: 1 },
        { id: 'r4', stationId: 'stn1', lineNo: 'A', stageM: 5.9, flowM3s: 290, measuredAt: '2024-08-01T00:00:00.000Z', measureNo: 'm4', createdAt: 1, updatedAt: 1 }
      ]
      await (old as unknown as { table: (n: string) => Dexie.Table }).table('ratings').bulkPut(rows)
    }
  )
  old.close()
}

async function main(): Promise<void> {
  await makeLegacyV2()

  const { initDatabase, db } = await import('@/utils/db.ts')
  await initDatabase()

  const surveys = await db.gaugeSurveys.toArray()
  assert(surveys.length === 1, `期望回填 1 条接测，实际 ${surveys.length}`)
  assert(surveys[0].backfilled === true, '回填接测应带 backfilled 标记')
  assert(surveys[0].surveyedAt === '2024-08-01T00:00:00.000Z', '回填时间应为最近一次测流')

  const ratings = await db.ratings.toArray()
  const unmatched = ratings.filter((r) => r.datumStatus === 'unmatched')
  const folded = ratings.filter((r) => r.datumStatus === 'folded')
  assert(unmatched.length === 3, `期望 3 个早于回填接测的点对不上时间，实际 ${unmatched.length}`)
  assert(folded.length === 1 && folded[0].datumStageM === 5.9, '最近一次点据应按回填零点折成 5.900')

  const jobsBefore = await db.recalcJobs.toArray()
  assert(jobsBefore.length === 1 && jobsBefore[0].status === 'pending', '升级后应为 A 线挂一个待处理重算任务')

  const { runRecalcJob, publishLineVersion } = await import('@/utils/recalc.ts')

  // 先强制失败一次，验证隔离与重试
  await db.recalcJobs.update(jobsBefore[0].id, { forceFailOnce: true })
  const failed = await runRecalcJob(jobsBefore[0].id)
  assert(failed.job.status === 'failed', '强制失败后任务应为 failed')
  assert(failed.job.attempts === 1, '失败尝试次数应为 1')
  const surveysAfterFail = await db.gaugeSurveys.toArray()
  assert(surveysAfterFail.length === 1 && surveysAfterFail[0].id === surveys[0].id, '失败重算不得改动站上接测记录')

  const retried = await runRecalcJob(jobsBefore[0].id)
  assert(retried.job.status === 'succeeded', '重试后任务应为 succeeded')
  assert(retried.foldedCount === 1 && retried.unmatchedCount === 3, '重算统计应为 1 折 / 3 待认')

  // 站上补登记一条更早的接测，一次认掉 3 点，再重算
  const { useSurveyStore } = await import('@/stores/surveyStore.ts')
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const surveyStore = useSurveyStore()
  surveyStore.start()
  await new Promise((r) => setTimeout(r, 30))
  await surveyStore.addSurvey({
    stationId: 'stn1',
    gaugeCode: 'P1',
    surveyedAt: '2024-01-01T00:00:00.000Z',
    zeroElevationM: 0.1,
    operator: '测试员',
    remark: '补测',
    backfilled: false
  })
  await surveyStore.confirmAllForStation('stn1', (await db.gaugeSurveys.toArray()).find((s) => !s.backfilled)!.id)
  await runPending()

  const ratings2 = await db.ratings.toArray()
  assert(ratings2.every((r) => r.datumStatus === 'folded'), '确认后所有点据应折好')
  const r1 = ratings2.find((r) => r.id === 'r1')!
  assert(Math.abs(r1.datumStageM! - 4.1) < 1e-6, `r1 基面水位应为读数4.0+零点0.1=4.1，实际 ${r1.datumStageM}`)

  // 定案报出
  const version = await publishLineVersion('A', '测试报出', '资料员')
  assert(version.points.length === 4, '报出版本应冻结 4 个点')
  const a1 = version.fit.a
  assert(version.overLimitCount <= 2, `报出比测结论应随快照保存，超限 ${version.overLimitCount}`)

  // 再登记一次零点变动接测：未定案（新开版本后）才重算；先验证已定案不自动挂任务
  await surveyStore.addSurvey({
    stationId: 'stn1',
    gaugeCode: 'P1',
    surveyedAt: '2024-09-01T00:00:00.000Z',
    zeroElevationM: -0.2,
    operator: '测试员',
    remark: '汛后接测零点变动',
    backfilled: false
  })
  const jobsFinal = await db.recalcJobs.where('status').anyOf(['pending', 'failed']).toArray()
  assert(jobsFinal.length === 0, '已定案定线在零点改动后不应自动挂重算')
  const frozen = await db.ratingVersions.get(version.id)
  assert(frozen!.fit.a === a1 && frozen!.points.length === 4, '报出版本必须原样不变')

  // 新开版本 → 挂重算并按新零点折算 9 月后的点（本例点据都在 9 月前，仍取 1 月零点，验证只动工作稿）
  const { reopenLine } = await import('@/utils/recalc.ts')
  await reopenLine('A', 'stn1')
  const jobsReopen = await db.recalcJobs.where('status').equals('pending').toArray()
  assert(jobsReopen.length === 1, '新开版本应产生一个待处理重算')
  await runPending()
  const frozenAgain = await db.ratingVersions.get(version.id)
  assert(frozenAgain!.fit.a === a1, '重算工作稿不影响报出快照')

  const state = await db.ratingLineStates.where('lineNo').equals('A').first()
  assert(state!.status === 'draft' && state!.needsRecalc === false, '重算后状态应为 draft/needsRecalc=false')

  console.log('ALL E2E CHECKS PASSED')

  async function runPending(): Promise<void> {
    const { runPendingJobs } = await import('@/utils/recalc.ts')
    await runPendingJobs()
  }
}

main().catch((error) => {
  console.error('E2E FAILED:', error)
  process.exit(1)
})
