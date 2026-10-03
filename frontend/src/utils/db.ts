/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbhydrogaug，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（测站 → 断面 → 垂线 → 测点 → 点据 → 比测）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Rating } from '@/types/rating'
import type { Compare } from '@/types/compare'
import type { GaugeSurvey } from '@/types/gaugeSurvey'
import type { RatingLineState, RatingVersion } from '@/types/ratingVersion'
import type { RecalcJob } from '@/types/recalc'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'
import { fitPowerCurve } from '@/types/rating'
import { calcMeanVelocity, DEFAULT_WEIGHTS, round } from '@/utils/flow'
import { foldRatings, planLegacyBackfill } from '@/utils/datum'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbhydrogaug'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbhydrogaug:db-version',
  lastBackupAt: 'gbhydrogaug:last-backup-at',
  lastStationId: 'gbhydrogaug:last-station-id'
} as const

/** 备份文件结构，供 utils/export.ts 与导出页使用 */
export interface BackupPayload {
  app: 'gbhydrogaug'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  ratings: Rating[]
  compares: Compare[]
  /** 站上侧：水尺接测记录（只追加） */
  gaugeSurveys: GaugeSurvey[]
  /** 资料室侧：定线状态 / 报出版本 / 基面重算任务 */
  ratingLineStates: RatingLineState[]
  ratingVersions: RatingVersion[]
  recalcJobs: RecalcJob[]
}

class HydroGaugeDatabase extends Dexie {
  stations!: Table<Station, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  ratings!: Table<Rating, string>
  compares!: Table<Compare, string>
  gaugeSurveys!: Table<GaugeSurvey, string>
  ratingLineStates!: Table<RatingLineState, string>
  ratingVersions!: Table<RatingVersion, string>
  recalcJobs!: Table<RecalcJob, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      stations: 'id, name, river, sectionCode',
      sections: 'id, stationId, measureNo, method',
      verticals: 'id, sectionId, no',
      points: 'id, verticalId, relativeDepth',
      ratings: 'id, stationId, lineNo, stageM',
      compares: 'id, ratingId, verdict'
    })

    // v2：补齐筛选与统计需要的索引（河名/集水面积、水位、测法、偏差判定）
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
        compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与判定结论，避免列表排序与筛选拿到 undefined
        const stamps: Array<[string, () => Record<string, unknown>]> = [
          ['stations', () => ({})],
          ['sections', () => ({ measuredAt: new Date().toISOString() })],
          ['verticals', () => ({ pointCount: 0, bedNote: '' })],
          ['points', () => ({ weight: DEFAULT_WEIGHTS[1], durationS: 100 })],
          ['ratings', () => ({ measureNo: '', lineNo: 'A' })],
          ['compares', () => ({ operator: '', comparedAt: new Date().toISOString() })]
        ]
        for (const [tableName, defaults] of stamps) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, defaults())
            })
        }
      })

    // v3：水尺接测记录（站上）与统一基面折算定线（资料室）分账
    this.version(DB_VERSION)
      .stores({
        ratings: 'id, stationId, lineNo, stageM, datumStageM, flowM3s, datumStatus, measuredAt, updatedAt',
        gaugeSurveys: 'id, stationId, gaugeCode, surveyedAt, backfilled',
        ratingLineStates: 'id, lineNo, stationId, status, needsRecalc',
        ratingVersions: 'id, lineNo, stationId, versionNo, publishedAt',
        recalcJobs: 'id, lineNo, stationId, status, createdAt'
      })
      .upgrade(async (tx) => {
        // 旧数据没有零点记录：按「本站最近一次测流」回填一条接测（零点暂取 0，标记回填）；
        // 早于回填接测时间的点据仍对不上时间，折算不出基面，挑出来交站上确认。
        const oldRatings = await tx.table<Rating, string>('ratings').toArray()
        const existingSurveys = await tx.table<GaugeSurvey, string>('gaugeSurveys').toArray()
        const now = Date.now()
        const backfilled = planLegacyBackfill(oldRatings, existingSurveys, (prefix) => createId(prefix), now)
        if (backfilled.length > 0) {
          await tx.table<GaugeSurvey, string>('gaugeSurveys').bulkPut(backfilled)
        }
        const allSurveys = [...existingSurveys, ...backfilled]

        // 关系点据按测流当时零点折到统一基面；对不上时间的挑出来
        const folded = foldRatings(oldRatings, allSurveys)
        const foldMap = new Map(folded.map((item) => [item.ratingId, item]))
        await tx
          .table<Rating, string>('ratings')
          .toCollection()
          .modify((row: Rating) => {
            const result = foldMap.get(row.id)
            if (result && !result.unmatched) {
              row.datumStageM = result.datumStageM
              row.zeroSurveyId = result.surveyId
              row.datumStatus = 'folded'
            } else {
              row.datumStageM = null
              row.zeroSurveyId = null
              row.datumStatus = 'unmatched'
            }
            row.updatedAt = now
          })

        // 旧有定线一律视为未定案：挂上重算任务，由资料室在资料侧重算/重试
        const lineTable = tx.table<RatingLineState, string>('ratingLineStates')
        const jobTable = tx.table<RecalcJob, string>('recalcJobs')
        const lineNos = Array.from(new Set(oldRatings.map((rating) => rating.lineNo)))
        const states: RatingLineState[] = []
        const jobs: RecalcJob[] = []
        lineNos.forEach((lineNo, index) => {
          const stationId = oldRatings.find((rating) => rating.lineNo === lineNo)?.stationId ?? ''
          states.push({
            id: createId('rls'),
            lineNo,
            stationId,
            status: 'draft',
            lastSurveyAt: null,
            needsRecalc: true,
            lastRecalcAt: null,
            createdAt: now,
            updatedAt: now
          })
          jobs.push({
            id: createId('job'),
            lineNo,
            stationId,
            reason: '手动重算',
            status: 'pending',
            attempts: 0,
            errorMessage: '',
            forceFailOnce: false,
            createdAt: now + index,
            updatedAt: now + index,
            lastTriedAt: null,
            succeededAt: null
          })
        })
        if (states.length > 0) await lineTable.bulkPut(states)
        if (jobs.length > 0) await jobTable.bulkPut(jobs)
      })
  }
}

