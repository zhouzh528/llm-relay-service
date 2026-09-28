<template>
  <div class="apple-landing start-page">
    <!-- Nav -->
    <PublicNav active="start" />

    <!-- Hero -->
    <section class="start-hero">
      <div class="start-hero__inner reveal">
        <p class="start-hero__eyebrow">快速开始</p>
        <h1 class="start-hero__title">几分钟内，接入所有主流 AI。</h1>
        <p class="start-hero__sub">按照以下步骤，在本地完成安装并开始使用 Relay Service。</p>
      </div>
    </section>

    <!-- Steps -->
    <section class="steps">
      <div class="steps__grid">
        <article v-for="(step, idx) in steps" :key="idx" class="step reveal">
          <div class="step__number">{{ idx + 1 }}</div>
          <h3 class="step__title">{{ step.title }}</h3>
          <p class="step__desc">{{ step.desc }}</p>
          <div v-if="step.code" class="step__code">
            <code>{{ step.code }}</code>
          </div>
          <router-link v-if="step.link" class="step__link" :to="step.link.to">
            {{ step.link.text }} ›
          </router-link>
        </article>
      </div>
    </section>

    <!-- Service management -->
    <section class="ops">
      <div class="ops__inner reveal">
        <p class="ops__eyebrow">部署与运维</p>
        <h2 class="ops__title">管理你的服务</h2>
        <p class="ops__sub">
          元数据默认持久化到 SQLite（<code>data/metadata.db</code>），Redis 仅作缓存与热状态。服务由
          systemd 托管（<code>relay-service</code>）：
        </p>
        <div class="ops__grid">
          <article v-for="cmd in serviceCommands.linux" :key="cmd.code" class="ops__card">
            <h3 class="ops__card-title">{{ cmd.title }}</h3>
            <p class="ops__card-desc">{{ cmd.desc }}</p>
            <div class="ops__code">
              <code>{{ cmd.code }}</code>
              <button
                :aria-label="copiedCode === cmd.code ? '已复制' : '复制命令'"
                class="ops__copy"
                :class="{ 'ops__copy--copied': copiedCode === cmd.code }"
                :title="copiedCode === cmd.code ? '已复制' : '复制命令'"
                type="button"
                @click="copyCommand(cmd.code)"
              >
                <i :class="copiedCode === cmd.code ? 'fas fa-check' : 'fas fa-copy'" />
              </button>
            </div>
          </article>
        </div>
      </div>
    </section>

    <!-- Claude Code via GPT -->
    <section class="ops">
      <div class="ops__inner reveal">
        <p class="ops__eyebrow">进阶用法</p>
        <h2 class="ops__title">让 Claude Code 用上 GPT</h2>
        <p class="ops__sub">
          让 Claude Code（Anthropic 协议）由 GPT（OpenAI Chat Completions
          兼容端点）承载推理，无需改客户端。
        </p>
        <ol class="gpt-steps">
          <li>
            控制台 <strong>账号管理 → OpenAI Compatible</strong> 创建账号，填写 baseUrl / apiKey /
            默认模型 /（可选）模型映射。
          </li>
          <li>给要使用的 API Key 勾选 <code>openai</code> 权限。</li>
          <li>把 Claude Code 指向适配前缀：</li>
        </ol>
        <div class="ops__code">
          <code>{{ gptBaseUrlCmd }}</code>
          <button
            :aria-label="copiedCode === gptBaseUrlCmd ? '已复制' : '复制命令'"
            class="ops__copy"
            :class="{ 'ops__copy--copied': copiedCode === gptBaseUrlCmd }"
            :title="copiedCode === gptBaseUrlCmd ? '已复制' : '复制命令'"
            type="button"
            @click="copyCommand(gptBaseUrlCmd)"
          >
            <i :class="copiedCode === gptBaseUrlCmd ? 'fas fa-check' : 'fas fa-copy'" />
          </button>
        </div>
        <p class="gpt-note">
          目标模型解析顺序：请求头 <code>x-target-model</code> → 账号模型映射（支持 * 前缀）→
          默认模型；客户端的 claude-* 名不会透传给上游。
        </p>
      </div>
    </section>

    <!-- CTA -->
    <section class="start-cta">
      <div class="start-cta__inner reveal">
        <h2>准备好了？</h2>
        <p>进入控制台创建 API Key，开始使用。</p>
        <div class="start-cta__buttons">
          <router-link class="btn btn--primary btn--lg" to="/login">进入控制台</router-link>
          <router-link class="btn btn--ghost btn--lg" to="/api-stats">查看实时数据 ›</router-link>
        </div>
      </div>
    </section>

    <PublicFooter />
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import PublicFooter from '@/components/public/PublicFooter.vue'
import PublicNav from '@/components/public/PublicNav.vue'
import { copyText } from '@/utils/tools'

