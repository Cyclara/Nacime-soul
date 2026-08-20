// src/renderer/src/router.ts
// P2-31: vue-router hash 模式路由。依据 S-006 §1.1。
// 聊天为主、其余为浮层/抽屉：/ 主界面（常驻），/memory 记忆面板，/growth 成长页。
// 设置 = 模态抽屉（不占路由），调试面板 = 全局浮层（Ctrl+Shift+D，不占路由）。

import { createRouter, createWebHashHistory } from 'vue-router'
import ChatView from './views/ChatView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'chat', component: ChatView },
    {
      path: '/memory',
      name: 'memory',
      // 懒加载：记忆面板非首屏，减少初始包体积
      component: () => import('./views/MemoryView.vue')
    },
    {
      path: '/growth',
      name: 'growth',
      component: () => import('./views/GrowthView.vue')
    },
    {
      path: '/dmae',
      name: 'dmae',
      // P2-32: DMAE 可视化面板（F5-002）。懒加载非首屏
      component: () => import('./views/DmaePanelView.vue')
    }
  ]
})

export default router