export const db = new HydroGaugeDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedStationBundle {
  station: Omit<Station, 'createdAt' | 'updatedAt'>
  sections: Array<Omit<Section, 'createdAt' | 'updatedAt'>>
  verticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>>
  points: Array<Omit<Point, 'createdAt' | 'updatedAt'>>
}

/**
 * 播种演示数据：3 个测站 → 4 个断面测次 → 8 条垂线 → 16 个流速测点，
 * 并据此生成水位流量关系点据与比测记录，保证父 → 子 → 孙三层链路可点开。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const iso = new Date(now).toISOString()

  const stationBundles: SeedStationBundle[] = [
    {
      station: {
        id: 'stn_lh01',
        name: '龙门水文站',
        river: '澜沧江',
        catchmentKm2: 45200,
        sectionCode: 'CS-LM-01',
        remark: '基本水文站，缆道测流，断面稳定'
      },
      sections: [
        {
          id: 'sec_lh_2406',
          stationId: 'stn_lh01',
          measureNo: '2024-06-001',
          startDistanceM: 12.5,
          stageM: 5.42,
          method: '流速仪',
          measuredAt: '2024-06-12T08:30:00.000Z'
        },
        {
          id: 'sec_lh_2407',
          stationId: 'stn_lh01',
          measureNo: '2024-07-002',
          startDistanceM: 12.5,
          stageM: 6.15,
          method: 'ADCP',
          measuredAt: '2024-07-18T09:10:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_lh_1', sectionId: 'sec_lh_2406', no: 1, startDistanceM: 6.5, depthM: 1.4, pointCount: 2, bedNote: '左岸浅滩，砾石河床' },
        { id: 'vrt_lh_2', sectionId: 'sec_lh_2406', no: 2, startDistanceM: 14.0, depthM: 3.2, pointCount: 3, bedNote: '主流，砂卵石' },
        { id: 'vrt_lh_3', sectionId: 'sec_lh_2406', no: 3, startDistanceM: 22.0, depthM: 2.1, pointCount: 2, bedNote: '右岸缓流，细砂' },
        { id: 'vrt_lh_4', sectionId: 'sec_lh_2407', no: 1, startDistanceM: 8.0, depthM: 3.8, pointCount: 3, bedNote: 'ADCP 走航断面，主槽' }
      ],
      points: [
        { id: 'pnt_lh_11', verticalId: 'vrt_lh_1', relativeDepth: 0.2, velocityMs: 0.62, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_12', verticalId: 'vrt_lh_1', relativeDepth: 0.8, velocityMs: 0.48, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_21', verticalId: 'vrt_lh_2', relativeDepth: 0.2, velocityMs: 1.42, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_22', verticalId: 'vrt_lh_2', relativeDepth: 0.6, velocityMs: 1.18, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_23', verticalId: 'vrt_lh_2', relativeDepth: 0.8, velocityMs: 0.96, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_31', verticalId: 'vrt_lh_3', relativeDepth: 0.2, velocityMs: 0.82, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_32', verticalId: 'vrt_lh_3', relativeDepth: 0.8, velocityMs: 0.64, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_41', verticalId: 'vrt_lh_4', relativeDepth: 0.2, velocityMs: 1.86, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_42', verticalId: 'vrt_lh_4', relativeDepth: 0.6, velocityMs: 1.64, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_43', verticalId: 'vrt_lh_4', relativeDepth: 0.8, velocityMs: 1.32, weight: 1 / 3, durationS: 120 }
      ]
    },
    {
      station: {
        id: 'stn_qj02',
        name: '青矶水位站',
        river: '沅江',
        catchmentKm2: 1860,
        sectionCode: 'CS-QJ-02',
        remark: '小河站，浮标法为主，洪水期加测'
      },
      sections: [
        {
          id: 'sec_qj_2405',
          stationId: 'stn_qj02',
          measureNo: '2024-05-003',
          startDistanceM: 4.2,
          stageM: 3.18,
          method: '浮标',
          measuredAt: '2024-05-22T07:50:00.000Z'
        },
        {
          id: 'sec_qj_2408',
          stationId: 'stn_qj02',
          measureNo: '2024-08-004',
          startDistanceM: 4.2,
          stageM: 4.36,
          method: '流速仪',
          measuredAt: '2024-08-09T06:40:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_qj_1', sectionId: 'sec_qj_2405', no: 1, startDistanceM: 2.4, depthM: 1.1, pointCount: 2, bedNote: '浮标上断面' },
        { id: 'vrt_qj_2', sectionId: 'sec_qj_2405', no: 2, startDistanceM: 6.8, depthM: 1.9, pointCount: 2, bedNote: '浮标中泓' },
        { id: 'vrt_qj_3', sectionId: 'sec_qj_2408', no: 1, startDistanceM: 3.1, depthM: 1.6, pointCount: 3, bedNote: '涨水期，流速仪三点法' },
        { id: 'vrt_qj_4', sectionId: 'sec_qj_2408', no: 2, startDistanceM: 7.6, depthM: 2.4, pointCount: 3, bedNote: '主槽，卵石夹砂' }
      ],
      points: [
        { id: 'pnt_qj_11', verticalId: 'vrt_qj_1', relativeDepth: 0.2, velocityMs: 0.54, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_12', verticalId: 'vrt_qj_1', relativeDepth: 0.8, velocityMs: 0.42, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_21', verticalId: 'vrt_qj_2', relativeDepth: 0.2, velocityMs: 0.88, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_22', verticalId: 'vrt_qj_2', relativeDepth: 0.8, velocityMs: 0.7, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_31', verticalId: 'vrt_qj_3', relativeDepth: 0.2, velocityMs: 1.06, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_32', verticalId: 'vrt_qj_3', relativeDepth: 0.6, velocityMs: 0.92, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_33', verticalId: 'vrt_qj_3', relativeDepth: 0.8, velocityMs: 0.78, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_41', verticalId: 'vrt_qj_4', relativeDepth: 0.2, velocityMs: 1.34, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_42', verticalId: 'vrt_qj_4', relativeDepth: 0.6, velocityMs: 1.2, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_43', verticalId: 'vrt_qj_4', relativeDepth: 0.8, velocityMs: 1.04, weight: 1 / 3, durationS: 100 }
      ]
    },
    {
      station: {
        id: 'stn_bs03',
        name: '白沙滩巡测站',
        river: '澜沧江',
        catchmentKm2: 51200,
        sectionCode: 'CS-BS-03',
        remark: '巡测断面，与龙门站比测'
      },
      sections: [
        {
          id: 'sec_bs_2406',
          stationId: 'stn_bs03',
          measureNo: '2024-06-005',
          startDistanceM: 18.0,
          stageM: 5.36,
          method: 'ADCP',
          measuredAt: '2024-06-20T10:05:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_bs_1', sectionId: 'sec_bs_2406', no: 1, startDistanceM: 10.0, depthM: 2.6, pointCount: 3, bedNote: 'ADCP 左半断面' },
        { id: 'vrt_bs_2', sectionId: 'sec_bs_2406', no: 2, startDistanceM: 24.0, depthM: 3.4, pointCount: 3, bedNote: 'ADCP 右半断面' }
      ],
      points: [
        { id: 'pnt_bs_11', verticalId: 'vrt_bs_1', relativeDepth: 0.2, velocityMs: 1.22, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_12', verticalId: 'vrt_bs_1', relativeDepth: 0.6, velocityMs: 1.08, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_13', verticalId: 'vrt_bs_1', relativeDepth: 0.8, velocityMs: 0.9, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_21', verticalId: 'vrt_bs_2', relativeDepth: 0.2, velocityMs: 1.46, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_22', verticalId: 'vrt_bs_2', relativeDepth: 0.6, velocityMs: 1.3, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_23', verticalId: 'vrt_bs_2', relativeDepth: 0.8, velocityMs: 1.1, weight: 1 / 3, durationS: 120 }
      ]
    }
  ]

  // 水尺接测记录（站上）：
  // - 龙门站洪水（8/15）后零点下沉 0.05 m：8/21 那次点据采用新零点，其余用旧零点；
  // - 白沙滩只有 8/1 一条接测，5～7 月的点据时间对不上，演示「挑出来交站上认」。
  const surveySeeds: Array<Omit<GaugeSurvey, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'gsv_lh_old',
      stationId: 'stn_lh01',
      gaugeCode: 'P1',
      surveyedAt: '2024-01-01T00:00:00.000Z',
      zeroElevationM: 0,
      operator: '秦越',
      remark: '年度校测，零点稳定',
      backfilled: false
    },
    {
      id: 'gsv_lh_flood',
      stationId: 'stn_lh01',
      gaugeCode: 'P1',
      surveyedAt: '2024-08-15T00:00:00.000Z',
      zeroElevationM: -0.05,
      operator: '秦越',
      remark: '洪水后水尺重新接测，零点下沉 0.05 m',
      backfilled: false
    },
    {
      id: 'gsv_qj_old',
      stationId: 'stn_qj02',
      gaugeCode: 'P1',
      surveyedAt: '2023-01-01T00:00:00.000Z',
      zeroElevationM: 0,
      operator: '何岩',
      remark: '年度校测',
      backfilled: false
    },
    {
      id: 'gsv_bs_old',
      stationId: 'stn_bs03',
      gaugeCode: 'P1',
      surveyedAt: '2024-06-01T00:00:00.000Z',
      zeroElevationM: 0.02,
      operator: '何岩',
      remark: '汛前接测，零点偏高 0.02 m',
      backfilled: false
    },
    {
      id: 'gsv_bs_aug',
      stationId: 'stn_bs03',
      gaugeCode: 'P1',
      surveyedAt: '2024-08-01T00:00:00.000Z',
      zeroElevationM: 0,
      operator: '何岩',
      remark: '洪水季前接测',
      backfilled: false
    }
  ]

  // 水位流量关系点据：A 线为龙门站主定线，B 线为青矶站定线。
  // datumStageM 为按测流当时零点折算到统一基面的水位（站上原始读数 stageM 保留不动）。
  const ratingSeeds: Array<Omit<Rating, 'createdAt' | 'updatedAt'>> = [
    { id: 'rat_lh_a1', stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z', datumStageM: 4.01, zeroSurveyId: 'gsv_lh_old', datumStatus: 'folded' },
    { id: 'rat_lh_a2', stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, lineNo: 'A', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z', datumStageM: 4.52, zeroSurveyId: 'gsv_lh_old', datumStatus: 'folded' },
    { id: 'rat_lh_a3', stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, lineNo: 'A', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:30:00.000Z', datumStageM: 5.42, zeroSurveyId: 'gsv_lh_old', datumStatus: 'folded' },
    { id: 'rat_lh_a4', stationId: 'stn_lh01', stageM: 6.15, flowM3s: 298.5, lineNo: 'A', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:10:00.000Z', datumStageM: 6.15, zeroSurveyId: 'gsv_lh_old', datumStatus: 'folded' },
    { id: 'rat_lh_a5', stationId: 'stn_lh01', stageM: 7.03, flowM3s: 428.1, lineNo: 'A', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z', datumStageM: 6.98, zeroSurveyId: 'gsv_lh_flood', datumStatus: 'folded' },
    { id: 'rat_qj_b1', stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, lineNo: 'B', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z', datumStageM: 2.84, zeroSurveyId: 'gsv_qj_old', datumStatus: 'folded' },
    { id: 'rat_qj_b2', stationId: 'stn_qj02', stageM: 3.18, flowM3s: 56.1, lineNo: 'B', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:50:00.000Z', datumStageM: 3.18, zeroSurveyId: 'gsv_qj_old', datumStatus: 'folded' },
    { id: 'rat_qj_b3', stationId: 'stn_qj02', stageM: 3.72, flowM3s: 78.4, lineNo: 'B', measureNo: '2024-07-001', measuredAt: '2024-07-02T08:10:00.000Z', datumStageM: 3.72, zeroSurveyId: 'gsv_qj_old', datumStatus: 'folded' },
    { id: 'rat_qj_b4', stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, lineNo: 'B', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:40:00.000Z', datumStageM: 4.36, zeroSurveyId: 'gsv_qj_old', datumStatus: 'folded' },
    // C 线：含两个明显偏离点，用于演示超限挂红与偏差分析；前 3 点早于该站首条接测，时间对不上
    { id: 'rat_bs_c1', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z', datumStageM: null, zeroSurveyId: null, datumStatus: 'unmatched' },
    { id: 'rat_bs_c2', stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, lineNo: 'C', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:05:00.000Z', datumStageM: 5.38, zeroSurveyId: 'gsv_bs_old', datumStatus: 'folded' },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 325.0, lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z', datumStageM: 5.9, zeroSurveyId: 'gsv_bs_old', datumStatus: 'folded' },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 288.0, lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z', datumStageM: 6.44, zeroSurveyId: 'gsv_bs_aug', datumStatus: 'folded' }
  ]

  /** 构造报出版本快照：冻结给定点据（已折基面）下的定线参数与逐点比测结论 */
  function buildVersionSnapshot(
    versionNo: string,
    members: Array<Omit<Rating, 'createdAt' | 'updatedAt'>>,
    note: string,
    operator: string,
    publishedAt: string
  ): RatingVersion {
    const fit = fitPowerCurve(
      members.map((rating) => ({ stageM: rating.datumStageM ?? rating.stageM, flowM3s: rating.flowM3s })),
      members[0]?.lineNo ?? ''
    )
    const points: RatingVersion['points'] = members.map((rating) => {
      const datumStage = rating.datumStageM ?? rating.stageM
      const predicted = fit.valid
        ? round(fit.a * Math.pow(Math.max(datumStage - fit.h0, 1e-6), fit.b), 2)
        : rating.flowM3s
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
    return {
      id: `ver_${versionNo.toLowerCase()}`,
      lineNo: members[0]?.lineNo ?? '',
      stationId: members[0]?.stationId ?? '',
      versionNo,
      fit,
      points,
      compareCount: points.length,
      overLimitCount,
      qualifyRatePct: points.length === 0 ? 0 : Number((((points.length - overLimitCount) / points.length) * 100).toFixed(1)),
      note,
      operator,
      publishedAt,
      createdAt: now
    }
  }

  // A 线报出版本用的是洪水接测（8/15）之前的 4 个点：零点变化后旧版仍原样可查
  const versionSeeds: RatingVersion[] = [
    buildVersionSnapshot(
      'A-V1',
      ratingSeeds.filter((rating) => rating.lineNo === 'A' && rating.id !== 'rat_lh_a5'),
      '汛中初定，按洪水接测前旧零点读数定线并报出',
      '林昭',
      '2024-08-10T12:00:00.000Z'
    ),
    buildVersionSnapshot(
      'B-V1',
      ratingSeeds.filter((rating) => rating.lineNo === 'B'),
      '青矶站年度定线报出',
      '林昭',
      '2024-08-12T12:00:00.000Z'
    )
  ]

  await db.transaction(
    'rw',
    [
      db.stations,
      db.sections,
      db.verticals,
      db.points,
      db.ratings,
      db.compares,
      db.gaugeSurveys,
      db.ratingLineStates,
      db.ratingVersions,
      db.recalcJobs
    ],
    async () => {
      const stamp = (row: { id: string }): { createdAt: number; updatedAt: number } => ({
        createdAt: now + row.id.length,
        updatedAt: now + row.id.length
      })

      await db.stations.bulkPut(
        stationBundles.map((bundle) => ({ ...bundle.station, ...stamp(bundle.station) }))
      )
      await db.sections.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.sections.map((section) => ({ ...section, ...stamp(section) }))
        )
      )
      await db.verticals.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
        )
      )
      await db.points.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.points.map((point) => ({ ...point, ...stamp(point) }))
        )
      )
      await db.ratings.bulkPut(ratingSeeds.map((rating) => ({ ...rating, ...stamp(rating) })))
      await db.gaugeSurveys.bulkPut(surveySeeds.map((survey) => ({ ...survey, ...stamp(survey) })))

      // 比测记录：按「统一基面水位」拟合曲线流量后计算偏差与判定；
      // 时间对不上、站上未确认的点据不参与比测，等站上认了零点随重算补入。
      const compares: Compare[] = []
      const foldedSeeds = ratingSeeds.filter((rating) => rating.datumStatus === 'folded')
      const lineGroups = new Map<string, Array<{ stageM: number; flowM3s: number }>>()
      foldedSeeds.forEach((rating) => {
        const list = lineGroups.get(rating.lineNo) ?? []
        list.push({ stageM: rating.datumStageM ?? rating.stageM, flowM3s: rating.flowM3s })
        lineGroups.set(rating.lineNo, list)
      })
      foldedSeeds.forEach((rating) => {
        const fit = fitPowerCurve(lineGroups.get(rating.lineNo) ?? [], rating.lineNo)
        if (!fit.valid) return
        const datumStage = rating.datumStageM ?? rating.stageM
        const predicted = round(fit.a * Math.pow(Math.max(datumStage - fit.h0, 1e-6), fit.b), 2)
        const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
        compares.push({
          id: `cmp_${rating.id}`,
          ratingId: rating.id,
          measuredFlow: rating.flowM3s,
          curveFlow: predicted,
          deviationPct,
          verdict: judgeDeviation(deviationPct),
          operator: rating.lineNo === 'C' ? '周渝' : '林昭',
          comparedAt: rating.measuredAt,
          createdAt: now,
          updatedAt: now
        })
      })
      await db.compares.bulkPut(compares)

      // 定线状态：A 线洪水接测后未定案、待按新零点重算；B 已定案；C 未定案（待站上认点后重算）
      const lineStates: RatingLineState[] = [
        {
          id: 'rls_a',
          lineNo: 'A',
          stationId: 'stn_lh01',
          status: 'draft',
          lastSurveyAt: '2024-08-15T00:00:00.000Z',
          needsRecalc: true,
          lastRecalcAt: null,
          createdAt: now,
          updatedAt: now
        },
        {
          id: 'rls_b',
          lineNo: 'B',
          stationId: 'stn_qj02',
          status: 'finalized',
          lastSurveyAt: '2023-01-01T00:00:00.000Z',
          needsRecalc: false,
          lastRecalcAt: now,
          createdAt: now,
          updatedAt: now
        },
        {
          id: 'rls_c',
          lineNo: 'C',
          stationId: 'stn_bs03',
          status: 'draft',
          lastSurveyAt: '2024-08-01T00:00:00.000Z',
          needsRecalc: false,
          lastRecalcAt: now,
          createdAt: now,
          updatedAt: now
        }
      ]
      await db.ratingLineStates.bulkPut(lineStates)
      await db.ratingVersions.bulkPut(versionSeeds)

      // A 线的待办：零点改动后未定案定线的重算任务（资料室侧执行，失败可从这里重试）
      const jobA: RecalcJob = {
        id: 'job_a_recalc',
        lineNo: 'A',
        stationId: 'stn_lh01',
        reason: '零点接测生效',
        status: 'pending',
        attempts: 0,
        errorMessage: '',
        forceFailOnce: false,
        createdAt: now,
        updatedAt: now,
        lastTriedAt: null,
        succeededAt: null
      }
      await db.recalcJobs.put(jobA)
    }
  )
}

