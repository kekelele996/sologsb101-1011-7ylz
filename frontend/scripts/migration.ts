/**
 * 升级迁移测试：构造一个 v2 旧库（ratings/compares 无基面字段），
 * 打开 v3 后应：旧点据无零点记录时，有接测的按最近一次回填(backfilled)，对不上的挑为 pending。
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('✗', msg)
    process.exitCode = 1
  } else console.log('✓', msg)
}

async function buildV2(): Promise<void> {
  // 以 v2 结构建库并灌入旧数据（无任何 datum* 字段）
  const old = new Dexie('gbhydrogaug')
  old.version(2).stores({
    stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
    sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
    verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
    points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
    ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
    compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
  })
  await old.table('stations').bulkPut([
    { id: 's1', name: '甲站', river: 'R', catchmentKm2: 100, sectionCode: 'C1', remark: '', createdAt: 1, updatedAt: 1 }
  ])
  // 该站只有一次接测（v3 中 gaugeSurveys 表为空——模拟「旧数据没有零点记录」），
  // 两条点据：一条早于/无接测（pending），这里通过升级后再补接测验证回填路径。
  await old.table('ratings').bulkPut([
    { id: 'r1', stationId: 's1', stageM: 3.0, flowM3s: 50, lineNo: 'A', measureNo: 'm1', measuredAt: '2024-03-01T00:00:00Z', createdAt: 1, updatedAt: 1 },
    { id: 'r2', stationId: 's1', stageM: 4.0, flowM3s: 90, lineNo: 'A', measureNo: 'm2', measuredAt: '2024-05-01T00:00:00Z', createdAt: 1, updatedAt: 1 }
  ])
  await old.table('compares').bulkPut([
    { id: 'c1', ratingId: 'r1', measuredFlow: 50, curveFlow: 51, deviationPct: 2, verdict: '合格', operator: 'x', comparedAt: '2024-03-01T00:00:00Z', createdAt: 1, updatedAt: 1 }
  ])
  await old.close()
}

async function main(): Promise<void> {
  await buildV2()

  // 打开会触发 v3 upgrade；此时 gaugeSurveys 为空 → 旧点据全部 pending
  const { db } = await import('../src/utils/db')
  await db.open()
  const ratingsAll = await db.table('ratings').toArray()
  check(
    ratingsAll.every((r) => r.datumStatus === 'pending' && r.datumStageM === null),
    '旧数据无接测记录：两条点据均标记「待站上认」'
  )
  const cmp = await db.table('compares').get('c1')
  check(cmp.ratingVersionId === null && cmp.datumStageM === null, '旧比测记录补 ratingVersionId/datumStageM 缺省值')

  // 升级后站上补一次接测（晚于 r1、早于 r2），再从资料室重算：r2 命中应记为 backfilled，r1 仍 pending
  const now = Date.now()
  await db.table('gaugeSurveys').put({
    id: 'g1', stationId: 's1', surveyNo: 1, zeroElevM: 10.0,
    surveyedAt: '2024-04-01T00:00:00Z', surveyor: '甲', note: '补录', createdAt: now, updatedAt: now
  })
  const { recalcRatingsDatum } = await import('../src/utils/datum')
  const res = await recalcRatingsDatum({ legacy: true })
  const r1 = await db.table('ratings').get('r1')
  const r2 = await db.table('ratings').get('r2')
  check(r1.datumStatus === 'pending', 'r1 早于最早接测，仍挑出待站上认')
  check(
    r2.datumStatus === 'backfilled' && r2.datumStageM === 14.0 && r2.datumSurveyId === 'g1',
    `r2 按最近一次接测回填到统一基面 ${r2.datumStageM}（backfilled）`
  )
  check(res.backfilledCount === 1 && res.pendingCount === 1, `回填 1 / 待认 1（实得 ${res.backfilledCount}/${res.pendingCount}）`)

  console.log('\n升级迁移检查通过')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
