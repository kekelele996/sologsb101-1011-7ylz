/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入。
 * 与 utils/db.ts 的 BackupPayload 结构保持一致。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import type { RatingLineState, RatingVersion } from '@/types/ratingVersion'
import type { RecalcJob } from '@/types/recalc'
import type { Rating } from '@/types/rating'
import { foldRatings, planLegacyBackfill } from '@/utils/datum'

/** 备份集合键名 */
export const BACKUP_KEYS = [
  'stations',
  'sections',
  'verticals',
  'points',
  'ratings',
  'compares',
  'gaugeSurveys',
  'ratingLineStates',
  'ratingVersions',
  'recalcJobs'
] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

/** 各表行数统计（导出页展示与导入结果回执共用） */
export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
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
    db.stations.toArray(),
    db.sections.toArray(),
    db.verticals.toArray(),
    db.points.toArray(),
    db.ratings.toArray(),
    db.compares.toArray(),
    db.gaugeSurveys.toArray(),
    db.ratingLineStates.toArray(),
    db.ratingVersions.toArray(),
    db.recalcJobs.toArray()
  ])
  return {
    app: 'gbhydrogaug',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
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
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== 'gbhydrogaug' && obj.app !== undefined) {
    errors.push('app 字段应为 gbhydrogaug，文件来源不明')
  }
  // v2 之前的六张表为必备；v3 新增的四张表缺失时按旧备份处理并在导入时补回填
  const requiredKeys = ['stations', 'sections', 'verticals', 'points', 'ratings', 'compares'] as const
  for (const key of requiredKeys) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbhydrogaug',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    stations: obj.stations ?? [],
    sections: obj.sections ?? [],
    verticals: obj.verticals ?? [],
    points: obj.points ?? [],
    ratings: obj.ratings ?? [],
    compares: obj.compares ?? [],
    gaugeSurveys: obj.gaugeSurveys ?? [],
    ratingLineStates: obj.ratingLineStates ?? [],
    ratingVersions: obj.ratingVersions ?? [],
    recalcJobs: obj.recalcJobs ?? []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    stations: payload.stations.length,
    sections: payload.sections.length,
    verticals: payload.verticals.length,
    points: payload.points.length,
    ratings: payload.ratings.length,
    compares: payload.compares.length,
    gaugeSurveys: payload.gaugeSurveys.length,
    ratingLineStates: payload.ratingLineStates.length,
    ratingVersions: payload.ratingVersions.length,
    recalcJobs: payload.recalcJobs.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * 旧备份（v2 及更早，无零点记录 / 无基面字段）升级：
 * 与 Dexie v3 upgrade 同一套规则——按最近一次测流回填接测，折到统一基面，
 * 对不上时间的点据保持 unmatched 交站上认，并为未定案定线挂重算任务。
 */
