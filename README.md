[![Solmar](https://make.fun/badge/gta6-01.svg)](https://make.fun/gta6-01) [![Rank](https://make.fun/badge/gta6-01/alfasurya91/solmar-open-world/rank.svg)](https://make.fun/gta6-01/alfasurya91/solmar-open-world) [![Reward](https://make.fun/badge/gta6-01/alfasurya91/solmar-open-world/reward.svg)](https://make.fun/gta6-01/alfasurya91/solmar-open-world)

# Solmar

**Tautan bounty:** https://make.fun/bounty/gta6-01

Solmar adalah kota fiksi yang tidak pernah ada di peta — kota pantai 2D yang dibangun penuh dengan HTML Canvas API tanpa engine, tanpa build step, tanpa library pihak ketiga, dan tanpa permintaan jaringan setelah halaman dimuat.

Kota ini berupa grid jalan dua arah yang mengelilingi blok-blok atap datar. Di tepi timurnya blok berhenti dan digantikan promenade, lalu pasir, dermaga, dan akhirnya laut terbuka. Kamu memulai di jalan kaki. Dari situ ambil pekerjaan, naik dan curi mobil, selesaikan perselisihan dengan tinju atau pistol, dan waspadai bintang wanted sementara polisi mengejar.

## Sistem Game

- **Jalan kaki & mobil** — berjalan, lari, naik mobil parkir, curi mobil dari lalu lintas, fisika arcade (gas, rem, mundur, belok, handbrake).
- **Lalu lintas & pejalan kaki** — 26 mobil NPC yang mengikuti jalur dua arah, 54 pejalan kaki yang berkeliling blok, promenade, dan dermaga.
- **Curi mobil** — menarik pengemudi keluar dari mobil bergerak dihitung sebagai kejahatan.
- **Wanted 1–5 bintang & kejaran polisi** — level heat 1 sampai 5, mobil polisi mengejar dan menabrak, petugas jalan kaki menahan dan menembak mulai 4 bintang, heat menurun saat line-of-sight terputus.
- **5 misi cerita dengan dialog** — lima pekerjaan cerita berurutan dengan kartu objektif, dialog, pembayaran uang, diikuti mode free-roam yang bisa diulang.
- **Combat tinju & pistol** — pukulan melee, pelacakan peluru, musuh jatuh, muzzle flash, partikel percikan, pickup pistol.
- **HUD dengan minimap** — health bar, bintang wanted, uang, jam, kartu objektif, minimap live (lalu lintas, mobil parkir, marker misi), prompt interaksi, strip toast.
- **Save & Load** — satu slot localStorage + autosave setiap 20 detik saat di jalan kaki, manual save/load via tombol.
- **Musik & efek suara WebAudio** — seluruh audio disintesis: musik, SFX tembakan, mesin, tabrakan, tanpa file aset eksternal.

## Kontrol Keyboard

| Input | Aksi |
|-------|------|
| `W` `A` `S` `D` / Arrow keys | Jalan kaki. Di mobil: `W` gas, `S` rem lalu mundur, `A` `D` belok |
| `Shift` | Lari (jalan kaki) |
| `Space` | Handbrake (di mobil); mulai game dari title card |
| `E` | Naik mobil terdekat, curi mobil dari lalu lintas, turun mobil, ambil pistol |
| `X` / Left click | Tinju |
| `C` / Right click | Tembak (setelah pistol didapat) |
| `F5` | Save |
| `F9` | Load |
| `Esc` / `P` | Pause / Resume |
| `Enter` | Mulai game, mulai ulang setelah wasted |

## Cara Main

1. Buka `game/index.html` langsung di **Chrome desktop** (klik dua kali atau drag ke tab Chrome).
2. Title card muncul — tekan `Enter` atau `Space` untuk mulai.
3. Ikuti kartu objektif di atas layar untuk misi cerita, atau jelajah bebas kota.

> Catatan: karena menggunakan WebAudio, browser mungkin memerlukan interaksi pengguna (klik/tekan tombol) sebelum audio bisa diputar. Pastikan mengklik canvas sekali setelah game dimuat.

## Struktur File Game

```
game/
├── index.html           # Halaman utama: satu canvas + status line
├── src/
│   ├── main.js          # Boot, fixed-step loop, screen manager, save/load, wiring
│   ├── config.js        # Tuning sheet: bentuk kota, kecepatan, palet, save key
│   ├── city.js          # Generasi kota prosedural (blok, taman, parkiran, pantai, dermaga)
│   ├── render.js        # Renderer 2D, termasuk ground layer yang di-bake
│   ├── hud.js           # Antarmuka digambar: panel, kartu objektif, minimap, menu
│   ├── player.js        # Gerak & tabrakan jalan kaki
│   ├── vehicles.js      # Fisika mobil, naik/turun kendaraan
│   ├── traffic.js       # NPC traffic & lane following
│   ├── pedestrians.js   # Kerumunan pejalan kaki
│   ├── police.js        # Wanted heat, dispatch, pursuit, arrest, return fire
│   ├── combat.js        # Tinju, pistol, peluru, partikel, pickup
│   ├── missions.js      # Misi cerita, free-roam job, data kartu objektif
│   ├── audio.js         # SFX & musik sintetis (WebAudio)
│   ├── input.js         # Polling tombol & one-shot action latching
│   ├── utils.js         # Aritmatika, geometri, seeded generator
│   └── save.js          # Satu slot localStorage
└── (file starter kit tidak dipakai: world.js, random.js, shots.js)
```

## Query Hooks (Opsional)

- `?seed=N` — bangun ulang kota dari seed berbeda.
- `?autostart=1` — lewati title card, langsung free roam.
- `?shot=start|play|end` — staging frame tunggal untuk screenshot runner.

## Lisensi

MIT. Lihat [LICENSE](LICENSE).