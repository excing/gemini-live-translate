cf workers 后端代码入口在 `index.js`
cf 前端代码代码入口在 `public/index.html`
`core` 目录的作用是与前端无关的后端核心代码
`public/utils` 目录是前后端通用代码
前端UI设计原则: 响应式, 支持深浅色模式, 高级极简设计, 除按钮, 波形动画和系统消息可以少量使用渐变色外, 其他地方一律禁止使用渐变色
前端技术栈: vue3 cdn
后端技术栈: cf workers + hono