const steps = [
  {
    title: '获取 API Key',
    desc: '登录管理控制台，在 API Keys 页面创建你的专属 Key（以 cr_ 开头）。',
    link: { to: '/login', text: '前往控制台' }
  },
  {
    title: '获取接入 AI 账户',
    desc: '在控制台添加 Claude、Gemini、OpenAI 等平台的账户凭据，系统将自动管理和调度。',
    link: { to: '/login', text: '管理账户' }
  },
  {
    title: '选择 CLI 工具',
    desc: '支持 Claude Code、Codex、Gemini CLI、Droid CLI 等主流 CLI 工具。',
    link: { to: '/tutorial', text: '查看使用教程' }
  },
  {
    title: '开始对话',
    desc: '一切就绪。你的请求将被智能调度到最佳可用账户。',
    code: 'curl -X POST /api/v1/chat/completions ...'
  }
]

// Claude Code → GPT 适配的客户端配置命令
const gptBaseUrlCmd = 'export ANTHROPIC_BASE_URL=http://<host>:<port>/claude/openai'

// Linux: 跨平台进程管理脚本 scripts/manage.js（PID + nohup）
const serviceCommands = {
  linux: [
    {
      title: '启动',
      desc: '在后台启动服务进程，终端可安全关闭。',
      code: 'npm run service:start:daemon'
    },
    {
      title: '停止',
      desc: '优雅停止服务，超时后自动强制结束。',
      code: 'npm run service:stop'
    },
    {
      title: '重启',
      desc: '停止后重新启动，加载最新配置。',
      code: 'npm run service:restart'
    },
    {
      title: '状态',
      desc: '查看服务运行状态与进程信息。',
      code: 'npm run service:status'
    },
    {
      title: '更新',
      desc: '拉取最新代码 → 安装依赖 → 构建前端 → 自动后台重启。',
      code: 'npm run service:update'
    }
  ]
}

const copiedCode = ref('')
let copyResetTimer = null
const copyCommand = async (code) => {
  const ok = await copyText(code, '命令已复制')
  if (!ok) {
    return
  }
  copiedCode.value = code
  if (copyResetTimer) {
    clearTimeout(copyResetTimer)
  }
  copyResetTimer = setTimeout(() => {
    copiedCode.value = ''
  }, 1600)
}

let observer

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('reveal--in')
          observer.unobserve(entry.target)
        }
      })
    },
    { threshold: 0.12 }
  )
  document.querySelectorAll('.reveal').forEach((el) => observer.observe(el))
})

onBeforeUnmount(() => {
  observer && observer.disconnect()
  if (copyResetTimer) {
    clearTimeout(copyResetTimer)
  }
})
</script>

<style scoped>
.start-page {
  font-family:
    -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue',
    'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  background: #fbfbfd;
  color: #1d1d1f;
  -webkit-font-smoothing: antialiased;
  letter-spacing: -0.015em;
  min-height: 100vh;
}

