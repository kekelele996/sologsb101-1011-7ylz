<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据与定线（资料室侧）
 *
 * 基面口径：录入的是站上水尺读数（零点起算）；系统按「测流当时那一次接测零点」
 * 折到统一基面得到 datumStageM，再做幂函数定线 Q = a×(H-H0)^b。
 * - 零点改动后未定案的定线可重算（失败可重试，只动资料室数据）；
 * - 报出的版本连同当时比测结论冻结留档可查；
 * - 对不上时间的点据（pending）挑出，提示交站上认定。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Delete,
  DocumentChecked,
  Edit,
  Plus,
  Refresh,
  TrendCharts,
  Warning
} from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import { useGaugeSurveyStore } from '@/stores/gaugeSurveyStore'
import { DATUM_STATUS_LABEL, DATUM_STATUS_TONE } from '@/types/gaugeSurvey'
import type { DatumStatus } from '@/types/gaugeSurvey'
import { initDatabase } from '@/utils/db'
import type { Rating, RatingVersion } from '@/types/rating'

const route = useRoute()
const router = useRouter()
const ratingStore = useRatingStore()
const stationStore = useStationStore()
const gaugeStore = useGaugeSurveyStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const recomputing = ref(false)
const archiveVisible = ref(false)
const activeArchive = ref<string[]>([])
const publishing = ref(false)
const form = reactive({
  stationId: '',
  stageM: 0,
  flowM3s: 0,
  lineNo: 'A',
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

const fit = computed(() => ratingStore.activeFit)
const lineNos = computed(() => (ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A']))
const activeVersions = computed<RatingVersion[]>(() =>
  ratingStore.versionsOfLine(ratingStore.activeLineNo)
)
const activeLatestVersion = computed<RatingVersion | null>(() =>
  ratingStore.latestVersionOfLine(ratingStore.activeLineNo)
)
const isStale = computed(() => ratingStore.activeLineStale)

/** 表单当前选站与时间下，生效的水尺接测（新增点据即时折算预览） */
const formEffectiveSurvey = computed(() => {
  if (!form.stationId || !form.measuredAt) return null
  const iso = safeIso(form.measuredAt)
  return (
    gaugeStore.surveys
      .filter((survey) => survey.stationId === form.stationId)
      .filter((survey) => Date.parse(survey.surveyedAt) <= Date.parse(iso))
      .sort((a, b) => Date.parse(b.surveyedAt) - Date.parse(a.surveyedAt))[0] ?? null
  )
})
const formDatumPreview = computed<number | null>(() => {
  if (!formEffectiveSurvey.value) return null
  return Number((form.stageM + formEffectiveSurvey.value.zeroElevM).toFixed(3))
})

function safeIso(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString()
}

/** 当前定线号下的点据（含基面水位、曲线流量与残差） */
const pointRows = computed(() =>
  ratingStore.ratings
    .filter((rating) => rating.lineNo === ratingStore.activeLineNo)
    .sort((a, b) => (a.datumStageM ?? a.stageM) - (b.datumStageM ?? b.stageM))
    .map((rating) => {
      const datumStage = rating.datumStageM
      const usable = datumStage !== null && rating.datumStatus !== 'pending' && fit.value.valid
      const predicted = usable
        ? Number((fit.value.a * Math.pow(Math.max((datumStage as number) - fit.value.h0, 1e-6), fit.value.b)).toFixed(2))
        : 0
      const residualPct =
        usable && rating.flowM3s > 0
          ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
          : 0
      const compare = ratingStore.workingCompares.find((item) => item.ratingId === rating.id)
      return {
        rating,
        datumStage,
        stationName: ratingStore.stationNameOf(rating.stationId),
        predicted,
        residualPct,
        verdict:
          rating.datumStatus === 'pending'
            ? null
            : compare?.verdict ?? (Math.abs(residualPct) > ratingStore.deviationLimitPct ? '超限' : '合格')
      }
    })
)

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  verdicts: ratingStore.filter.verdicts
}))

/** 关系曲线坐标：横轴统一基面水位、纵轴流量；pending 点据不绘制在定线成果中 */
const chart = computed(() => {
  const rows = pointRows.value.filter((row) => row.datumStage !== null)
  if (rows.length === 0) {
    return { samples: '', points: [] as Array<{ id: string; cx: number; cy: number; verdict: string | null }>, stageMin: 0, stageMax: 0, flowMax: 0 }
  }
  const stages = rows.map((row) => row.datumStage as number)
  const flows = rows.map((row) => row.rating.flowM3s)
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const flowMax = Math.max(...flows) * 1.1
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  const toX = (stageM: number): number =>
    stageMax - stageMin < 1e-6 ? (left + right) / 2 : left + ((stageM - stageMin) / (stageMax - stageMin)) * (right - left)
  const toY = (flowM3s: number): number => bottom - (flowM3s / flowMax) * (bottom - top)
  const sampleCount = 13
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const stageM = stageMin + ((stageMax - stageMin) * index) / (sampleCount - 1 || 1)
    const value = fit.value.valid ? fit.value.a * Math.pow(Math.max(stageM - fit.value.h0, 1e-6), fit.value.b) : 0
    return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
  }).join(' ')
  return {
    samples,
    points: rows.map((row) => ({
      id: row.rating.id,
      cx: toX(row.datumStage as number),
      cy: toY(row.rating.flowM3s),
      verdict: row.verdict
    })),
    stageMin,
    stageMax,
    flowMax
  }
})

