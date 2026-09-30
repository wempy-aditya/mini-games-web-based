# 🎮 Mini Games

Kumpulan mini game web based — arena shooter 3D, arcade, dan lainnya. Masing-masing game berdiri sendiri di foldernya sendiri, tanpa dependency lintas-game.

## 🎯 Game

| Game | Genre | Status | Kontrol |
|---|---|---|---|
| 🐍 [Snake](games/snake/) | Arcade canvas | ✅ Selesai | `↑↓←→` / `WASD` |
| 🎯 [Neon Breach](games/neon-breach/) | Arena shooter 3D (FPS) | 🟡 Progress | `WASD` jalan · Mouse/panah menoleh · `LMB` tembak · `R` reload · `Shift` dash · `1-3` pilih upgrade · `Esc` jeda |

## 🚀 Menjalankan

Butuh Python 3 saja — tidak ada `npm install`, tidak ada build step.

```bash
git clone https://github.com/wempy-aditya/mini-games-web-based.git
cd mini-games-web-based
python3 serve.py
```

Buka `http://127.0.0.1:8000/`

Butuh port lain? `python3 serve.py --port 8123`

## 🗂 Struktur

```
mini-games-web-based/
├── index.html          # katalog semua game
├── serve.py            # dev server (Python stdlib) + /api/games
└── games/
    ├── snake/
    └── neon-breach/
```

Katalog membaca `GET /api/games`, yang di-scan otomatis dari folder di bawah `games/`. Tambah game cukup bikin folder + `index.html` — `serve.py` tidak perlu disentuh.

## 📦 Game

### Neon Breach

Arena shooter 3D first-person. Tahan wave enemy, pilih 1 dari 3 kartu upgrade tiap 5 level, boss tiap 5 wave.

- **Stack:** three.js r160 (vendored offline, bukan CDN) + WebAudio SFX sintetis (nol file aset)
- **Render:** WebGL2, `EffectComposer` + `UnrealBloomPass`
- **5 tipe enemy:** drone, runner, bulwark, sentinel, plus boss SENTINEL PRIME 2 fase
- **Kontrol:** `WASD` · `Shift` dash · `R` reload · `1-3` pilih upgrade · `Esc` jeda
- **Jatuh tempo:** `1-3` memilih upgrade setelah wave selesai

## 📄 Lisensi

Kode asli repo ini: MIT.

Bundel pihak ketiga:

- [three.js](https://threejs.org) r160 — MIT, lisensi di `games/neon-breach/vendor/THREE-LICENSE.txt`

## 🌐 Asal

Proyek bagian dari lab eksperimen pribadi. Struktur & catatan arsitektur: [wempyaw.com](https://wempyaw.com)
