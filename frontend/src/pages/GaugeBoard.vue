<script setup lang="ts">
/**
 * 站上模块：/gauges 水尺接测登记（站上限界）。
 * 只管一件事：每接一次水尺，记下水尺零点高程、接测时间、接测人。
 * 不碰资料室的关系点据、定线与比测；资料室重算从它那侧进行，本页记录不受影响。
 * 同时列出资料室挑出的「时间对不上、待站上认」的点据，方便站上核对后补一次接测。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, SetUp, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useGaugeSurveyStore } from '@/stores/gaugeSurveyStore'
import { useStationStore } from '@/stores/stationStore'
import { useRatingStore } from '@/stores/ratingStore'
import { initDatabase } from '@/utils/db'
import { DATUM_STATUS_LABEL, DATUM_STATUS_TONE, type DatumStatus, type GaugeSurvey } from '@/types/gaugeSurvey'

const router = useRouter()
const gaugeStore = useGaugeSurveyStore()
const stationStore = useStationStore()
const ratingStore = useRatingStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const recalculating = ref(false)
const selectedStationId = ref<string>('')

const form = reactive({
  zeroElevM: 0,
  surveyedAt: new Date().toISOString().slice(0, 16),
  surveyor: '',
  note: ''
})

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  gaugeStore.start()
  ratingStore.start()
})

const stationOptions = computed(() => stationStore.stations)
const effectiveStationId = computed(
  () =>
    selectedStationId.value ||
    stationStore.currentStationId ||
    stationOptions.value[0]?.id ||
    ''
)

const stationSurveys = computed<GaugeSurvey[]>(() =>
  effectiveStationId.value ? gaugeStore.surveysOfStation(effectiveStationId.value).slice().reverse() : []
)

const latestSurvey = computed<GaugeSurvey | null>(() =>
  effectiveStationId.value ? gaugeStore.latestSurveyOfStation(effectiveStationId.value) : null
)

/** 该站待站上认的点据（资料室挑出、时间对不上任何接测） */
const stationPending = computed(() =>
  ratingStore.pendingRatings.filter((rating) => rating.stationId === effectiveStationId.value)
)

/** 该站全部点据（供查看基面折算结果） */
const stationRatings = computed(() =>
  ratingStore.ratings
    .filter((rating) => rating.stationId === effectiveStationId.value)
    .slice()
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
)

function openCreate(): void {
  editingId.value = null
  form.zeroElevM = latestSurvey.value?.zeroElevM ?? 0
  form.surveyedAt = new Date().toISOString().slice(0, 16)
  form.surveyor = latestSurvey.value?.surveyor ?? ''
  form.note = ''
  dialogVisible.value = true
}