/* Reveal */
.reveal {
  opacity: 0;
  transform: translateY(30px);
  transition:
    opacity 0.9s cubic-bezier(0.16, 1, 0.3, 1),
    transform 0.9s cubic-bezier(0.16, 1, 0.3, 1);
}
.reveal--in {
  opacity: 1;
  transform: translateY(0);
}

/* Hero */
.start-hero {
  padding: 130px 22px 60px;
  text-align: center;
  max-width: 980px;
  margin: 0 auto;
}
.start-hero__eyebrow {
  font-size: 17px;
  font-weight: 500;
  color: #0071e3;
  margin: 0 0 8px;
}
.start-hero__title {
  font-size: clamp(36px, 5vw, 56px);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.08;
  margin: 0 0 16px;
  background: linear-gradient(180deg, #1d1d1f 0%, #2d2d33 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.start-hero__sub {
  font-size: 19px;
  color: #6e6e73;
  margin: 0;
}

/* Steps */
.steps {
  max-width: 1100px;
  margin: 0 auto;
  padding: 40px 22px 100px;
}
.steps__grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}
.step {
  background: #fff;
  border-radius: 22px;
  padding: 36px;
  border: 1px solid rgba(0, 0, 0, 0.04);
  transition: transform 0.3s ease;
}
.step:hover {
  transform: translateY(-2px);
}
.step__number {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #1d1d1f;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 16px;
}
.step__title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0 0 10px;
  color: #1d1d1f;
}
.step__desc {
  font-size: 15px;
  color: #6e6e73;
  line-height: 1.5;
  margin: 0 0 16px;
}
.step__code {
  padding: 12px 16px;
  background: #f5f5f7;
  border-radius: 10px;
  margin-bottom: 12px;
}
.step__code code {
  font-size: 14px;
  color: #1d1d1f;
  font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
}
.step__link {
  font-size: 15px;
  color: #0071e3;
  text-decoration: none;
  font-weight: 500;
}
.step__link:hover {
  text-decoration: underline;
}
@media (max-width: 720px) {
  .steps__grid {
    grid-template-columns: 1fr;
  }
}

/* Service management */
.ops {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 22px 100px;
}
.ops__eyebrow {
  font-size: 15px;
  font-weight: 600;
  color: #0071e3;
  margin: 0 0 8px;
}
.ops__title {
  font-size: clamp(28px, 4vw, 40px);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: #1d1d1f;
  margin: 0 0 12px;
}
.ops__sub {
  font-size: 17px;
  color: #6e6e73;
  line-height: 1.5;
  margin: 0 0 28px;
  max-width: 720px;
}
.ops__sub code {
  font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 14px;
  background: #f5f5f7;
  padding: 2px 6px;
  border-radius: 6px;
}
.ops__tabs {
  display: inline-flex;
  gap: 6px;
  padding: 4px;
  background: #f5f5f7;
  border-radius: 12px;
  margin-bottom: 24px;
}
.ops__tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  color: #6e6e73;
  font-size: 15px;
  font-weight: 500;
  padding: 8px 18px;
  border-radius: 9px;
  cursor: pointer;
  transition:
    background 0.2s ease,
    color 0.2s ease,
    box-shadow 0.2s ease;
}
.ops__tab--active {
  background: #fff;
  color: #1d1d1f;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
.ops__grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
}
.ops__card {
  background: #fff;
  border-radius: 22px;
  padding: 28px;
  border: 1px solid rgba(0, 0, 0, 0.04);
}
.ops__card-title {
  font-size: 19px;
  font-weight: 700;
  color: #1d1d1f;
  margin: 0 0 8px;
}
.ops__card-desc {
  font-size: 15px;
  color: #6e6e73;
  line-height: 1.5;
  margin: 0 0 14px;
}
.ops__code {
  position: relative;
  padding: 12px 48px 12px 16px;
  background: #f5f5f7;
  border-radius: 10px;
}
.ops__code code {
  display: block;
  font-size: 14px;
  color: #1d1d1f;
  font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
  line-height: 1.5;
  word-break: break-all;
}
.ops__copy {
  position: absolute;
  top: 8px;
  right: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.05);
  color: #6e6e73;
  font-size: 13px;
  cursor: pointer;
  transition:
    background 0.2s ease,
    color 0.2s ease;
}
.ops__copy:hover {
  background: rgba(0, 0, 0, 0.1);
  color: #1d1d1f;
}
.ops__copy--copied {
  background: #34c759;
  color: #fff;
}
.gpt-steps {
  margin: 0 0 20px;
  padding-left: 22px;
  max-width: 720px;
  color: #1d1d1f;
  font-size: 16px;
  line-height: 1.7;
}
.gpt-steps li {
  margin-bottom: 8px;
}
.gpt-steps code,
.gpt-note code {
  font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  background: #f5f5f7;
  padding: 2px 6px;
  border-radius: 6px;
}
.gpt-note {
  margin: 16px 0 0;
  max-width: 720px;
  font-size: 14px;
  color: #6e6e73;
  line-height: 1.6;
}
@media (max-width: 720px) {
  .ops__grid {
    grid-template-columns: 1fr;
  }
}