function openCreate(): void {
  editingId.value = null
  form.stationId = stationStore.currentStationId ?? stationStore.stations[0]?.id ?? ''
  form.lineNo = ratingStore.activeLineNo
  const last = pointRows.value[pointRows.value.length - 1]
  form.stageM = last ? Number((last.rating.stageM + 0.2).toFixed(2)) : 3
  form.flowM3s = last ? Number((last.rating.flowM3s * 1.2).toFixed(1)) : 50
  form.measureNo = `${new Date().getFullYear()}-${String(ratingStore.ratings.length + 1).padStart(3, '0')}`
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(rating: Rating): void {
  editingId.value = rating.id
  form.stationId = rating.stationId
  form.stageM = rating.stageM
  form.flowM3s = rating.flowM3s
  form.lineNo = rating.lineNo
  form.measureNo = rating.measureNo
  form.measuredAt = rating.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!Number.isFinite(form.stageM)) {
    ElMessage.warning('请填写水尺读数（m）')
    return
  }
  if (!Number.isFinite(form.flowM3s) || form.flowM3s <= 0) {
    ElMessage.warning('流量应为大于 0 的数字（m³/s）')
    return
  }
  const measuredAt = safeIso(form.measuredAt)
  const datum = ratingStore.resolveNewDatum(form.stationId, form.stageM, measuredAt)
  if (datum.datumStatus === 'pending') {
    ElMessage.warning(datum.datumNote + '，该点据暂不参与定线')
  }
  submitting.value = true
  try {
    const payload = {
      stationId: form.stationId,
      stageM: form.stageM,
      flowM3s: form.flowM3s,
      lineNo: form.lineNo.trim() || 'A',
      measureNo: form.measureNo.trim(),
      measuredAt,
      ...datum
    }
    if (editingId.value) {
      await ratingStore.updateRating(editingId.value, payload)
      ElMessage.success('点据已更新')
    } else {
      await ratingStore.createRating(payload)
      ElMessage.success(datum.datumStatus === 'pending' ? '点据已登记，待站上认定零点' : '点据已新增并按当时零点折算基面')
    }
    ratingStore.setActiveLine(payload.lineNo)
    dialogVisible.value = false
    await ratingStore.recomputeDatum()
  } catch {
    ElMessage.error('保存失败，请重试（站上水尺接测记录不受影响）')
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除水尺读数 ${rating.stageM.toFixed(2)} m 处的点据将同时删除其工作版比测记录，已报出版本的归档结论保留。确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeRating(rating.id)
  await ratingStore.recomputeDatum()
  ElMessage.success('点据已删除并重算定线')
}

/** 资料室侧重算（折基面 + 定线 + 比测判定）。失败从本侧重试，站上记录不动。 */
async function recompute(): Promise<void> {
  recomputing.value = true
  try {
    const result = await ratingStore.recomputeDatum()
    const lineResult = result.lines.find((item) => item.lineNo === ratingStore.activeLineNo)
    ElMessage.success(
      `基面重算完成：折算 ${result.ratingsRecalculated} 点（待站上认 ${result.pendingCount}、回填 ${result.backfilledCount}）；` +
        `当前线比测 ${lineResult?.compareCount ?? 0} 条`
    )
  } catch {
    ElMessage.error('重算失败，可再次点击重试；站上水尺接测记录不受影响')
  } finally {
    recomputing.value = false
  }
}

/** 报出当前定线：冻结为新版本 */
async function publishCurrent(): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('请填写本报出版本的说明（如：洪水后按新零点重算报出）', '报出定线版本', {
      confirmButtonText: '报出并冻结',
      cancelButtonText: '取消',
      inputValue: isStale.value ? '洪水后水尺重新接测，按测流当时零点折回同一基面重算' : '按当前点据定线报出',
      inputType: 'textarea'
    })
    publishing.value = true
    const version = await ratingStore.publishVersion(ratingStore.activeLineNo, value || '定线报出', '资料室')
    ElMessage.success(`${ratingStore.activeLineNo} 线 v${version.versionNo} 已报出，当时比测结论已冻结留档`)
  } catch (err) {
    if (err !== 'cancel' && err instanceof Error) ElMessage.error('报出失败，请重试')
  } finally {
    publishing.value = false
  }
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
  void ratingStore.recomputeDatum()
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  void router.replace({ query: {} })
}

