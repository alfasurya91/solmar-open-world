[![Solmar](https://make.fun/badge/gta6-01.svg)](https://make.fun/gta6-01) [![Rank](https://make.fun/badge/gta6-01/alfasurya91/solmar-open-world/rank.svg)](https://make.fun/gta6-01/alfasurya91/solmar-open-world) [![Reward](https://make.fun/badge/gta6-01/alfasurya91/solmar-open-world/reward.svg)](https://make.fun/gta6-01/alfasurya91/solmar-open-world)

# Solmar

Halaman bounty: **https://make.fun/bounty/gta6-01**

Solmar adalah kota pantai 2D yang bisa kamu jalani dari atas aspal: berjalan di trotoar, mencuri sedan yang berhenti di lampu merah, lalu kabur dari cruiser yang menyalakan sirene. Semuanya digambar ke satu elemen `<canvas>` dengan HTML Canvas 2D API — tanpa engine, tanpa bundler, tanpa langkah build, dan tanpa satu pun library pihak ketiga. Setelah `index.html` terbuka, permainan tidak memanggil jaringan lagi.

Peta dibangun prosedural dari sebuah seed: grid 7 × 5 blok dengan jalan dua arah, tiga distrik (Old Town, Downtown, Marina District), lalu blok terakhirnya larut menjadi promenade, pasir, dermaga, dan laut.

## Menjalankan

Butuh Node.js 22.18 atau lebih baru (`engines` di `package.json`). Dua entry point, dua keperluan berbeda:

```
node serve.ts                 # server statis game/ di http://localhost:8080
node serve.ts --port 8901     # port lain kalau 8080 sudah dipakai
node main.ts                  # merakit deliverable (game/, screenshots/, dossier.json)
```

Perintah yang sama tersedia sebagai script npm, untuk siapa pun yang lebih suka `npm run`:

```
npm run serve                 # = node serve.ts
npm run build                 # = node main.ts
npm test                      # node --check semua game/src/*.js + cek index.html memuat ./src/main.js
```

`serve.ts` hanya memakai pustaka standar Node: menyajikan berkas dari `game/`, memetakan MIME type yang dibutuhkan browser, menolak path yang keluar dari `game/`, mengirim `cache-control: no-cache` plus `x-content-type-options: nosniff`, dan mengikat diri ke `127.0.0.1` saja. Nilai `--port` atau `PORT` yang tidak masuk akal dilewati dengan satu baris peringatan, bukan dipakai diam-diam; `SIGINT`/`SIGTERM` menutup listener lalu keluar dengan kode 0. Buka `http://localhost:8080` di Chrome desktop setelah server hidup.

`main.ts` bukan build step untuk bermain — berkas game tetap JavaScript apa adanya. Perintah itu membersihkan direktori output, memvalidasi `game/index.html`, menyalin `game/` dan `screenshots/`, menulis `dossier.json` lewat `vendor/makefun-game.ts`, lalu membaca dossier itu kembali sebagai verifikasi. Output mendarat di `MAKEFUN_OUTPUT_DIR`, atau `/output` bila variabel itu kosong. Kalau ada langkah yang gagal, direktori output dihapus lagi supaya tidak ada sisa build setengah jadi.

Membuka `game/index.html` langsung dengan klik dua kali juga bisa, karena tidak ada proses build yang perlu dilewati. Setelah title card muncul, tekan `Enter` (atau klik tombol **Start driving**) untuk mulai. Browser menahan audio sampai ada interaksi pengguna, jadi klik kanvas sekali bila suara belum keluar.

## Build dan dossier

`node main.ts` berjalan dalam empat langkah dengan urutan tetap:

1. **Bersihkan** direktori output, supaya dossier atau screenshot dari build lama tidak bisa dikira bagian dari build ini.
2. **Validasi input** sebelum satu berkas pun dibuat: `game/` harus ada beserta `game/index.html`, dan `screenshots/` harus muat dalam cap dossier — paling banyak 4 berkas, masing-masing paling banyak 256 KiB.
3. **Salin** `game/` dan `screenshots/`, lalu tulis `dossier.json` dengan `buildDossier` dan cap skorer (`text_max_bytes` 160 KiB, `game_max_files` 993, `game_max_bytes` 48 MiB, `game_path_max_bytes` 1000).
4. **Verifikasi**: dossier dibaca kembali dari disk, diparse sebagai JSON, dipastikan menyatakan skema `makefun/dossier/v1`, lalu tiap entri `images`-nya dicocokkan dengan berkas di output — nama, `sha256`, `media_type` terhadap magic byte PNG/JPEG, dan `cover` yang menunjuk entri yang ada.

Ringkasnya satu baris:

```
solmar: build ok: output /tmp/solmar-out, dossier.json 174892 bytes (schema makefun/dossier/v1), 1 screenshot, 17 game files
```

Checkout ini sengaja tidak menyimpan render di `screenshots/`: render ditulis sesi screenshot, bukan dibawa masuk. Selama direktori itu masih kosong, langkah 3 menulis satu cover pengganti yang dilabeli (`0-placeholder-cover.png`, PNG 1280 × 720 bergambar teks **SOLMAR / NO RENDERS YET**) supaya dossier tetap bisa dibangun dan diperiksa lebih awal, dan baris ringkasan menyebut pengganti itu secara eksplisit. Begitu render asli ada di `screenshots/`, pengganti tidak pernah ditulis lagi — build dengan render sungguhan tidak mendapat berkas tambahan dari langkah itu.

## Kontrol

| Tombol | Aksi |
|--------|------|
| `W` `A` `S` `D` atau panah | Jalan kaki segala arah. Saat menyetir: `W` gas, `S` rem lalu mundur, `A`/`D` belok |
| `Shift` | Lari; menguras stamina, dan badan harus pulih dulu sebelum bisa sprint lagi |
| `Space` | Handbrake saat di mobil — ekor mobil lepas, cocok untuk belokan tajam. Di layar menu berfungsi sebagai konfirmasi/mulai |
| `E` | Naik mobil terdekat, bobol mobil terkunci (hotwire, beberapa detik di tempat), atau turun dari mobil |
| `J` atau klik kiri | Tinju; berubah jadi tembakan begitu pistol terpasang |
| `Q` atau `3` | Tukar tinju ↔ pistol |
| `R` | Isi ulang magasin pistol dari cadangan |
| `1` atau `F5` | Simpan permainan |
| `2`, `L`, `C`, atau `F9` | Muat permainan |
| `Esc` atau `P` | Jeda dan buka menu jeda |
| `M` atau `Tab` | Peta kota (tampilan overview) |
| `H` | Klakson saat menyetir |
| `Backspace` | Bisukan / nyalakan audio |
| `Enter` | Mulai dari title, lanjut dari jeda, ulang setelah wasted/busted |

Pistol tidak diambil dengan tombol: ada satu pickup yang berdenyut di trotoar dekat titik spawn, dan badan yang berjalan melewatinya langsung memungutnya. Gamepad standar dan layout sentuh juga dikenali lapisan input, tetapi keyboard adalah jalur utama.

## Sistem Permainan

- **Berjalan dan menyetir.** Dua model gerak terpisah: badan jalan kaki dengan akselerasi, belokan, dan dorongan keluar dari tembok, plus fisika mobil arcade dengan gigi, grip, slip, dan handbrake. Di atas pasir grip mobil turun, jadi mengejar di pantai terasa lebih licin.
- **Lalu lintas hidup.** 26 mobil ambient menyusuri lajur dua arah, melambat untuk rintangan, dan sesekali membunyikan klakson. 54 pejalan kaki berkeliling blok, menyeberang di persimpangan, dan panik lalu berlarian kalau ada kekerasan di dekat mereka.
- **Mencuri mobil.** Mobil yang tidak terkunci bisa langsung dinaiki; yang terkunci memaksa hotwire dengan waktu tergantung tipe kendaraannya. Mencabut mobil dari arus lalu lintas dihitung sebagai kejahatan dan menaikkan heat.
- **Wanted 1–5 bintang.** Heat disimpan 0–100 dengan satu bintang tiap 20 poin. Cruiser mengejar dan menabrak, bala bantuan datang bertahap sampai 8 unit, roadblock muncul di bintang 3, spike strip di bintang 4, dan air support di bintang 5. Petugas jalan kaki bisa menangkap; mulai bintang 3 mereka juga melepaskan tembakan. Heat baru turun setelah beberapa detik tanpa terlihat.
- **Lima misi cerita** berurutan, lalu mode free-roam: **Dock Run** (antar paket ke dermaga), **Tail Lights** (kejar kurir lalu periksa bangkainya), **Hot Wire** (bawa mobil curian ke chop shop), **Heat** (lepaskan diri dari cruiser lalu ke safehouse), dan **Last Light** (paket terakhir sampai ke kapal di ujung pier, langkah terakhirnya jalan kaki). Sesudah cerita habis, pekerjaan acak bergilir antara courier, bounty, dan scrap dengan bayaran yang berubah tiap kali.
- **Combat.** Pukulan punya cooldown dan jangkauan sendiri; pistol memakai peluru yang dilacak per frame, muzzle flash, percikan, dan cadangan amunisi yang bisa diisi ulang. Musuh terlempar dan jatuh, badan bisa stagger, dan darah turun perlahan setelah beberapa detik tenang.
- **HUD dan minimap live.** HUD kanvas menampilkan uang, health, stamina, bintang wanted, jam dan hari, nama distrik, kartu objektif, kecepatan, serta minimap sudut kanan bawah yang menggambar garis pantai, jalan, mobil lalu lintas, mobil parkir, posisi polisi, dan marker misi yang berdenyut.
- **Jam dan cahaya.** Hari mulai pukul 16:20 dan berjalan 1,5 menit in-game per detik nyata, jadi satu hari penuh sekitar 16 menit. Renderer memanaskan warna menjelang senja, lalu menyalakan lampu jendela dan lampu kendaraan saat malam.
- **Simpan dan muat.** Tiga slot `localStorage` di bawah kunci `solmar.save.v1`, tiap slot membawa versi skema, stempel waktu, dan salinan cadangan sebelum ditimpa. Autosave berjalan tiap 20 detik, ditambah simpan manual. Payload lama dimigrasikan saat dibaca, bukan ditolak.
- **Audio tersintesis.** Musik, mesin, sirene, tembakan, pukulan, dan klik semuanya dibangkitkan lewat WebAudio — tidak ada satu berkas suara pun yang diunduh.

## Alur Layar

Title card → bermain → jeda (menu menampilkan uang, health, stamina, waktu, wanted, kondisi mobil, dan jumlah pekerjaan selesai) → layar akhir saat **busted** atau **wasted**, dengan `Enter` untuk mengulang. Permainan juga otomatis dijeda kalau tab kehilangan fokus atau visibilitas.

## Screenshot

Empat tangkapan layar yang dituju di `screenshots/`, masing-masing dari hook URL yang berbeda. Direktori itu kosong di checkout ini — sesi screenshot yang menulisnya — jadi build sebelum render ada memakai cover pengganti yang dilabeli (lihat **Build dan dossier**):

- `screenshots/1-chase.jpg` — kejaran polisi dengan bintang wanted menyala (`?shot=play`)
- `screenshots/2-city.jpg` — pandangan kota dan garis pantai (`?autostart=1`)
- `screenshots/3-mission.jpg` — kartu objektif misi di jalan (`?autostart=1&seed=4211`)
- `screenshots/4-menu.jpg` — title card dan daftar kontrol

## Hook URL

- `?seed=N` — bangun kota dari seed lain; tata letak blok, parkiran, dan taman ikut berubah.
- `?autostart=1` — lewati title card, langsung masuk permainan.
- `?difficulty=santai|normal|keras` — ubah health pemain, damage yang diterima, agresivitas polisi, pertumbuhan heat, bayaran misi, cadangan amunisi, kepadatan lalu lintas, dan kecepatan waktu. `santai` memberi masa tenggang sebelum misi bisa gagal; `keras` kebalikannya.
- `?shot=start|play|end` — bingkai deterministik untuk pengambilan screenshot: simulasi tidak maju, jadi hasilnya bisa diulang.

## Struktur Berkas

```
README.md                dokumen ini
main.ts                  perakit deliverable (game/, screenshots/, dossier.json)
serve.ts                 server statis lokal untuk game/
package.json             metadata repo + script serve/build/test
.makefun/owner.json      klaim wallet untuk make.fun (tidak dibaca main.ts)
vendor/makefun-game.ts   penulis dossier build
game/index.html          satu kanvas, overlay menu, dan HUD DOM cadangan
game/src/main.js         boot, loop fixed-step, layar, aksi, simpan/muat
game/src/config.js       tuning: kota, pemain, kendaraan, polisi, misi, save, difficulty
game/src/city.js         generasi kota prosedural dan metadata distrik
game/src/render.js       renderer 2D, ground layer yang di-bake, siklus siang-malam
game/src/hud.js          HUD kanvas, minimap, title, jeda, layar akhir
game/src/player.js       gerak jalan kaki, stamina, health, punch state
game/src/vehicles.js     fisika mobil, hotwire, naik/turun kendaraan
game/src/traffic.js      mobil NPC dan lane following
game/src/pedestrians.js  kerumunan pejalan kaki dan reaksi panik
game/src/police.js       heat, wanted, dispatch, pursuit, officer, busted/wasted
game/src/combat.js       tinju, pistol, peluru, partikel, pickup
game/src/missions.js     lima misi cerita dan pekerjaan free-roam
game/src/audio.js        musik dan SFX sintetis WebAudio
game/src/input.js        binding tombol, one-shot latch, buffer, gamepad, sentuh
game/src/utils.js        matematika, geometri, seeded generator
game/src/save.js         tiga slot localStorage dengan backup dan migrasi
screenshots/             empat render untuk dossier (ditulis sesi screenshot)
```

## Lisensi

MIT — lihat [LICENSE](LICENSE).
