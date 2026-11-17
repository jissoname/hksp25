# HKSP Design System · 校園印信報

> 依 web-design-skill / Impeccable 流程：先宣告 tokens，再實作。  
> 產品：弘光社團資訊平台（學生議會 · 社團評選）  
> Logo：`bg-logo.png`（HKSP 法槌印信）

## Design Read

- **artifact**: campus evaluation portal（登入 + 時程 + 公告）
- **audience**: 社團幹部／評審／學生議會行政
- **visual-language**: 校園印信報 — 紙面公告、印信主視覺、細線分隔
- **mode**: redesign · preserve function IDs
- **dials**: visual-variance 4 · motion-intensity 2 · information-density 6 · asset-dependence 8 · brand-fidelity 9

## Palette（oklch · hue 家族）

| Token | Role | oklch |
| --- | --- | --- |
| `--hk-paper` | 頁面底 | `oklch(98.2% 0.004 250)` |
| `--hk-bg` | 次底 | `oklch(95.5% 0.006 250)` |
| `--hk-card` | 互動卡（登入） | `oklch(100% 0 0)` |
| `--hk-soft` | 淺襯底 | `oklch(93.5% 0.01 250)` |
| `--hk-ink` | 正文 | `oklch(27% 0.02 255)` |
| `--hk-navy` | 主色／標題／按鈕 | `oklch(24% 0.035 255)` |
| `--hk-navy-2` | hover | `oklch(32% 0.04 255)` |
| `--hk-muted` | 次要文字 | `oklch(50% 0.018 250)` |
| `--hk-line` | 分隔線 | `oklch(89% 0.008 250)` |
| `--hk-accent` | 連結／焦點 | `oklch(42% 0.065 200)` |
| `--hk-ok` | 成功 | `oklch(45% 0.09 150)` |
| `--hk-warn` | 警示 | `oklch(55% 0.11 75)` |
| `--hk-danger` | 錯誤 | `oklch(50% 0.14 25)` |

中性色鎖 **hue ≈ 250–255**；強調色鎖 **hue ≈ 200**。勿再引入紫粉漸層或多色彩虹條。

## Typography

- **Display**: `Noto Serif TC`（平台名、區塊標題）
- **UI / Body**: `Noto Sans TC`
- 比例：標題 ≈ 正文 2.5× 以上；字距 display 約 `-0.02em`
- 禁止：Inter / Roboto / system-ui 當主顯示字；禁止 ALL-CAPS eyebrow

## Spacing · Radius · Shadow

- **Base**: 4px → 8 / 12 / 16 / 24 / 32 / 40 / 64
- **Page gutter**: `--space: clamp(16px, 4vw, 40px)`
- **Radius**: 互動面 8–10px；印信／logo 維持圓形；公告區 0（報刊線框）
- **Shadow**: 僅登入卡一層 `0 12px 28px`；其餘用邊線分層，不用軟陰影堆疊

## Motion

- Micro：160–200ms `cubic-bezier(0.16, 1, 0.3, 1)`
- 頁面僅保留 **一個** 進場：logo 印信 `scale`（`prefers-reduced-motion` 關閉）
- 禁止：每區塊 fade-blur、bounce、彩虹進度條

## Blocklist（技術收斂）

- 紫粉藍漸層背景、漸層字
- 卡片左側／頂部彩色飾條（>1px）
- 大圓角軟陰影「同尺寸圖示+標題+說明」四欄模板
- emoji 當 icon（首頁時程／公告）
- 玻璃 `backdrop-filter` 當裝飾
- 假數據、假 logo 牆、假 testimonial

## Layout notes

1. Hero：品牌標題 + 一句 lead + 屬性細線列 + CTA；中央印信；右側登入卡（唯一卡片）
2. 時程／公告：標題底線 + 清單，非浮卡
3. 資訊列：細線分隔的事實條，非四張同構卡片
