<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h2 class="page-title">用户管理</h2>
        <p class="page-sub">维护网关账号、角色与账户余额</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">创建用户</el-button>
    </header>

    <section class="tech-card toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索邮箱 / 名称"
        :prefix-icon="Search"
        clearable
        class="search"
        @input="loadUsers()"
      />
      <el-select v-model="roleFilter" placeholder="角色" clearable class="filter" @change="loadUsers()">
        <el-option label="管理员" value="ADMIN" />
        <el-option label="普通用户" value="USER" />
      </el-select>
      <el-button :icon="Refresh" circle @click="loadUsers" />
    </section>

    <section class="tech-card table-card">
      <el-table v-loading="loading" :data="filtered" style="width: 100%">
        <template #empty>
          <el-empty description="暂无用户" :image-size="80" />
        </template>
        <el-table-column prop="id" label="ID" width="64" class-name="font-mono" />
        <el-table-column label="工号" width="120" class-name="font-mono">
          <template #default="{ row }">
            <span>{{ row.employeeId || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="姓名" min-width="110">
          <template #default="{ row }">
            <span class="u-name">{{ row.name || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="手机" width="130" class-name="font-mono">
          <template #default="{ row }">
            <span>{{ row.phone || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="邮箱" min-width="200" class-name="font-mono">
          <template #default="{ row }">
            <span class="u-mail">{{ row.email || '（无邮箱）' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="部门" min-width="120">
          <template #default="{ row }">
            <span>{{ row.department || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="角色" width="110">
          <template #default="{ row }">
            <el-tag :type="row.role === 'ADMIN' ? 'danger' : 'info'" effect="dark" disable-transitions>
              {{ row.role === 'ADMIN' ? '管理员' : '用户' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="余额" width="130" class-name="font-mono">
          <template #default="{ row }">
            <span class="balance">${{ Number(row.balance).toFixed(4) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="170">
          <template #default="{ row }">
            <span class="date font-mono">{{ fmtDate(row.createdAt) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" align="right">
          <template #default="{ row }">
            <el-tooltip content="编辑">
              <el-button text :icon="Edit" class="row-btn" @click="openEdit(row)" />
            </el-tooltip>
            <el-tooltip content="删除">
              <el-button text type="danger" :icon="Delete" class="row-btn" @click="handleDelete(row)" />
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog v-model="createOpen" title="创建用户" width="440px" destroy-on-close>
      <el-form ref="createRef" :model="form" :rules="rules" label-width="80px">
        <el-form-item label="邮箱" prop="email">
          <el-input v-model="form.email" placeholder="user@example.com" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="form.password" type="password" show-password placeholder="至少 6 位" />
        </el-form-item>
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" maxlength="20" />
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="form.role">
            <el-radio-button value="USER">普通用户</el-radio-button>
            <el-radio-button value="ADMIN">管理员</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createOpen = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleCreate">创建</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="editOpen" title="编辑用户" width="440px" destroy-on-close>
      <el-form :model="editForm" label-width="80px">
        <el-form-item label="邮箱">
          <el-input v-model="editForm.email" />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="editForm.name" />
        </el-form-item>
        <el-form-item label="角色">
          <el-radio-group v-model="editForm.role">
            <el-radio-button value="USER">普通用户</el-radio-button>
            <el-radio-button value="ADMIN">管理员</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="余额">
          <el-input-number v-model="editForm.balance" :min="0" :step="10" :precision="4" controls-position="right" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editOpen = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleUpdate">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { Plus, Search, Refresh, Edit, Delete } from '@element-plus/icons-vue';
import api from '../api';

const users = ref<any[]>([]);
const loading = ref(false);
const submitting = ref(false);
const keyword = ref('');
const roleFilter = ref('');

const createOpen = ref(false);
const editOpen = ref(false);
const createRef = ref<FormInstance>();
const form = ref({ email: '', password: '', name: '', role: 'USER' });
const editForm = ref<any>({});

const rules: FormRules = {
  email: [
    { required: true, message: '请输入邮箱', trigger: 'blur' },
    { type: 'email', message: '邮箱格式不正确', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' }
  ],
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }]
};

const filtered = computed(() => users.value.filter(u =>
  (!roleFilter.value || u.role === roleFilter.value) &&
  (!keyword.value || u.email?.includes(keyword.value) || u.name?.includes(keyword.value))
));

const fmtDate = (s: string) => new Date(s).toLocaleString('zh-CN', { hour12: false });

const loadUsers = async () => {
  loading.value = true;
  try {
    const { data } = await api.get('/api/users');
    users.value = data;
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || '加载失败');
  } finally {
    loading.value = false;
  }
};

const openCreate = () => {
  form.value = { email: '', password: '', name: '', role: 'USER' };
  createOpen.value = true;
};

const handleCreate = async () => {
  if (!createRef.value) return;
  const ok = await createRef.value.validate().catch(() => false);
  if (!ok) return;
  submitting.value = true;
  try {
    await api.post('/api/users', form.value);
    ElMessage.success('已创建');
    createOpen.value = false;
    loadUsers();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || '创建失败');
  } finally {
    submitting.value = false;
  }
};

const openEdit = (row: any) => {
  editForm.value = { ...row };
  editOpen.value = true;
};

const handleUpdate = async () => {
  submitting.value = true;
  try {
    await api.put(`/api/users/${editForm.value.id}`, editForm.value);
    ElMessage.success('已保存');
    editOpen.value = false;
    loadUsers();
  } catch (e: any) {
    ElMessage.error(e.response?.data?.error || '保存失败');
  } finally {
    submitting.value = false;
  }
};

const handleDelete = async (row: any) => {
  try {
    await ElMessageBox.confirm(`确定删除用户「${row.name || row.email}」吗？该操作不可恢复。`, '删除确认', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消'
    });
    await api.delete(`/api/users/${row.id}`);
    ElMessage.success('已删除');
    loadUsers();
  } catch (e: any) {
    if (e !== 'cancel') ElMessage.error(e.response?.data?.error || '删除失败');
  }
};

onMounted(loadUsers);
</script>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-bottom: 18px;
}
.page-title {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  color: var(--text-1);
}
.page-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-3);
}
.toolbar {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 14px 16px;
  margin-bottom: 16px;
}
.search { max-width: 280px; }
.filter { width: 130px; }
.table-card { padding: 6px 8px; }

.u-name { font-weight: 500; color: var(--text-1); }
.u-mail { font-size: 12px; color: var(--text-3); }

.balance { color: #a5f3fc; font-weight: 600; }
.date { font-size: 12px; color: var(--text-2); }
.row-btn { padding: 6px; }
</style>