function openEdit(survey: GaugeSurvey): void {
  editingId.value = survey.id
  form.zeroElevM = survey.zeroElevM
  form.surveyedAt = survey.surveyedAt.slice(0, 16)
  form.surveyor = survey.surveyor
  form.note = survey.note
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!effectiveStationId.value) {
    ElMessage.warning('请先选择测站')
    return
  }
  if (!Number.isFinite(form.zeroElevM)) {
    ElMessage.warning('请填写水尺零点高程（m）')
    return
  }
  if (!form.surveyor.trim()) {
    ElMessage.warning('请填写接测人（每接一次必须记名）')
    return
  }
  const surveyedAt = new Date(form.surveyedAt)
  if (Number.isNaN(surveyedAt.getTime())) {
    ElMessage.warning('请填写接测时间')
    return
  }
  submitting.value = true
  try {
    if (editingId.value) {
      // 站上更正误录：接测记录归站上限界，仅更新这一条
      await gaugeStore.updateSurvey(editingId.value, {
        zeroElevM: form.zeroElevM,
        surveyedAt: surveyedAt.toISOString(),
        surveyor: form.surveyor.trim(),
        note: form.note.trim()
      })
      ElMessage.success('接测记录已更正')
    } else {
      await gaugeStore.createSurvey({
        stationId: effectiveStationId.value,
        zeroElevM: form.zeroElevM,
        surveyedAt: surveyedAt.toISOString(),
        surveyor: form.surveyor.trim(),
        note: form.note.trim()
      })
      ElMessage.success('水尺接测已登记：零点与接测人已记录，资料室可据此重折基面')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeSurvey(survey: GaugeSurvey): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除第 ${survey.surveyNo} 次接测（零点 ${survey.zeroElevM.toFixed(3)} m，${survey.surveyor}）？删除后资料室需自行重算基面。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await gaugeStore.removeSurvey(survey.id)
  ElMessage.success('接测记录已删除（关系点据与定线未改动）')
}

/**
 * 通知资料室侧重算：站上只提供接测事实，重算在资料室侧执行。
 * 若重算失败，重试也只影响资料室数据，接测记录不丢。
 */
async function notifyRecompute(): Promise<void> {
  recalculating.value = true
  try {
    const result = await ratingStore.recomputeDatum({ stationIds: [effectiveStationId.value] })
    ElMessage.success(
      `已按本站接测零点重折：折算 ${result.ratingsRecalculated} 点，仍待认定 ${result.pendingCount} 点`
    )
  } catch {
    ElMessage.error('资料室重算失败，可到关系点据页重试；本站接测记录不受影响')
  } finally {
    recalculating.value = false
  }
}

function goRatings(): void {
  void router.push('/ratings')
}

function statusLabel(status: unknown): string {
  return DATUM_STATUS_LABEL[status as DatumStatus] ?? '—'
}
function statusTone(status: unknown): 'success' | 'warning' | 'danger' {
  return DATUM_STATUS_TONE[status as DatumStatus] ?? 'warning'
}
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水尺接测登记（站上）</h2>
        <p class="gb-hint">
          洪水过后水尺重新接测，每接一次在此记下水尺零点高程、接测时间与接测人；
          资料室按测流当时那一次零点把水位折到同一基面。本页不改动任何关系点据与定线。
        </p>
      </div>
      <div class="page__actions">
        <el-select v-model="selectedStationId" placeholder="选择测站" class="page__station-select">
          <el-option v-for="station in stationOptions" :key="station.id" :label="station.name" :value="station.id" />
        </el-select>
        <el-button :icon="SetUp" :loading="recalculating" :disabled="!effectiveStationId" @click="notifyRecompute">
          交资料室重折基面
        </el-button>
        <el-button type="primary" :icon="Plus" :disabled="!effectiveStationId" @click="openCreate">登记接测</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="接测次数" :value="stationSurveys.length" suffix="次" icon="SetUp" />
      <StatBadge
        label="当前零点"
        :value="latestSurvey ? latestSurvey.zeroElevM.toFixed(3) : '—'"
        suffix="m"
        tone="info"
        icon="Aim"
      />
      <StatBadge
        label="待站上认点据"
        :value="stationPending.length"
        suffix="点"
        :tone="stationPending.length > 0 ? 'danger' : 'success'"
        :icon="stationPending.length > 0 ? 'WarningFilled' : 'DataLine'"
      />
    </div>

    <el-alert
      v-if="stationPending.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="page__pending-alert"
    >
      <template #title>
        <span>
          有 {{ stationPending.length }} 个点据的测流时间对不上本站接测零点（资料室已挑出）。
          若确认历史零点，请补登记一次「接测时间不晚于该测次」的接测，再点「交资料室重折基面」。
        </span>
      </template>
    </el-alert>

    <div class="page__grid">
      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>接测台账（零点 / 接测人）</h3>
          <span class="gb-hint">同一测站按接测时间先后衔接，零点自接测时刻起生效至下一次</span>
        </div>
        <EmptyPanel
          v-if="stationSurveys.length === 0"
          title="该站还没有水尺接测记录"
          description="洪水过后水尺重新接测后，点「登记接测」记录零点高程与接测人。"
          action-text="登记接测"
          @action="openCreate"
        />
        <el-table v-else :data="stationSurveys" border stripe class="gb-table-compact">
          <el-table-column prop="surveyNo" label="序号" width="64" align="center" />
          <el-table-column label="零点高程 (m)" width="120" align="right">
            <template #default="{ row }">
              <span class="gb-mono page__zero">{{ row.zeroElevM.toFixed(3) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="接测时间" width="170">
            <template #default="{ row }">
              <span class="gb-mono">{{ new Date(row.surveyedAt).toLocaleString('zh-CN') }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="surveyor" label="接测人" width="100" />
          <el-table-column prop="note" label="备注" min-width="200" show-overflow-tooltip />
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button size="small" :icon="Edit" @click="openEdit(row)">更正</el-button>
              <el-button size="small" type="danger" plain :icon="Delete" @click="removeSurvey(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>本站点据基面情况</h3>
          <el-button size="small" text type="primary" @click="goRatings">前往资料室定线</el-button>
        </div>
        <EmptyPanel
          v-if="stationRatings.length === 0"
          title="该站暂无关系点据"
          compact
        />
        <el-table v-else :data="stationRatings" size="small" border class="gb-table-compact">
          <el-table-column label="测流时间" width="104">
            <template #default="{ row }">{{ new Date(row.measuredAt).toLocaleDateString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column label="读数" width="70" align="right">
            <template #default="{ row }">{{ row.stageM.toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="基面水位" width="84" align="right">
            <template #default="{ row }">{{ row.datumStageM !== null ? row.datumStageM.toFixed(3) : '—' }}</template>
          </el-table-column>
          <el-table-column label="状态" width="92" align="center">
            <template #default="{ row }">
              <el-tooltip :content="row.datumNote" placement="top">
                <el-tag size="small" :type="statusTone(row.datumStatus)" effect="plain">
                  {{ statusLabel(row.datumStatus) }}
                </el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
        </el-table>
        <p class="gb-hint page__warn" v-if="stationPending.length > 0">
          <el-icon><Warning /></el-icon> 待站上认的点据不参与资料室定线，请核对历史接测。
        </p>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '更正水尺接测记录' : '登记水尺接测'" width="520px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="水尺零点高程" required>
          <el-input-number v-model="form.zeroElevM" :min="-100" :max="10000" :step="0.001" :precision="3" controls-position="right" />
          <span class="page__unit">m（统一基面）</span>
        </el-form-item>
        <el-form-item label="接测时间" required>
          <el-date-picker v-model="form.surveyedAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="选择时间" />
        </el-form-item>
        <el-form-item label="接测人" required>
          <el-input v-model="form.surveyor" placeholder="如：韩松" maxlength="20" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="如：洪水过后水尺下沉 0.15 m，重新接测" maxlength="120" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存更正' : '登记接测' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__station-select {
  width: 180px;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(520px, 1.4fr) minmax(320px, 1fr);
  gap: 14px;
  align-items: start;
}

.page__zero {
  font-weight: 700;
  color: #0f4c75;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__warn {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  color: #c0392b;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
