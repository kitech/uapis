import { defineConfig } from 'vitepress'

export default defineConfig({
  base: '/docs/',
  lang: 'zh-CN',
  title: 'uapis',
  description: '部署在单个 Cloudflare Worker 上的国外站点聚合 API',
  cleanUrls: true,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: '快速上手', link: '/guide/quickstart' },
      { text: '数据源', link: '/guide/providers' },
      { text: '限流与额度', link: '/guide/rate-limits' },
      { text: '合规', link: '/guide/compliance' },
    ],
    sidebar: [
      {
        text: '开始',
        items: [
          { text: '介绍', link: '/' },
          { text: '快速上手', link: '/guide/quickstart' },
          { text: '部署上线', link: '/guide/deployment' },
          { text: '数据源与凭据', link: '/guide/providers' },
        ],
      },
      {
        text: '使用',
        items: [
          { text: '限流与免费额度', link: '/guide/rate-limits' },
          { text: '错误与排障', link: '/guide/errors' },
          { text: '合规红线', link: '/guide/compliance' },
        ],
      },
      {
        text: '参考',
        items: [
          { text: '同类项目对照', link: '/reference/related-projects' },
          { text: '设计决策', link: '/reference/design-decisions' },
          { text: 'provider 审计', link: '/reference/provider-audit' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/' }],
    outline: [2, 3],
    search: { provider: 'local' },
    footer: {
      message: '内容版权归各上游站点作者所有。本项目与 uapis.cn 无任何关联。',
      copyright: 'MIT License',
    },
  },
})
