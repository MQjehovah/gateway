<template>
    <div class="page">
      <header class="page-head">
        <div>
          <h2 class="page-title">账户与账单</h2>
          <p class="page-sub">额度、消费流水与月结账单</p>
        </div>
        <el-button v-if="authStore.isAdmin" type="primary" :icon="Plus" @click="openRecharge">充值</el-button>
      </header>

    <div class="banner tech-card">
      <div class="banner-item">
        <span class="b-label">当前余额</span>
        <span class="b-value font-mono">${{ balance.toFixed(4) }}</span>
      </div>
      <div class="banner-item">
        <span class="b-label">本月消费</span>
        <span class="b-value font-mono">${{ monthCost.toFixed(4) }}</span>
      </div>
      <div class="banner-item">
        <span class="b-label">待付账单</span>
        <span class="b-value font-mono">{{ pendingBills }}</span>
      </div>
    </div>

    <div class="split">
      <section class="tech-card table-card">
        <h3 class="sec-title">交易流水</h3>
        <el-table v-loading="loading" :data="transactions" style="width: 100%" max-height="420">
          <template #empty>
            <el-empty description="暂无交易记录" :image-size="70" />
          </template>
          <el-table-column label="类型" width="96">
            <template #default="{ row }">
              <el-tag :type="txTag(row.type)" effect="dark" disable-transitions>{{ txLabel(row.type) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="金额" width="120" align="right" class-name="font-mono">
            <template #default="{ row }">
              <span :class="['amount', row.type === 'RECHARGE' ? 'up' : 'down']">
                {{ row.type === 'RECHARGE' ? '+' : row.type === 'REFUND' ? '+' : '-' }}${{ Number(row.amount).toFixed(4) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="余额" width="120" align="right" class-name="font-mono">
            <template #default="{ row }">${{ Number(row.balance).toFixed(4) }}</template>
          </el-table-column>
          <el-table-column prop="description" label="描述" min-width="140" show-overflow-tooltip />
          <el-table-column label="时间" width="150">
            <template #default="{ row }"><span class="date font-mono">{{ fmtDate(row.createdAt) }}</span></template>
          </el-table-column>
        </el-table>
      </section>

      <section class="tech-card table-card">
        <h3 class="sec-title">账单</h3>
        <el-table v-loading="loading" :data="bills" style="width: 100%" max-height="420">
          <template #empty>
            <el-empty description="暂无账单" :image-size="70" />
          </template>
          <el-table-column label="用户" min-width="130">
            <template #default="{ row }">{{ row.user?.name || '—' }}</template>
          </el-table-column>
          <el-table-column label="账期" min-width="150">
            <template #default="{ row }">
              <span class="font-mono">{{ fmtDate(row.periodStart).slice(0, 10) }} ~ {{ fmtDate(row.periodEnd).slice(0, 10) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="费用" width="110" align="right" class-name="font-mono">
            <template #default="{ row }">${{ Number(row.totalCost).toFixed(4) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="billTag(row.status)" effect="dark" disable-transitions>{{ billLabel(row.status) }}</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>

    <el-dialog v-model="rechargeOpen" title="账户充值" width="440px">
      <el-form label-width="80px" @submit.prevent="handleRecharge">
        <el-form-item label="充值对象">
          <el-select
            v-model="rechargeForm.userId"
            filterable
            clearable
            :loading="usersLoading"
            placeholder="默认：给自己充值"
            style="width: 100%"
          >
            <el-option
              v-for="u in users"
              :key="u.id"
              :label="`${u.name || u.email}（${u.email}，余额 $${Number(u.balance || 0).toFixed(2)}）`"
              :value="u.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="金额">
          <el-input-number v-model="rechargeForm.amount" :min="1" :step="50" :precision="2" controls-position="right" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="rechargeForm.description" placeholder="可选，例如：团队季度预算" maxlength="40" />
        </el-form-item>
        <el-alert type="info" :closable="false" title="演示环境为即时到账，生产环境可接入支付渠道" class="alert" />
      </el-form>
      <template #footer>
        <el-button @click="rechargeOpen = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleRecharge">确认充值</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Plus } from '@element-plus/icons-vue';
import { useAuthStore } from '../stores/auth';
import api from '../api';

const authStore = useAuthStore();
const transactions = ref<any[]>([]);
const bills = ref<any[]>([]);
const loading = ref(false);
const submitting = ref(false);
const rechargeOpen = ref(false);
const users = ref<any[]>([]);
const usersLoading = ref(false);
const rechargeForm = ref<{ amount: number; description: string; userId: number | null }>({
  amount: 100,
  description: '',
  userId: null
});

const openRecharge = async () => {
  rechargeOpen.value = true;
  rechargeForm.value.userId = null;
  usersLoading.value = true;
  try {
    const res = await api.get('/api/users');
    users.value = res.data;
  } catch {
    users.value = [];
  } finally {
    usersLoading.value = false;
  }
};

const balance = computed(() => Number(authStore.user?.balance ?? 0));
const monthCost = computed(() => bills.value.filter(b => b.status !== 'PENDING' || true).reduce((s, b) => s + Number(b.totalCost || 0), 0));
const pendingBills = computed(() => bills.value.filter(b => b.status === 'PENDING').length);

const txLabel = (t: string) => ({ RECHARGE: '充值', CONSUMPTION: '消费', REFUND: '退款' })[t] || t;
const txTag = (t: string) => ({ RECHARGE: 'success', CONSUMPTION: 'info', REFUND: 'warning' })[t] || 'info';
const billLabel = (s: string) => ({ PENDING: '待付', PAID: '已付', OVERDUE: '逾期' })[s] || s;
const billTag = (s: string) => ({ PENDING: 'warning', PAID: 'success', OVERDUE: 'danger' })[s] || 'info';
const fmtDate = (s: string) => new Date(s).toLocaleString('zh-CN', { hour12: false });

const loadData = async () => {
  loading.value = true;
  try {
    const [transRes, billsRes, meRes] = await Promise.all([
      api.get('/api/transactions'),
      api.get('/api/bills'),
      api.get('/api/auth/me')
    ]);
    transactions.value = transRes.data;
    bills.value = billsRes.data;
    authStore.user = meRes.data;
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || '加载失败');
  } finally {
    loading.value = false;
  }
};

  const handleRecharge = async () => {
    // 前端隐藏入口 + 这里兜底：充值仅管理员可用（后端同样有校验）
    if (!authStore.isAdmin) {
      ElMessage.warning('仅管理员可为账号充值');
      return;
    }
    if (rechargeForm.value.amount <= 0) return;
  submitting.value = true;
  try {
    const target = rechargeForm.value.userId
      ? users.value.find((u) => u.id === rechargeForm.value.userId)
      : null;
    await api.post('/api/transactions/recharge', {
      amount: rechargeForm.value.amount,
      description: rechargeForm.value.description,
      ...(target ? { userId: target.id } : {})
    });
    ElMessage.success(
      target
        ? `已为 ${target.name || target.email} 充值 $${rechargeForm.value.amount}`
        : '充值成功'
    );
    rechargeOpen.value = false;
    rechargeForm.value.description = '';
    rechargeForm.value.userId = null;
    loadData();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || '充值失败');
  } finally {
    submitting.value = false;
  }
};

onMounted(loadData);
</script>

<style scoped>
.page-head { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 18px; }
.page-title { margin: 0; font-size: 22px; font-weight: 700; color: var(--text-1); }
.page-sub { margin: 4px 0 0; font-size: 13px; color: var(--text-3); }

.banner {
  display: flex;
  gap: 48px;
  padding: 20px 26px;
  margin-bottom: 16px;
}
.banner-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.b-label {
  font-size: 12px;
  color: var(--text-3);
  letter-spacing: 0.06em;
}
.b-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--text-1);
}

.split {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 16px;
}
@media (max-width: 1100px) { .split { grid-template-columns: 1fr; } }

.table-card { padding: 18px; }
.sec-title {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-1);
}
.amount { font-weight: 600; }
.amount.up { color: #6ee7b7; }
.amount.down { color: #fda4af; }
.date { font-size: 12px; color: var(--text-2); }

.alert { margin-bottom: 4px; }
</style>
