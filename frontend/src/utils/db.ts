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
import type { Rating, RatingVersion } from '@/types/rating'
import type { Compare } from '@/types/compare'
import type { GaugeSurvey } from '@/types/gaugeSurvey'
import { resolveDatum } from '@/types/gaugeSurvey'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'
import { fitPowerCurve, fitRatingsOnDatum, curveFlow } from '@/types/rating'
import { calcMeanVelocity, DEFAULT_WEIGHTS, round } from '@/utils/flow'

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
  /** 站上水尺接测记录（零点 + 接测人） */
  gaugeSurveys: GaugeSurvey[]
  /** 资料室已报出的定线版本（含当时比测结论快照，只追加） */
  ratingVersions: RatingVersion[]
}

class HydroGaugeDatabase extends Dexie {
  stations!: Table<Station, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  ratings!: Table<Rating, string>
  compares!: Table<Compare, string>
  gaugeSurveys!: Table<GaugeSurvey, string>
  ratingVersions!: Table<RatingVersion, string>

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
    this.version(2).stores({
      stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
      sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
      verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
      points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
      ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
      compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
    })

    // v3：水尺接测（站上限界）+ 定线版本留档（资料室限界）
    // - 新增 gaugeSurveys（零点、接测人）与 ratingVersions（报出版本快照）
    // - ratings 补基面折算字段，compares 补版本归属与基面水位
    // - 旧点据无零点记录：升级时按最近一次接测回填；时间对不上的挑为 pending 交站上认
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings:
          'id, stationId, lineNo, stageM, flowM3s, measuredAt, datumStatus, datumSurveyId, publishedVersionId, updatedAt',
        compares: 'id, ratingId, ratingVersionId, verdict, deviationPct, comparedAt, updatedAt',
        gaugeSurveys: 'id, stationId, surveyNo, surveyedAt, updatedAt',
        ratingVersions: 'id, lineNo, versionNo, publishedAt'
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

