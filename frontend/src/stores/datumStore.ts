/**
 * 资料室侧 store：统一基面折算后的定线台账、重算任务、报出版本。
 * 重算 / 重试 / 定案全部走 utils/recalc.ts（事务只写资料室侧表），
 * 与站上的水尺接测记录分账：重算失败从这里重试，站上记录不受影响。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, watchTable } from '@/utils/db'
import type { Rating } from '@/types/rating'
import { fitPowerCurve } from '@/types/rating'
import type { RatingLineState, RatingVersion } from '@/types/ratingVersion'
import type { RecalcJob } from '@/types/recalc'
import type { Station } from '@/types/station'
import {
  enqueueRecalc,
  publishLineVersion,
  reopenLine,
  runPendingJobs,
  runRecalcJob
} from '@/utils/recalc'

export interface DatumLineRow {
  lineNo: string
  stationId: string
  state: RatingLineState | null
  /** 当前已折基面水位（重算后的工作稿） */
  fit: ReturnType<typeof fitPowerCurve>
  foldedCount: number
  unmatchedCount: number
  latestVersion: RatingVersion | null
  versionCount: number
}

export const useDatumStore = defineStore('datum', () => {
  const lineStates = ref<RatingLineState[]>([])
  const versions = ref<RatingVersion[]>([])
  const jobs = ref<RecalcJob[]>([])
  const ratings = ref<Rating[]>([])
  const stations = ref<Station[]>([])
  const ready = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<RatingLineState>(() => db.ratingLineStates).subscribe((rows) => {
      lineStates.value = rows
      ready.value = true
    })
    watchTable<RatingVersion>(() => db.ratingVersions).subscribe((rows) => {
      versions.value = rows
    })
    watchTable<RecalcJob>(() => db.recalcJobs).subscribe((rows) => {
      jobs.value = rows
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

  const pendingJobs = computed<RecalcJob[]>(() =>
    jobs.value
      .filter((job) => job.status === 'pending' || job.status === 'running')
      .sort((a, b) => a.createdAt - b.createdAt)
  )
  const failedJobs = computed<RecalcJob[]>(() =>
    jobs.value.filter((job) => job.status === 'failed').sort((a, b) => b.updatedAt - a.updatedAt)
  )

  /** 定线台账：一条定线一行（含工作稿拟合、定案状态、版本数） */
  const lineRows = computed<DatumLineRow[]>(() => {
    const lineNos = Array.from(new Set(ratings.value.map((rating) => rating.lineNo))).sort((a, b) =>
      a.localeCompare(b)
    )
    return lineNos.map((lineNo) => {
      const members = ratings.value.filter((rating) => rating.lineNo === lineNo)
      const folded = members.filter((rating) => rating.datumStatus === 'folded' && rating.datumStageM !== null)
      const lineVersions = versions.value
        .filter((version) => version.lineNo === lineNo)
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
      return {
        lineNo,
        stationId: members[0]?.stationId ?? '',
        state: lineStates.value.find((state) => state.lineNo === lineNo) ?? null,
        fit: fitPowerCurve(
          folded.map((rating) => ({ stageM: rating.datumStageM ?? rating.stageM, flowM3s: rating.flowM3s })),
          lineNo
        ),
        foldedCount: folded.length,
        unmatchedCount: members.length - folded.length,
        latestVersion: lineVersions[0] ?? null,
        versionCount: lineVersions.length
      }
    })
  })

  function versionsOfLine(lineNo: string): RatingVersion[] {
    return versions.value
      .filter((version) => version.lineNo === lineNo)
      .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  }

  function stateOfLine(lineNo: string): RatingLineState | null {
    return lineStates.value.find((state) => state.lineNo === lineNo) ?? null
  }

  /** 自动执行待处理任务；失败任务不自动重跑，须由资料室显式重试。并发调用合并为一次 */
  let pendingRunning: Promise<void> | null = null
  async function runPending(): Promise<void> {
    if (pendingRunning) return pendingRunning
    pendingRunning = runPendingJobs().then(() => undefined)
    try {
      await pendingRunning
    } finally {
      pendingRunning = null
    }
  }

  async function retryJob(jobId: string): Promise<void> {
    await runRecalcJob(jobId)
  }

  async function recalcLine(lineNo: string, stationId: string): Promise<void> {
    await enqueueRecalc(lineNo, stationId, '手动重算')
    const job = await db.recalcJobs
      .where('lineNo')
      .equals(lineNo)
      .filter((item) => item.status === 'pending')
      .first()
    if (job) await runRecalcJob(job.id)
  }

  async function publish(lineNo: string, note: string, operator: string): Promise<RatingVersion> {
    return publishLineVersion(lineNo, note, operator)
  }

  async function reopen(lineNo: string, stationId: string): Promise<void> {
    await reopenLine(lineNo, stationId)
  }

  /** 演练用：为某线登记一个下次重算强制失败的任务，验证「资料室重试、站上记录不受影响」 */
  async function armFailure(lineNo: string, stationId: string): Promise<void> {
    await enqueueRecalc(lineNo, stationId, '手动重算')
    const job = await db.recalcJobs
      .where('lineNo')
      .equals(lineNo)
      .filter((item) => item.status === 'pending' || item.status === 'failed')
      .first()
    if (job) await db.recalcJobs.update(job.id, { forceFailOnce: true, status: 'pending', updatedAt: Date.now() })
  }

  return {
    lineStates,
    versions,
    jobs,
    ratings,
    stations,
    ready,
    pendingJobs,
    failedJobs,
    lineRows,
    start,
    stationNameOf,
    versionsOfLine,
    stateOfLine,
    runPending,
    retryJob,
    recalcLine,
    publish,
    reopen,
    armFailure
  }
})