function goGauge(): void {
  void router.push('/gauges')
}

function statusLabel(status: unknown): string {
  return DATUM_STATUS_LABEL[status as DatumStatus] ?? '—'
}
function statusTone(status: unknown): 'success' | 'warning' | 'danger' {
  return DATUM_STATUS_TONE[status as DatumStatus] ?? 'warning'
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  gaugeStore.start()
  const query = route.query
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: typeof query.stations === 'string' ? query.stations.split(',') : [],
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict.split(',').filter((item) => item === '合格' || item === '超限') as Array<'合格' | '超限'>)
        : []
  })
  void ratingStore.recomputeDatum()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系点据与定线（统一基面）</h2>
        <p class="gb-hint">
          录入值为站上水尺读数；按「测流当时那一次接测零点」折到同一基面后做幂函数拟合 Q = a×(H-H0)^b，
          残差超过 {{ ratingStore.deviationLimitPct }}% 自动挂红。零点改动后未定案的线需重算并重新报出。
        </p>
      </div>
      <div class="page__actions">
        <el-select
          :model-value="ratingStore.activeLineNo"
          class="page__line-select"
          @change="handleLineChange"
        >
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
        </el-select>
        <el-button :icon="Refresh" :loading="recomputing" @click="recompute">基面重算</el-button>
        <el-button :icon="DocumentChecked" :loading="publishing" @click="publishCurrent">报出版本</el-button>
        <el-button @click="archiveVisible = true">报出留档 ({{ activeVersions.length }})</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增点据</el-button>
      </div>
    </div>

    <el-alert
      v-if="isStale"
      type="warning"
      show-icon
      :closable="false"
      title="该线存在零点改动后尚未重新定案的点据：已按最新接测重折基面，请核对后点「报出版本」重新定案（旧报出版本仍可在「报出留档」中查看）。"
    />

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'stationIds',
          label: '测站',
          options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
        },
        { key: 'lineNos', label: '定线号', options: lineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })) },
        {
          key: 'verdicts',
          label: '判定',
          options: [
            { label: '合格', value: '合格' },
            { label: '超限', value: '超限' }
          ]
        }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="gb-stats-row">
      <StatBadge label="current 线点据" :value="pointRows.length" suffix="点" icon="DataLine" />
      <StatBadge
        label="定线系数 a"
        :value="fit.valid ? fit.a : '—'"
        :suffix="fit.valid ? `b=${fit.b}` : '未定线'"
        tone="info"
        icon="TrendCharts"
      />
      <StatBadge
        label="平均残差"
        :value="fit.valid ? fit.meanResidualPct : '—'"
        suffix="%"
        :tone="fit.valid && fit.meanResidualPct <= ratingStore.deviationLimitPct ? 'success' : 'warning'"
        icon="Histogram"
      />
      <StatBadge
        label="待站上认点据"
        :value="pointRows.filter((row) => row.rating.datumStatus === 'pending').length"
        suffix="点"
        :tone="pointRows.some((row) => row.rating.datumStatus === 'pending') ? 'danger' : 'success'"
        :icon="pointRows.some((row) => row.rating.datumStatus === 'pending') ? 'WarningFilled' : 'DataLine'"
      />
    </div>

    <el-alert
      v-if="!fit.valid"
      type="warning"
      show-icon
      :closable="false"
      :title="fit.message || '当前定线号下可定线点据不足（待站上认定零点的点据不参与），至少需要 3 个已折算点'"
    />
    <el-alert
      v-else
      type="success"
      show-icon
      :closable="false"
      :title="`${fit.lineNo} 线定线有效（统一基面）：Q = ${fit.a} × (H - ${fit.h0})^${fit.b}；样本 ${fit.sampleCount} 点，平均残差 ${fit.meanResidualPct}%，最大残差 ${fit.maxResidualPct}%`"
    />

    <el-alert
      v-if="ratingStore.pendingRatings.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="page__pending-alert"
    >
      <template #title>
        <span>有 {{ ratingStore.pendingRatings.length }} 个点据的测流时间对不上任何水尺接测零点，已挑出待站上认定。</span>
        <el-button size="small" type="danger" plain :icon="Warning" @click="goGauge">前往站上补接测</el-button>
      </template>
    </el-alert>

    <div class="page__grid">
      <EmptyPanel
        v-if="pointRows.length === 0"
        title="该定线号下还没有关系点据"
        description="录入水尺读数与流量点据，系统按测流当时零点折算基面后定线；时间对不上的点据交站上认定。"
        action-text="新增点据"
        @action="openCreate"
      />

      <el-table v-else :data="pointRows" border stripe class="gb-table-compact">
        <el-table-column label="水尺读数 (m)" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="基面水位 (m)" width="120" align="right">
          <template #default="{ row }">
            <span v-if="row.datumStage !== null" class="gb-mono">{{ row.datumStage.toFixed(3) }}</span>
            <span v-else class="page__muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="零点 (m)" width="100" align="right">
          <template #default="{ row }">
            <span v-if="row.rating.datumZeroElevM !== null" class="gb-mono">{{ row.rating.datumZeroElevM.toFixed(3) }}</span>
            <span v-else class="page__muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="基面状态" width="104" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTone(row.rating.datumStatus)" effect="plain">
              {{ statusLabel(row.rating.datumStatus) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="实测流量 (m³/s)" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.flowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="曲线流量 (m³/s)" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="残差 / 判定" width="200">
          <template #default="{ row }">
            <DeviationTag
              v-if="row.verdict"
              :deviation-pct="row.residualPct"
              :verdict="row.verdict"
              :limit="ratingStore.deviationLimitPct"
            />
            <el-tooltip v-else :content="row.rating.datumNote" placement="top">
              <el-tag type="danger" size="small">待站上认</el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="测站 / 测次" min-width="180">
          <template #default="{ row }">
            <div>{{ row.stationName }}</div>
            <div class="gb-hint gb-mono">{{ row.rating.measureNo || '未标记测次' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="点据时间" width="120">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.rating.measuredAt).toLocaleDateString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row.rating)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRating(row.rating)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ ratingStore.activeLineNo }} 线关系曲线（统一基面）</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="chart.points.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="40" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="282" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
          <polyline v-if="fit.valid" :points="chart.samples" fill="none" stroke="#0f4c75" stroke-width="2" />
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="point.verdict === '超限' ? '#c0392b' : '#7fd1e8'"
            :stroke="point.verdict === '超限' ? '#7b241c' : '#0f4c75'"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="已折算基面的点据才会参与曲线绘制；待站上认点据请先补接测。" compact />
        <p class="gb-hint">
          横轴为统一基面水位；红点为残差超限点据。
          <template v-if="activeLatestVersion">最近报出 v{{ activeLatestVersion.versionNo }}（{{ new Date(activeLatestVersion.publishedAt).toLocaleDateString('zh-CN') }}）。</template>
        </p>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑关系点据' : '新增关系点据'" width="560px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" placeholder="选择测站" class="page__full">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="定线号" required>
          <el-input v-model="form.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="水尺读数" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m（站上观测原值，零点起算）</span>
        </el-form-item>
        <el-form-item label="流量" required>
          <el-input-number v-model="form.flowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="测次号">
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="测流时间" required>
          <el-date-picker v-model="form.measuredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="选择时间" />
        </el-form-item>
        <el-alert
          v-if="formEffectiveSurvey"
          type="success"
          :closable="false"
          show-icon
          :title="`该时刻生效零点 ${formEffectiveSurvey.zeroElevM.toFixed(3)} m（${formEffectiveSurvey.surveyor}，${new Date(formEffectiveSurvey.surveyedAt).toLocaleDateString('zh-CN')} 接测），折到统一基面水位 ${formDatumPreview} m`"
        />
        <el-alert
          v-else
          type="error"
          :closable="false"
          show-icon
          title="该时刻在本站没有已生效的水尺接测记录，保存后将标记为「待站上认」，不参与定线；请先到站上登记接测。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存并重算' : '新增并折算' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 报出留档：历史版本连同当时比测结论可查 -->
    <el-drawer v-model="archiveVisible" title="报出定线版本留档" size="640px">
      <EmptyPanel
        v-if="activeVersions.length === 0"
        title="该线还没有报出版本"
        description="点「报出版本」后，当前定线参数与当时比测结论会冻结留档；零点再改也不影响已报出那版可查。"
        compact
      />
      <el-collapse v-else v-model="activeArchive" class="page__archive">
        <el-collapse-item
          v-for="version in activeVersions"
          :key="version.id"
          :name="version.id"
          :title="`v${version.versionNo} · ${version.lineNo} 线 · ${new Date(version.publishedAt).toLocaleString('zh-CN')}`"
        >
          <p class="gb-hint">{{ version.reason }} · 报出人 {{ version.publisher }}</p>
          <el-descriptions :column="2" border size="small">
            <el-descriptions-item label="定线公式">Q = {{ version.a }} × (H - {{ version.h0 }})^{{ version.b }}</el-descriptions-item>
            <el-descriptions-item label="样本点数">{{ version.sampleCount }}</el-descriptions-item>
            <el-descriptions-item label="平均残差">{{ version.meanResidualPct }}%</el-descriptions-item>
            <el-descriptions-item label="最大残差">{{ version.maxResidualPct }}%</el-descriptions-item>
            <el-descriptions-item label="R²">{{ version.r2 }}</el-descriptions-item>
            <el-descriptions-item label="是否有效">{{ version.valid ? '有效' : version.message }}</el-descriptions-item>
          </el-descriptions>
          <p class="gb-panel-title page__archive-subtitle">当时比测结论</p>
          <el-table :data="version.compares" size="small" border>
            <el-table-column label="基面水位" width="100" align="right">
              <template #default="{ row }">
                <span class="gb-mono">{{ (version.points.find((point) => point.ratingId === row.ratingId)?.datumStageM ?? 0).toFixed(3) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="实测" width="80" align="right">
              <template #default="{ row }">{{ row.measuredFlow.toFixed(1) }}</template>
            </el-table-column>
            <el-table-column label="曲线" width="80" align="right">
              <template #default="{ row }">{{ row.curveFlow.toFixed(1) }}</template>
            </el-table-column>
            <el-table-column label="偏差" align="right">
              <template #default="{ row }">
                <el-tag size="small" :type="row.verdict === '超限' ? 'danger' : 'success'">
                  {{ row.deviationPct > 0 ? '+' : '' }}{{ row.deviationPct }}%
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="verdict" label="判定" width="70" align="center" />
          </el-table>
        </el-collapse-item>
      </el-collapse>
    </el-drawer>
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

.page__line-select {
  width: 120px;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(520px, 1.5fr) minmax(320px, 1fr);
  gap: 14px;
  align-items: start;
}

.page__chart-card {
  border: 1px solid #d8e4ec;
}

.page__chart {
  width: 100%;
  height: 240px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__full {
  width: 100%;
}

.page__muted {
  color: #a0b0bc;
}

.page__pending-alert :deep(.el-alert__content) {
  display: flex;
  align-items: center;
  gap: 12px;
}

.page__archive-subtitle {
  margin: 10px 0 6px;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