        // v3 基面回填：旧点据没有零点记录。按「最近一次已生效接测」回填，
        // 对不上时间（该站无接测或接测晚于测流）的挑为 pending 交站上认定。
        const surveyRows = (await tx.table('gaugeSurveys').toArray()) as unknown as GaugeSurvey[]
        await tx
          .table('ratings')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if ('datumStatus' in row) return
            const resolution = resolveDatum(
              surveyRows,
              String(row.stationId),
              Number(row.stageM),
              String(row.measuredAt),
              true
            )
            row.datumSurveyId = resolution.survey?.id ?? null
            row.datumZeroElevM = resolution.zeroElevM
            row.datumStageM = resolution.datumStageM
            row.datumStatus = resolution.status
            row.datumNote = resolution.reason
            row.publishedVersionId = null
          })

        // 旧比测记录一律视为历史遗留工作版，补版本归属与基面水位
        await tx
          .table('compares')
          .toCollection()
          .modify((row: Record<string, unknown>) => {
            if (!('ratingVersionId' in row)) row.ratingVersionId = null
            if (!('datumStageM' in row)) row.datumStageM = null
          })
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

  // 水位流量关系点据：A 线为龙门站主定线，B 线为青矶站定线。
  // stageM 是站上水尺读数（零点起算）；datum 字段是资料室按测流当时那次零点折到统一基面的成果。
  // 龙门站洪水（7 月）后水尺下沉，8 月重新接测：零点由 100.000 m 改为 99.850 m，
  // 若仍按旧读数定线，同一场洪水点据会忽高忽低；折到同一基面后点据回归一致。
  const gaugeSurveySeeds: Array<Omit<GaugeSurvey, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'gsv_lh_1',
      stationId: 'stn_lh01',
      surveyNo: 1,
      zeroElevM: 100.0,
      surveyedAt: '2024-01-10T08:00:00.000Z',
      surveyor: '韩松',
      note: '汛前水尺零点接测（假定基面）'
    },
    {
      id: 'gsv_lh_2',
      stationId: 'stn_lh01',
      surveyNo: 2,
      zeroElevM: 99.85,
      surveyedAt: '2024-08-10T08:00:00.000Z',
      surveyor: '韩松',
      note: '洪水过后水尺下沉约 0.15 m，重新接测，零点改为 99.850 m'
    },
    {
      id: 'gsv_qj_1',
      stationId: 'stn_qj02',
      surveyNo: 1,
      zeroElevM: 50.0,
      surveyedAt: '2024-01-15T08:00:00.000Z',
      surveyor: '何远',
      note: '年度水尺零点接测'
    },
    {
      id: 'gsv_bs_1',
      stationId: 'stn_bs03',
      surveyNo: 1,
      zeroElevM: 80.0,
      surveyedAt: '2024-01-20T08:00:00.000Z',
      surveyor: '周渝',
      note: '巡测断面年度接测（假定基面）'
    }
  ]

  /** 资料室点据基面字段（按测流当时生效零点折算） */
  interface RatingDatumSeed {
    datumSurveyId: string | null
    datumZeroElevM: number | null
    datumStageM: number | null
    datumStatus: Rating['datumStatus']
    datumNote: string
    publishedVersionId?: string | null
  }

  type RatingSeedRow = Omit<Rating, 'createdAt' | 'updatedAt' | 'publishedVersionId'> & {
    publishedVersionId?: string | null
  }
  const ratingSeeds: RatingSeedRow[] = [
    // 龙门 A 线：汛前/汛中用旧零点 100.000，8 月洪水后接测，a5 用新零点 99.850
    {
      id: 'rat_lh_a1', stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z',
      datumSurveyId: 'gsv_lh_1', datumZeroElevM: 100.0, datumStageM: 104.01, datumStatus: 'resolved', datumNote: '按测流当时生效零点折算（接测 2024-01-10，韩松）', publishedVersionId: null
    },
    {
      id: 'rat_lh_a2', stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, lineNo: 'A', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z',
      datumSurveyId: 'gsv_lh_1', datumZeroElevM: 100.0, datumStageM: 104.52, datumStatus: 'resolved', datumNote: '按测流当时生效零点折算（接测 2024-01-10，韩松）', publishedVersionId: null
    },
    {
      id: 'rat_lh_a3', stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, lineNo: 'A', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:30:00.000Z',
      datumSurveyId: 'gsv_lh_1', datumZeroElevM: 100.0, datumStageM: 105.42, datumStatus: 'resolved', datumNote: '按测流当时生效零点折算（接测 2024-01-10，韩松）', publishedVersionId: null
    },
    {
      id: 'rat_lh_a4', stationId: 'stn_lh01', stageM: 6.15, flowM3s: 298.5, lineNo: 'A', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:10:00.000Z',
      datumSurveyId: 'gsv_lh_1', datumZeroElevM: 100.0, datumStageM: 106.15, datumStatus: 'resolved', datumNote: '按测流当时生效零点折算（接测 2024-01-10，韩松）', publishedVersionId: null
    },
    {
      id: 'rat_lh_a5', stationId: 'stn_lh01', stageM: 7.18, flowM3s: 428.1, lineNo: 'A', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z',
      datumSurveyId: 'gsv_lh_2', datumZeroElevM: 99.85, datumStageM: 107.03, datumStatus: 'resolved', datumNote: '洪水过后重新接测，按新零点 99.850 折算（接测 2024-08-10，韩松）', publishedVersionId: null
    },
    {
      id: 'rat_qj_b1', stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, lineNo: 'B', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z',
      datumSurveyId: null, datumZeroElevM: null, datumStageM: null, datumStatus: 'pending', datumNote: '测流时间 2023-05-11 早于该站最早接测 2024-01-15，时间对不上，待站上认定'
    },
    {
      id: 'rat_qj_b2', stationId: 'stn_qj02', stageM: 3.18, flowM3s: 56.1, lineNo: 'B', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:50:00.000Z',
      datumSurveyId: 'gsv_qj_1', datumZeroElevM: 50.0, datumStageM: 53.18, datumStatus: 'resolved', datumNote: '按测流当时生效零点折算（接测 2024-01-15，何远）'
    },
    {
      id: 'rat_qj_b3', stationId: 'stn_qj02', stageM: 3.72, flowM3s: 78.4, lineNo: 'B', measureNo: '2024-07-001', measuredAt: '2024-07-02T08:10:00.000Z',
      datumSurveyId: 'gsv_qj_1', datumZeroElevM: 50.0, datumStageM: 53.72, datumStatus: 'resolved', datumNote: '按测流当时生效零点折算（接测 2024-01-15，何远）'
    },
    {
      id: 'rat_qj_b4', stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, lineNo: 'B', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:40:00.000Z',
      datumSurveyId: 'gsv_qj_1', datumZeroElevM: 50.0, datumStageM: 54.36, datumStatus: 'resolved', datumNote: '按测流当时生效零点折算（接测 2024-01-15，何远）'
    },
    // C 线：白沙滩站，c3/c4 为两个明显偏离点，用于演示超限挂红
    {
      id: 'rat_bs_c1', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z',
      datumSurveyId: 'gsv_bs_1', datumZeroElevM: 80.0, datumStageM: 84.9, datumStatus: 'resolved', datumNote: '按测流当时生效零点折算（接测 2024-01-20，周渝）'
    },
    {
      id: 'rat_bs_c2', stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, lineNo: 'C', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:05:00.000Z',
      datumSurveyId: 'gsv_bs_1', datumZeroElevM: 80.0, datumStageM: 85.36, datumStatus: 'resolved', datumNote: '按测流当时生效零点折算（接测 2024-01-20，周渝）'
    },
    {
      id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 325.0, lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z',
      datumSurveyId: 'gsv_bs_1', datumZeroElevM: 80.0, datumStageM: 85.88, datumStatus: 'resolved', datumNote: '按测流当时生效零点折算（接测 2024-01-20，周渝）'
    },
    {
      id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 288.0, lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z',
      datumSurveyId: 'gsv_bs_1', datumZeroElevM: 80.0, datumStageM: 86.44, datumStatus: 'resolved', datumNote: '按测流当时生效零点折算（接测 2024-01-20，周渝）'
    }
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
      db.ratingVersions
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
      await db.gaugeSurveys.bulkPut(gaugeSurveySeeds.map((survey) => ({ ...survey, ...stamp(survey) })))
      await db.ratings.bulkPut(
        ratingSeeds.map((rating) => ({ ...rating, ...stamp(rating), publishedVersionId: rating.publishedVersionId ?? null }))
      )

      // 比测记录：按统一基面水位拟合曲线流量，再算偏差与判定。
      // A 线已报出 v1（洪水接测前那版，冻结留档）；同时各点保留一条当前工作版比测。
      const compares: Compare[] = []

      /** 用某线参与定线的基面点据拟合 */
      const fittableOfLine = (lineNo: string): RatingSeedRow[] =>
        ratingSeeds.filter(
          (rating) =>
            rating.lineNo === lineNo &&
            rating.datumStatus !== 'pending' &&
            typeof rating.datumStageM === 'number'
        )

      const lineFitOf = (lineNo: string) =>
        fitRatingsOnDatum(ratingSeeds, lineNo)

      // A 线报出版本 v1（洪水接测前：a1~a4 按旧零点；留档当时比测结论）
      const aLegacy = fittableOfLine('A').filter((rating) => rating.datumSurveyId === 'gsv_lh_1')
      const aLegacyFit = fitPowerCurve(
        aLegacy.map((rating) => ({ stageM: rating.datumStageM as number, flowM3s: rating.flowM3s })),
        'A'
      )
      const aVersion: RatingVersion = {
        id: 'ver_lh_a_v1',
        lineNo: 'A',
        versionNo: 1,
        reason: '汛中定线报出版（洪水接测前，按当时零点 100.000 m）',
        a: aLegacyFit.a,
        b: aLegacyFit.b,
        h0: aLegacyFit.h0,
        sampleCount: aLegacyFit.sampleCount,
        meanResidualPct: aLegacyFit.meanResidualPct,
        maxResidualPct: aLegacyFit.maxResidualPct,
        r2: aLegacyFit.r2,
        valid: aLegacyFit.valid,
        message: aLegacyFit.message,
        points: aLegacy.map((rating) => ({
          ratingId: rating.id,
          stationId: rating.stationId,
          gaugeStageM: rating.stageM,
          datumZeroElevM: rating.datumZeroElevM,
          datumStageM: rating.datumStageM as number,
          flowM3s: rating.flowM3s,
          datumSurveyId: rating.datumSurveyId
        })),
        compares: [],
        publisher: '林昭',
        publishedAt: '2024-07-31T17:00:00.000Z',
        createdAt: now,
        updatedAt: now
      }
      aVersion.compares = aLegacy.map((rating) => {
        const predicted = round(
          aLegacyFit.a * Math.pow(Math.max((rating.datumStageM as number) - aLegacyFit.h0, 1e-6), aLegacyFit.b),
          2
        )
        const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
        return {
          ratingId: rating.id,
          measuredFlow: rating.flowM3s,
          curveFlow: predicted,
          deviationPct,
          verdict: judgeDeviation(deviationPct),
          operator: '林昭',
          comparedAt: rating.measuredAt
        }
      })
      // a1~a4 指向已报出 v1；a5 是接测后新点据，尚未定案（publishedVersionId=null）
      await db.ratingVersions.put(aVersion)

      ratingSeeds.forEach((rating) => {
        if (rating.datumStatus === 'pending') return
        const fit = lineFitOf(rating.lineNo)
        if (!fit.valid) return
        const datumStage = rating.datumStageM as number
        const predicted = curveFlow(fit, datumStage)
        const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
        // 当前工作版比测（零点改动后可重算、尚未重新定案）
        compares.push({
          id: `cmp_cur_${rating.id}`,
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
        })
      })

      // A 线 v1 归档比测（冻结，与报出版本一并可查）
      aVersion.compares.forEach((item) => {
        compares.push({
          id: `cmp_${aVersion.id}_${item.ratingId}`,
          ratingId: item.ratingId,
          ratingVersionId: aVersion.id,
          datumStageM:
            aVersion.points.find((point) => point.ratingId === item.ratingId)?.datumStageM ?? null,
          measuredFlow: item.measuredFlow,
          curveFlow: item.curveFlow,
          deviationPct: item.deviationPct,
          verdict: item.verdict,
          operator: item.operator,
          comparedAt: item.comparedAt,
          createdAt: now,
          updatedAt: now
        })
      })

      // a1~a4 标记已随 v1 报出（该版本在零点改动前定案，照样可查）
      for (const rating of aLegacy) {
        await db.ratings.update(rating.id, { publishedVersionId: aVersion.id } as never)
      }

      await db.compares.bulkPut(compares)
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
      db.ratingVersions
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
        db.ratingVersions.clear()
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
  const [stations, sections, verticals, points, ratings, compares, gaugeSurveys, ratingVersions] =
    await Promise.all([
      db.stations.count(),
      db.sections.count(),
      db.verticals.count(),
      db.points.count(),
      db.ratings.count(),
      db.compares.count(),
      db.gaugeSurveys.count(),
      db.ratingVersions.count()
    ])
  return { stations, sections, verticals, points, ratings, compares, gaugeSurveys, ratingVersions }
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
