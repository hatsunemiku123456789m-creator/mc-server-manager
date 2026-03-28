# mc-server-manager

An Electron application with React and TypeScript

## 自動更新（GitHub Releases）

呢個 app 已經加咗 `electron-updater`，打包後會自動檢查 GitHub Releases 嘅更新，下載完成會顯示「重啟更新」。

### 你要準備嘅環境變數

- `GH_TOKEN`：有權發 release/上傳 asset 嘅 GitHub token（build 機用，唔好寫死入 repo）
- `GH_OWNER`：GitHub repo owner
- `GH_REPO`：GitHub repo 名

### 發佈新版

1. 提升 `package.json` 嘅 version
2. 打包並發佈到 GitHub Releases（Windows）

```bash
npm run build:win
```

打包產物會喺 `dist3/`，將 `mc-server-manager-*-setup.exe`、`latest.yml` 同 blockmap 一齊上傳到同一個 release。

注意：如果 `GH_OWNER/GH_REPO` 冇設定，build 會用 placeholder，打出嚟嘅 app 會檢查唔到更新；正式發佈請務必設定好。

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