/* CTA */
.start-cta {
  padding: 100px 22px;
  text-align: center;
  background: linear-gradient(180deg, #fbfbfd 0%, #f5f5f7 100%);
}
.start-cta__inner h2 {
  font-size: clamp(36px, 5vw, 56px);
  font-weight: 700;
  letter-spacing: -0.03em;
  margin: 0 0 12px;
  line-height: 1.1;
}
.start-cta__inner p {
  font-size: 19px;
  color: #6e6e73;
  margin: 0 0 32px;
}
.start-cta__buttons {
  display: flex;
  gap: 16px;
  justify-content: center;
  flex-wrap: wrap;
}

/* Buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 12px 22px;
  border-radius: 980px;
  font-size: 17px;
  font-weight: 400;
  text-decoration: none;
  transition: all 0.2s ease;
  cursor: pointer;
  border: none;
}
.btn--primary {
  background: #0071e3;
  color: #fff;
}
.btn--primary:hover {
  background: #0077ed;
  transform: scale(1.02);
}
.btn--ghost {
  background: transparent;
  color: #0071e3;
}
.btn--ghost:hover {
  text-decoration: underline;
}
.btn--lg {
  padding: 14px 28px;
  font-size: 19px;
}
/* ---------- 暗色变体 ----------
 * 本页原无任何暗色规则，深色模式下整页为浅底。仅覆盖表面、文字与边框；
 * .step__number 与 .btn--primary 为刻意的深色/品牌色块，保持不变。
 */
.dark .start-page {
  background: #0b1220;
  color: #f3f4f6;
}
.dark .start-hero__title {
  background: linear-gradient(180deg, #f9fafb 0%, #d1d5db 100%);
  -webkit-background-clip: text;
  background-clip: text;
}
.dark .step,
.dark .ops__card {
  background: #1f2937;
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.dark .step__title,
.dark .ops__title,
.dark .ops__card-title,
.dark .gpt-steps,
.dark .ops__tab--active {
  color: #f3f4f6;
}
.dark .step__code,
.dark .ops__code,
.dark .ops__sub code,
.dark .gpt-note code,
.dark .ops__tabs {
  background: #111827;
}
.dark .step__code code,
.dark .ops__code code {
  color: #e5e7eb;
}
.dark .ops__tab--active {
  background: #1f2937;
}
.dark .ops__copy {
  background: rgba(255, 255, 255, 0.08);
  color: #9ca3af;
}
.dark .ops__copy:hover {
  color: #f3f4f6;
}
.dark .start-cta {
  background: linear-gradient(180deg, #0b1220 0%, #111827 100%);
}
</style>
