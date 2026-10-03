/**
 * 水尺接测 store（站上限界）。
 * 只负责「水尺接测」这一件事：每接一次，记下水尺零点高程、接测时间、接测人。
 * 不碰关系点据、定线与比测 —— 资料室的重算从资料室那侧重试，站上记录不受影响。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { GaugeSurvey } from '@/types/gaugeSurvey'
import { nextSurveyNo } from '@/types/gaugeSurvey'

export interface NewGaugeSurveyInput {
  stationId: string
  zeroElevM: number
  surveyedAt: string
  surveyor: string
  note?: string
}

export const useGaugeSurveyStore = defineStore('gaugeSurvey', () => {
  const surveys = ref<GaugeSurvey[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<GaugeSurvey>(() => db.gaugeSurveys).subscribe((rows) => {
      surveys.value = rows
      ready.value = true
      error.value = null
    })
  }

  /** 登记一次水尺接测（零点改动由此进入资料室） */
  async function createSurvey(input: NewGaugeSurveyInput): Promise<GaugeSurvey> {
    const now = Date.now()
    const surveyNo = nextSurveyNo(
      surveys.value,
      input.stationId
    )
    const row: GaugeSurvey = {
      id: createId('gsv'),
      stationId: input.stationId,
      surveyNo,
      zeroElevM: input.zeroElevM,
      surveyedAt: input.surveyedAt,
      surveyor: input.surveyor.trim(),
      note: input.note?.trim() ?? '',
      createdAt: now,
      updatedAt: now
    }
    await db.gaugeSurveys.put(row)
    return row
  }

  /** 某站接测记录，按接测时间先后排列 */
  function surveysOfStation(stationId: string): GaugeSurvey[] {
    return surveys.value
      .filter((survey) => survey.stationId === stationId)
      .slice()
      .sort((a, b) => Date.parse(a.surveyedAt) - Date.parse(b.surveyedAt))
  }

  /** 某站最近一次（最新）接测记录 */
  function latestSurveyOfStation(stationId: string): GaugeSurvey | null {
    const list = surveysOfStation(stationId)
    return list.length > 0 ? list[list.length - 1] : null
  }

  /** 更正误录的接测记录（站上侧；资料室定线不随之自动改动） */
  async function updateSurvey(
    id: string,
    patch: Partial<Pick<GaugeSurvey, 'zeroElevM' | 'surveyedAt' | 'surveyor' | 'note'>>
  ): Promise<void> {
    await db.gaugeSurveys.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /** 删除接测记录（站上误录更正；删后资料室需自行重算基面） */
  async function removeSurvey(id: string): Promise<void> {
    await db.gaugeSurveys.delete(id)
  }

  return {
    surveys,
    ready,
    error,
    start,
    createSurvey,
    surveysOfStation,
    latestSurveyOfStation,
    updateSurvey,
    removeSurvey
  }
})