export function migrateLegacyPayload(payload: BackupPayload): BackupPayload {
  if (payload.gaugeSurveys.length > 0 && payload.ratings.some((rating) => 'datumStageM' in rating)) {
    return payload
  }
  const now = Date.now()
  const ratings = payload.ratings.map((rating) => ({ ...rating })) as Rating[]
  const backfilledSurveys = planLegacyBackfill(ratings, payload.gaugeSurveys, createId, now)
  const gaugeSurveys = [...payload.gaugeSurveys, ...backfilledSurveys]
  const folded = foldRatings(
    ratings.map((rating) => ({
      ...rating,
      datumStageM: rating.datumStageM ?? null,
      zeroSurveyId: rating.zeroSurveyId ?? null,
      datumStatus: rating.datumStatus ?? 'unmatched'
    })),
    gaugeSurveys
  )
  const foldMap = new Map(folded.map((item) => [item.ratingId, item]))
  ratings.forEach((rating) => {
    const result = foldMap.get(rating.id)
    if (result && !result.unmatched) {
      rating.datumStageM = result.datumStageM
      rating.zeroSurveyId = result.surveyId
      rating.datumStatus = 'folded'
    } else {
      rating.datumStageM = null
      rating.zeroSurveyId = null
      rating.datumStatus = 'unmatched'
    }
  })

  const lineNos = Array.from(new Set(ratings.map((rating) => rating.lineNo)))
  const lineStates: RatingLineState[] = payload.ratingLineStates.length
    ? payload.ratingLineStates
    : lineNos.map((lineNo, index) => ({
        id: createId('rls'),
        lineNo,
        stationId: ratings.find((rating) => rating.lineNo === lineNo)?.stationId ?? '',
        status: 'draft' as const,
        lastSurveyAt: null,
        needsRecalc: true,
        lastRecalcAt: null,
        createdAt: now + index,
        updatedAt: now + index
      }))
  const recalcJobs: RecalcJob[] = payload.recalcJobs.length
    ? payload.recalcJobs
    : lineNos.map((lineNo, index) => ({
        id: createId('job'),
        lineNo,
        stationId: ratings.find((rating) => rating.lineNo === lineNo)?.stationId ?? '',
        reason: '手动重算' as const,
        status: 'pending' as const,
        attempts: 0,
        errorMessage: '',
        forceFailOnce: false,
        createdAt: now + index,
        updatedAt: now + index,
        lastTriedAt: null,
        succeededAt: null
      }))

  return {
    ...payload,
    ratings,
    gaugeSurveys,
    ratingLineStates: lineStates,
    ratingVersions: payload.ratingVersions as RatingVersion[],
    recalcJobs
  }
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payloadIn: BackupPayload, overwrite: boolean): Promise<CountMap> {
  // 旧备份先按升级规则回填零点 / 折基面 / 挂重算，再落库
  const payload = migrateLegacyPayload(payloadIn)
  if (overwrite) await clearAllTables()
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
      await db.stations.bulkPut(payload.stations)
      await db.sections.bulkPut(payload.sections)
      await db.verticals.bulkPut(payload.verticals)
      await db.points.bulkPut(payload.points)
      await db.ratings.bulkPut(payload.ratings)
      await db.compares.bulkPut(payload.compares)
      await db.gaugeSurveys.bulkPut(payload.gaugeSurveys)
      await db.ratingLineStates.bulkPut(payload.ratingLineStates)
      await db.ratingVersions.bulkPut(payload.ratingVersions)
      await db.recalcJobs.bulkPut(payload.recalcJobs)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payloadIn: BackupPayload): BackupPayload {
  const payload = migrateLegacyPayload(payloadIn)
  const stationMap = new Map<string, string>()
  const sectionMap = new Map<string, string>()
  const verticalMap = new Map<string, string>()
  const ratingMap = new Map<string, string>()
  const surveyMap = new Map<string, string>()

  const stations = payload.stations.map((station) => {
    const id = createId('stn')
    stationMap.set(station.id, id)
    return { ...station, id }
  })
  const sections = payload.sections.map((section) => {
    const id = createId('sec')
    sectionMap.set(section.id, id)
    return { ...section, id, stationId: stationMap.get(section.stationId) ?? section.stationId }
  })
  const verticals = payload.verticals.map((vertical) => {
    const id = createId('vrt')
    verticalMap.set(vertical.id, id)
    return { ...vertical, id, sectionId: sectionMap.get(vertical.sectionId) ?? vertical.sectionId }
  })
  const points = payload.points.map((point) => ({
    ...point,
    id: createId('pnt'),
    verticalId: verticalMap.get(point.verticalId) ?? point.verticalId
  }))
  const gaugeSurveys = payload.gaugeSurveys.map((survey) => {
    const id = createId('gsv')
    surveyMap.set(survey.id, id)
    return { ...survey, id, stationId: stationMap.get(survey.stationId) ?? survey.stationId }
  })
  const ratings = payload.ratings.map((rating) => {
    const id = createId('rat')
    ratingMap.set(rating.id, id)
    return {
      ...rating,
      id,
      stationId: stationMap.get(rating.stationId) ?? rating.stationId,
      zeroSurveyId: rating.zeroSurveyId ? surveyMap.get(rating.zeroSurveyId) ?? rating.zeroSurveyId : null
    }
  })
  const compares = payload.compares.map((compare) => ({
    ...compare,
    id: createId('cmp'),
    ratingId: ratingMap.get(compare.ratingId) ?? compare.ratingId
  }))
  // 定线成果按定线号重挂：id 重新分配，版本内点据快照的 ratingId 同步替换
  const lineStateMap = new Map<string, string>()
  const ratingLineStates = payload.ratingLineStates.map((state) => {
    const id = createId('rls')
    lineStateMap.set(state.lineNo, id)
    return { ...state, id, stationId: stationMap.get(state.stationId) ?? state.stationId }
  })
  const recalcJobs = payload.recalcJobs.map((job) => ({
    ...job,
    id: createId('job'),
    stationId: stationMap.get(job.stationId) ?? job.stationId
  }))
  const ratingVersions = payload.ratingVersions.map((version) => ({
    ...version,
    id: createId('ver'),
    stationId: stationMap.get(version.stationId) ?? version.stationId,
    points: version.points.map((point) => ({
      ...point,
      ratingId: ratingMap.get(point.ratingId) ?? point.ratingId,
      stationId: stationMap.get(point.stationId) ?? point.stationId,
      surveyId: point.surveyId ? surveyMap.get(point.surveyId) ?? point.surveyId : null
    }))
  }))
  return {
    ...payload,
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
  }
}

/**
 * 生成结论文本：按测站输出最新水位、断面测次、定线参数与超限点据。
 * 供导出页的「检测结论」区域使用。
 */
export interface ConclusionLine {
  stationId: string
  stationName: string
  river: string
  sectionCount: number
  latestStageM: number | null
  ratingCount: number
  overLimitCount: number
  fitText: string
}

export function buildConclusionLines(
  payload: BackupPayload,
  fits: Array<{ lineNo: string; valid: boolean; a: number; b: number; h0: number; meanResidualPct: number; sampleCount: number }>
): ConclusionLine[] {
  return payload.stations.map((station) => {
    const sections = payload.sections.filter((section) => section.stationId === station.id)
    const latest = sections.reduce<number | null>((acc, section) => {
      if (acc === null) return section.stageM
      return section.stageM > acc ? section.stageM : acc
    }, null)
    const ratings = payload.ratings.filter((rating) => rating.stationId === station.id)
    const ratingIds = new Set(ratings.map((rating) => rating.id))
    const overLimitCount = payload.compares.filter(
      (compare) => ratingIds.has(compare.ratingId) && compare.verdict === '超限'
    ).length
    const lines = Array.from(new Set(ratings.map((rating) => rating.lineNo)))
    const fitParts = lines.map((lineNo) => {
      const fit = fits.find((item) => item.lineNo === lineNo)
      if (!fit || !fit.valid) return `${lineNo} 线未定线`
      return `${lineNo} 线 Q=${fit.a}·(H'-${fit.h0})^${fit.b}，残差 ${fit.meanResidualPct}%（${fit.sampleCount} 点，H'为统一基面水位）`
    })
    return {
      stationId: station.id,
      stationName: station.name,
      river: station.river,
      sectionCount: sections.length,
      latestStageM: latest,
      ratingCount: ratings.length,
      overLimitCount,
      fitText: fitParts.length > 0 ? fitParts.join('；') : '暂无关系点据'
    }
  })
}
