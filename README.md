# EventRail 多端埋点事件治理与发布评审平台

基于 Vue 3、TDesign、Pinia、Vue Router、TanStack Query、Axios、Vite 与 TypeScript 的独立前端工程。项目使用 Axios 自定义本地适配器模拟契约 API，查询缓存由 TanStack Query 管理，业务编辑状态由 Pinia 持久化到浏览器 `localStorage`。

## 功能

- 按业务域维护事件树、多端触发规则、属性和负责人
- 属性类型、枚举、必填条件、同义字段和跨事件血缘
- **按端采集矩阵：事件契约 × 平台规则 × 同义属性 × 下游依赖，各端分别登记停采/恢复、依据与生效时间**
- **某端启停变化后，该平台在评审中候选的迁移确认与审批立即失效，需重新确认**
- **两个窗口同时改同一端时后到者留下冲突草稿并看到冲突，按请求号重复提交幂等不新增审批**
- **写入失败从本地完整矩阵恢复，跨窗口通过 storage 事件同步完整矩阵**
- 重复事件、同义属性、命名越界、类型变化、删除字段引用、规则/矩阵不一致与停采端仍被消费检查
- JSON 示例的类型、枚举和必填规则校验
- 发布候选契约比较、按端受影响下游依赖（区分全量消费与按端消费）和迁移确认
- 数据、产品、客户端和测试四角色审批 + 各平台按端确认审批与发布门禁
- 事件废弃计划按端落到采集矩阵、替代事件和迁移说明
- 发布回滚留存按端矩阵快照并按矩阵对账、记录结果验证
- JSON/Markdown 契约导出显示各端采集状态，以及独立的矩阵 JSON 导出

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18474`。

## 构建

```bash
npm run build
```

## 数据层

- `src/services/api.ts`：Axios 实例与本地 API 适配器
- `src/composables/useGovernanceQueries.ts`：TanStack Query 查询组合
- `src/stores/governance.ts`：Pinia 编辑、审批、废弃和回滚状态
- `src/services/selectors.ts`：契约比较、影响分析和校验规则
