# 日和日语自习室

日和是一个在电脑上运行的日语自习网页，支持按课阅读、词汇与语法检索、卡片复习和小测验。课程和学习包由本机提供，构建后可以离线学习。进度、收藏、笔记和复习状态保存在当前浏览器的 IndexedDB 中，可以在应用内导出备份。

## 构建与运行

安装 **Node.js 22.12 或更新版本**。克隆仓库或下载并解压源码后，在项目根目录执行以下命令。首次安装依赖通常需要联网。

```powershell
npm.cmd ci
npm.cmd run build
```

构建脚本先执行 TypeScript 类型检查，再用 Vite 生成 `dist/`，同时将已发布的学习包复制到 `dist/packs/`。修改源码后，重新执行构建命令即可更新运行文件。

构建成功后，在 Windows 上双击 [`start-hiyori.bat`](./start-hiyori.bat)，或在项目根目录运行下列命令并用浏览器打开 <http://127.0.0.1:4173>。

```powershell
npm.cmd start
```

本地服务仅监听 `127.0.0.1:4173`。如果端口已被占用，关闭占用该端口的程序后重试。按 `Ctrl+C` 停止服务。

### 开发模式

安装依赖后，运行以下命令，并打开终端显示的本地地址。修改源码后，Vite 会自动更新页面。

```powershell
npm.cmd run dev
```

## 源码结构

| 路径 | 作用 |
| --- | --- |
| [`app/index.html`](./app/index.html)、[`app/src/main.tsx`](./app/src/main.tsx) | 网页入口，挂载 React 应用。 |
| [`app/src/App.tsx`](./app/src/App.tsx)、[`app/src/style.css`](./app/src/style.css) | 学习首页、教材、检索和个人记录界面，以及全局样式。 |
| [`app/src/store.ts`](./app/src/store.ts)、[`app/src/types.ts`](./app/src/types.ts) | 定义教材和学习记录的数据类型，通过 Dexie 访问 IndexedDB，并处理内容包导入、复习记录和备份。 |
| [`app/src/search-index.ts`](./app/src/search-index.ts)、[`app/src/content-links.ts`](./app/src/content-links.ts)、[`app/src/reference-levels.ts`](./app/src/reference-levels.ts) | 构建检索索引、关联课文中的词条，并按教材和 JLPT 等级筛选。 |
| [`app/src/study-plan.ts`](./app/src/study-plan.ts)、[`app/src/platform.ts`](./app/src/platform.ts) | 选择学习单元中的到期卡和新卡，封装日语点读和文件下载。 |
| [`app/public/packs/`](./app/public/packs)、[`content/book-packs.json`](./content/book-packs.json) | 存放运行时读取的学习包目录和 8 个已发布 ZIP，以及应用引用的课次和等级成员合并顺序。 |
| [`scripts/build.mjs`](./scripts/build.mjs)、[`scripts/serve.mjs`](./scripts/serve.mjs)、[`start-hiyori.bat`](./start-hiyori.bat) | 执行构建、提供 `dist/` 本地服务，以及在 Windows 上双击启动。 |
| [`package.json`](./package.json)、[`package-lock.json`](./package-lock.json)、[`tsconfig.json`](./tsconfig.json)、[`vite.config.ts`](./vite.config.ts) | 定义依赖、npm 命令、TypeScript 检查和 Vite 构建配置。 |
