/**
 * 领域逻辑冒烟测试（不依赖浏览器）：
 * npx esbuild 临时打包 → node 运行，覆盖基面折算、统一基面定线、重算与发布版本。
 */
import 'fake-indexeddb/auto'
import { assert } from 'node:console'
import { initDatabase, db } from '../src/utils/db'
import { resetDatabase } from '../src/utils/db'
import { recalcRatingsDatum, publishRatingVersion } from '../src/utils/datum'
import { fitRatingsOnDatum } from '../src/types/rating'
import type { Rating } from '../src/types/rating'

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error('✗', msg)
    process.exitCode = 1
  } else {
    console.log('✓', msg)
  }
}

async function main(): Promise<void> {
  await initDatabase()
  const surveys = await db.gaugeSurveys.toArray()
  check(surveys.length === 4, `播种 4 次水尺接测（实得 ${surveys.length}）`)

  const ratings = await db.ratings.toArray()
  const a5 = ratings.find((r) => r.id === 'rat_lh_a5') as Rating
  check(
    a5.datumStageM === 107.03 && a5.datumZeroElevM === 99.85 && a5.datumSurveyId === 'gsv_lh_2',
    `a5 洪水后按新零点折到统一基面 ${a5.datumStageM}（读数 7.18 + 99.85）`
  )
  const a1 = ratings.find((r) => r.id === 'rat_lh_a1') as Rating
  check(a1.datumStageM === 104.01 && a1.datumZeroElevM === 100.0, 'a1 按汛前旧零点折算 104.010')

  // 同一场洪水点据折到同一基面后应连续，a4=106.15 < a5=107.03（旧读数口径 6.15 与 7.18 会把基面差掩盖/错置）
  const a4 = ratings.find((r) => r.id === 'rat_lh_a4') as Rating
  check((a4.datumStageM as number) < (a5.datumStageM as number), 'A 线洪水点据折基面后单调连续')

  // B1 时间早于最早接测 → 待站上认
  const b1 = ratings.find((r) => r.id === 'rat_qj_b1') as Rating
  check(b1.datumStatus === 'pending' && b1.datumStageM === null, 'b1 时间对不上 → 待站上认，不参与定线')

  // 已报出 v1（a1~a4），a5 未定案
  const versions = await db.ratingVersions.toArray()
  check(versions.length === 1 && versions[0].versionNo === 1, `A 线已报出 v1（实得版本数 ${versions.length}）`)
  check(a1.publishedVersionId === 'ver_lh_a_v1' && a5.publishedVersionId === null, 'a1~a4 挂 v1，a5 未定案')

  // 工作版比测 vs 归档比测
  const compares = await db.compares.toArray()
  const work = compares.filter((c) => c.ratingVersionId === null)
  const arch = compares.filter((c) => c.ratingVersionId !== null)
  check(work.length === 12, `工作版比测 12 条（A 全 5 + B 三 + C 四，实得 ${work.length}）`)
  check(arch.length === 4, `v1 归档比测 4 条（a1~a4，实得 ${arch.length}）`)

  // 全量重算（资料室侧重试入口）应幂等且不动接测
  const again = await recalcRatingsDatum()
  check(again.ratingsRecalculated === 13 && again.pendingCount === 1, `重算幂等：13 点，待认 1（实得 ${again.ratingsRecalculated}/${again.pendingCount}）`)
  const surveysAfter = await db.gaugeSurveys.count()
  check(surveysAfter === 4, '重算后站上接测记录数量不变')

  // 发布 A 线新版本：a1~a5 全部挂 v2，v1 归档仍可查
  const v2 = await publishRatingVersion('A', { reason: '洪水后按新零点重算', publisher: '资料室' })
  check(v2.versionNo === 2 && v2.points.length === 5, `报出 A 线 v2 含 5 点（实得 ${v2.points.length}）`)
  const ratingsNow = await db.compares.toArray()
  const v1Still = ratingsNow.filter((c) => c.ratingVersionId === 'ver_lh_a_v1')
  check(v1Still.length === 4, 'v1 报出那版的比测结论冻结留档仍可查')

  // 站上新增一次接测（资料室按站重折）
  const now = Date.now()
  await db.gaugeSurveys.put({
    id: 'gsv_qj_old',
    stationId: 'stn_qj02',
    surveyNo: 0,
    zeroElevM: 50.0,
    surveyedAt: '2023-01-01T00:00:00.000Z',
    surveyor: '何远',
    note: '补登历史零点',
    createdAt: now,
    updatedAt: now
  })
  const res = await recalcRatingsDatum({ stationIds: ['stn_qj02'] })
  const b1after = (await db.ratings.where('id').equals('rat_qj_b1').first()) as Rating
  check(
    b1after.datumStatus === 'resolved' && b1after.datumStageM === 52.84,
    `站上补历史接测后 b1 折到 ${b1after.datumStageM}（实得状态 ${b1after.datumStatus}）`
  )
  check(res.pendingCount === 0, '青矶站重折后无待认点据')

  // 重置后结构干净
  await resetDatabase()
  check((await db.ratings.count()) === 13 && (await db.gaugeSurveys.count()) === 4, '重置演示数据后表数量正确')

  console.log('\n全部领域逻辑检查通过')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
