<script setup lang="ts">
/**
 * 站上侧：/surveys 水尺接测登记。
 * 站上只负责水尺接测——每接一次记下零点高程、接测时间与接测人（只追加，不改不删）；
 * 资料室折算时对不上时间的点据会挑到这里，由站上确认按哪次接测零点折基面。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Plus, Timer } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useSurveyStore } from '@/stores/surveyStore'
import { useStationStore } from '@/stores/stationStore'
import { createEmptySurveyInput } from '@/types/gaugeSurvey'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const surveyStore = useSurveyStore()
const stationStore = useStationStore()

const selectedStationId = ref<string>('')
const dialogVisible = ref(false)
const submitting = ref(false)
const confirmSurveyId = ref<string>('')
const form = reactive({ ...createEmptySurveyInput('') })

onMounted(async () => {
  await initDatabase()
  surveyStore.start()
  stationStore.start()
  const queryStation = typeof route.query.station === 'string' ? route.query.station : ''
  selectedStationId.value =
    queryStation || stationStore.currentStationId || stationStore.stations[0]?.id || ''
})

const stations = computed(() => stationStore.stations)
const stationSurveys = computed(() =>
  selectedStationId.value ? surveyStore.surveysOfStation(selectedStationId.value) : []
)
const currentZero = computed(() =>
  selectedStationId.value ? surveyStore.currentZero(selectedStationId.value) : null
)
const unmatchedRatings = computed(() =>
  selectedStationId.value ? surveyStore.unmatchedOfStation(selectedStationId.value) : []
)
const totalUnmatched = computed(() => surveyStore.unmatchedRatings.length)

function selectStation(id: string): void {
  selectedStationId.value = id
  stationStore.selectStation(id)
}

function openCreate(): void {
  const preset = createEmptySurveyInput(selectedStationId.value)
  Object.assign(form, preset)
  dialogVisible.value = true
}

async function submitSurvey(): Promise<void> {
  if (!selectedStationId.value) {
    ElMessage.warning('请先选择测站')
    return
  }
  if (!form.operator.trim()) {
    ElMessage.warning('请填写接测人')
    return
  }
  if (!Number.isFinite(form.zeroElevationM)) {
    ElMessage.warning('请填写零点高程（m）')
    return
  }
  submitting.value = true
  try {
    await surveyStore.addSurvey({
      stationId: selectedStationId.value,
      gaugeCode: form.gaugeCode.trim() || 'P1',
      surveyedAt: form.surveyedAt ? new Date(form.surveyedAt).toISOString() : new Date().toISOString(),
      zeroElevationM: form.zeroElevationM,
      operator: form.operator.trim(),
      remark: form.remark.trim(),
      backfilled: false
    })
    ElMessage.success('接测已登记；资料室已把受影响的未定案定线挂上重算任务')
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function confirmOne(ratingId: string): Promise<void> {
  if (!confirmSurveyId.value) {
    ElMessage.warning('请先选择该点据应采用的接测（零点）')
    return
  }
  await surveyStore.confirmRatingDatum(ratingId, confirmSurveyId.value)
  ElMessage.success('已按所选零点折到统一基面，资料室将重算该定线')
}

async function confirmAll(): Promise<void> {
  if (!confirmSurveyId.value) {
    ElMessage.warning('请先选择统一采用的接测（零点）')
    return
  }
  const count = await surveyStore.confirmAllForStation(selectedStationId.value, confirmSurveyId.value)
  ElMessage.success(`已一次确认 ${count} 个点据，资料室将重算相关定线`)
}
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水尺接测登记（站上）</h2>
        <p class="gb-hint">
          洪水过后水尺重新接测，每接一次登记零点高程、接测时间与接测人；记录只追加不改写。
          资料室按各点据「测流当时」生效的零点折统一基面后再定线。
        </p>
      </div>
      <div class="page__actions">
        <el-select
          :model-value="selectedStationId"
          class="page__station-select"
          placeholder="选择测站"
          @change="selectStation"
        >
          <el-option v-for="station in stations" :key="station.id" :label="station.name" :value="station.id" />
        </el-select>
        <el-button type="primary" :icon="Plus" :disabled="!selectedStationId" @click="openCreate">
          登记一次接测
        </el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="本站接测次数" :value="stationSurveys.length" suffix="次" icon="Timer" tone="info" />
      <StatBadge
        label="现行零点高程"
        :value="currentZero ? currentZero.zeroElevationM.toFixed(3) : '—'"
        suffix="m"
        :tone="currentZero ? 'success' : 'warning'"
        icon="Odometer"
      />
      <StatBadge
        label="本站待认点据"
        :value="unmatchedRatings.length"
        suffix="点"
        :tone="unmatchedRatings.length > 0 ? 'warning' : 'success'"
        icon="WarningFilled"
      />
      <StatBadge label="全站待认点据" :value="totalUnmatched" suffix="点" :tone="totalUnmatched > 0 ? 'danger' : 'success'" icon="DataLine" />
    </div>

    <el-alert
      v-if="currentZero"
      type="info"
      show-icon
      :closable="false"
      :title="`现行零点：${currentZero.zeroElevationM.toFixed(3)} m（${new Date(currentZero.surveyedAt).toLocaleString('zh-CN')} 接测，接测人 ${currentZero.operator || '未登记'}）；新接测生效后，资料室仅重算未定案定线，已报出版本不动。`"
    />

    <div class="page__grid">
      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>接测记录（按时间倒序，只追加）</h3>
        </div>
        <EmptyPanel
          v-if="stationSurveys.length === 0"
          title="该站还没有水尺接测记录"
          description="洪水后重新接测时在此登记零点高程、时间与接测人；旧数据升级回填的零点也会列在其中并标注「回填待校核」。"
          action-text="登记一次接测"
          @action="openCreate"
        />
        <el-table v-else :data="stationSurveys" border stripe class="gb-table-compact">
          <el-table-column label="接测时间" min-width="170">
            <template #default="{ row }">
              <span class="gb-mono">{{ new Date(row.surveyedAt).toLocaleString('zh-CN') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="水尺" width="80" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.gaugeCode }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="零点高程 (m)" width="130" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.zeroElevationM.toFixed(3) }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="operator" label="接测人" width="100" />
          <el-table-column label="说明 / 来源" min-width="220">
            <template #default="{ row }">
              <span>{{ row.remark || '—' }}</span>
              <el-tag v-if="row.backfilled" size="small" type="warning" effect="plain" class="page__backfill-tag">
                升级回填待校核
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>对不上时间、待站上认的点据</h3>
          <span class="gb-hint">资料室折算时没有找到不晚于测流时间的接测零点</span>
        </div>
        <EmptyPanel
          v-if="unmatchedRatings.length === 0"
          title="没有待认的点据"
          description="该站关系点据都能对上当时的水尺零点，已折到统一基面。"
          compact
        />
        <template v-else>
          <div class="page__confirm-bar">
            <el-select v-model="confirmSurveyId" placeholder="选择采用哪次接测的零点" class="page__survey-select">
              <el-option
                v-for="survey in stationSurveys"
                :key="survey.id"
                :label="`${new Date(survey.surveyedAt).toLocaleDateString('zh-CN')} · 零点 ${survey.zeroElevationM.toFixed(3)} m${survey.backfilled ? '（回填）' : ''}`"
                :value="survey.id"
              />
            </el-select>
            <el-button type="primary" plain :disabled="!confirmSurveyId" @click="confirmAll">
              一次认掉本站 {{ unmatchedRatings.length }} 点
            </el-button>
            <el-button text type="primary" @click="$router.push('/surveys')">或补登记更早的接测</el-button>
          </div>
          <el-table :data="unmatchedRatings" border class="gb-table-compact">
            <el-table-column label="定线号" width="80" align="center">
              <template #default="{ row }">
                <el-tag size="small" effect="plain">{{ row.lineNo }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="测流时间" min-width="150">
              <template #default="{ row }">
                <span class="gb-mono">{{ new Date(row.measuredAt).toLocaleString('zh-CN') }}</span>
              </template>
            </el-table-column>
            <el-table-column label="水尺读数 (m)" width="120" align="right">
              <template #default="{ row }">
                <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120" fixed="right">
              <template #default="{ row }">
                <el-button size="small" type="primary" :disabled="!confirmSurveyId" @click="confirmOne(row.id)">
                  确认零点
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </template>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" title="登记水尺接测" width="520px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="水尺编号">
          <el-input v-model="form.gaugeCode" placeholder="如 P1" maxlength="8" />
        </el-form-item>
        <el-form-item label="接测时间" required>
          <el-date-picker
            v-model="form.surveyedAt"
            type="datetime"
            value-format="YYYY-MM-DDTHH:mm"
            placeholder="选择接测时间（即新零点生效时间）"
          />
        </el-form-item>
        <el-form-item label="零点高程" required>
          <el-input-number
            v-model="form.zeroElevationM"
            :min="-100"
            :max="100"
            :step="0.001"
            :precision="3"
            controls-position="right"
          />
          <span class="page__unit">m（统一基面水位 = 水尺读数 + 零点高程）</span>
        </el-form-item>
        <el-form-item label="接测人" required>
          <el-input v-model="form.operator" placeholder="接测人姓名" maxlength="16" />
        </el-form-item>
        <el-form-item label="接测说明">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="如：洪水后零点下沉 0.05 m，自某水准点引测" maxlength="120" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitSurvey">登记接测</el-button>
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

.page__station-select,
.page__survey-select {
  width: 220px;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(420px, 1.2fr) minmax(360px, 1fr);
  gap: 14px;
  align-items: start;
}

.page__confirm-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.page__backfill-tag {
  margin-left: 8px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