/** 打开数据库并幂等播种：仅当测站表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.stations.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.stations,
      db.sections,
      db.verticals,
      db.points,
      db.ratings,
      db.compares,
      db.gaugeSurveys,
      db.ratingLineStates,
      db.ratingVersions,
      db.recalcJobs
    ],
    async () => {
      await Promise.all([
        db.stations.clear(),
        db.sections.clear(),
        db.verticals.clear(),
        db.points.clear(),
        db.ratings.clear(),
        db.compares.clear(),
        db.gaugeSurveys.clear(),
        db.ratingLineStates.clear(),
        db.ratingVersions.clear(),
        db.recalcJobs.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与导出页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [
    stations,
    sections,
    verticals,
    points,
    ratings,
    compares,
    gaugeSurveys,
    ratingLineStates,
    ratingVersions,
    recalcJobs
  ] = await Promise.all([
    db.stations.count(),
    db.sections.count(),
    db.verticals.count(),
    db.points.count(),
    db.ratings.count(),
    db.compares.count(),
    db.gaugeSurveys.count(),
    db.ratingLineStates.count(),
    db.ratingVersions.count(),
    db.recalcJobs.count()
  ])
  return { stations, sections, verticals, points, ratings, compares, gaugeSurveys, ratingLineStates, ratingVersions, recalcJobs }
}

/** 写入结构版本号到 localStorage，便于导出页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastStationId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastStationId)
  } catch {
    return null
  }
}

export function writeLastStationId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastStationId)
    else localStorage.setItem(LS_KEYS.lastStationId, id)
  } catch {
    // 忽略
  }
}

/** 计算某垂线的平均流速（页面与播种共用同一套算法） */
export function verticalMeanVelocity(points: Point[]): number {
  return calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
}
