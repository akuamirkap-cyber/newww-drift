export interface DesignDocSection {
  id: string;
  tabLabel: string;
  title: string;
  subtitle: string;
  body: string;
}

export const DESIGN_DOC_SECTIONS: DesignDocSection[] = [
  {
    id: 'map-gedung',
    tabLabel: 'Map Gedung',
    title: 'DESAIN MAP GEDUNG (AULA 256x168x26)',
    subtitle: 'File: src/utils/aulaHall.ts • Dipakai: RCDriftCanvas3D.tsx bagian 3 & 5B',
    body: `KONSEP DASAR
1 kotak aula raksasa + trek P-Tile di tengahnya.
- Ukuran aula: 256 m x 168 m, tinggi 26 m. Posisinya OTOMATIS mengikuti center bounds sirkuit (computeHallFrame dari 16 titik kontrol tiap sirkuit).
- Semua tekstur = canvas 2D prosedural (tanpa file gambar). Objek banyak = InstancedMesh (1 draw call). Posisi acak = seeded RNG mulberry32 (hasil sama tiap load).

A. LANTAI
- 1 plane raksasa. Tekstur kanvas: ubin 4x4 + 1600 speckle acak (putih/hitam/oranye), diulang 110x72 kali (ratusan).
- Material satin anti-silau: roughness 0.55, metalness 0.06.

B. DINDING (canvas vertikal 32x512)
- Trim gelap atas, strip oranye sport + pinstripe putih di tengah, wainscot abu gradasi di bawah. Diulang 48x horizontal.

C. PLAFON + TRUSS + KOLOM
- Plafon abu gelap 1 plane menghadap bawah.
- Truss box bersilangan 7x10 pakai 2 InstancedMesh.
- Kolom box 1.6 m tiap 32 m di keempat dinding, 1 InstancedMesh.

D. PENCAHAYAAN
- HDR prosedural equirect float 1024x512: grid panel high-bay 10x7 radiansi >1, pita skylight hangat, jendela daylight dingin, lantai hangat. Diproses PMREM jadi environment + refleksi.
- 70 lampu plafon emissive InstancedMesh, grid-nya SAMA dengan pola HDR.
- Key light directional 2048 mengikuti mobil pemain tiap frame (posisi = mobil + offset, target = mobil), frustum ketat ±30 m biar bayangan tajam.
- Tone mapping AgX exposure 0.95 biar highlight tidak clipping dan tidak silau.

E. TRIBUN + PENONTON (sisi utara)
- Tribun 6 undakan (tinggi 0.85 m per undak, lebar 150 m) + list oranye tiap bibir undak.
- ±300 penonton: 2 InstancedMesh (badan silinder + kepala bola), 72% kursi terisi, warna baju 10 varian + kulit 5 varian acak seeded, skala 0.9-1.1.

F. ROSTRUM 48 M (sisi selatan)
- Platform 48x3.6x4.5 m, railing pipa (2 horizontal + tiang tiap 4 m), tangga 6 anak di ujung timur, spanduk "DRIVER STAND • ROSTRUM".
- 7 orang (baju beda-beda) pegang transmitter RC + antena miring.
- Kamera driver_stand ditaruh di atas rostrum baru ini.

G. MENARA JURI + LED + SPONSOR + PIT + EXIT
- Menara juri sisi timur: base + kabin kaca menghadap trek + atap oranye + tiang antena + beacon merah.
- Layar LED 30 m di dinding utara: canvas "RC DRIFT ARENA • LIVE" + scanline, meshBasicMaterial biar terlihat menyala.
- Generator spanduk sponsor (teks -> canvas -> texture): 4 varian (YOKOMO / REVE D / OVERDOSE / AXON-SHIBATA) di dinding + 2 gantung di atas garis start (double-sided + kabel ke plafon).
- Pit area sisi barat: 7 meja (top + 4 kaki) + toolbox merah/biru selang-seling + laptop (base + layar biru).
- 2 pintu EXIT gelap (timur & barat) + kotak lampu hijau emissive + label EXIT dari canvas.

H. TREK (tetap seperti sebelumnya)
- 16 titik kontrol -> kurva CatmullRom centripetal tertutup -> smooth Gaussian 2x -> 640 frame. Aspal 3 lapis, pagar rel 3D menerus hasil ekstrusi, 4 clipping zone OZ-1/CP-2/OZ-3/CP-4.`,
  },
  {
    id: 'hiasan-gedung',
    tabLabel: 'Hiasan Sakura',
    title: 'TAMAN SAKURA OTOMATIS (14 POHON)',
    subtitle: 'File: src/utils/aulaHall.ts (buildSakuraGardenAuto) • Dipanggil: RCDriftCanvas3D.tsx bagian 5B',
    body: `IDE DASAR
14 pohon sakura dalam planter, posisinya DIPILIH OTOMATIS oleh algoritma (bukan manual), dengan 3 aturan validasi ketat.

ATURAN VALIDASI (cek tiap kandidat, seed 4242, maks 800x coba)
1. Jarak > 10.5 m dari TEPI trek (dicek ke 120 sampel titik tengah trek + setengah lebar trek).
2. Hindari rostrum (+3 m), tribun (+3 m), pit area (+2 m), dan menara juri (radius 9 m).
3. Antar pohon minimal 7 m.

BENTUK 1 POHON
- Batang silinder coklat + 1 cabang miring + 6 gumpalan Icosahedron low-poly flatShading warna pink 5 varian + pot kotak kayu.
- Skala acak 1.0-1.5, putaran acak, masuk grup goyang (rotation.z = sin(waktu) * 0.012 tiap frame).

BONUS DI SEKITARNYA
- 40 rumpun rumput (6 bilah kerucut tiap rumpun), validasi jarak trek juga.
- 8 batu putih Dodecahedron acak.
- 70 kelopak beterbangan: 2 material pink dipakai bareng. Tiap kelopak punya kecepatan jatuh, fase goyang, kecepatan putar sendiri. Tiap frame: jatuh + goyang sinus + putar, kalau kena lantai respawn di atas pohon acak.

CARA UBAH
- Tambah/kurangi pohon: ubah angka 14 di buildSakuraGardenAuto.
- Ubah jarak aman: ubah 10.5 / 7 / 9 di fungsi yang sama.
- Ganti seed 4242 kalau mau susunan pohon yang beda tapi tetap konsisten.`,
  },
  {
    id: 'main-menu',
    tabLabel: 'Main Menu',
    title: 'CARA MAIN MENU DIBUAT',
    subtitle: 'File: src/components/MainMenu.tsx • Gambar: public/images/main-menu-sakura.jpg • Kontrol: src/App.tsx',
    body: `LAPISAN VISUAL DARI BELAKANG KE DEPAN
1. Foto background AI 16:9: langit sunset pink-ungu + jalan aspal + deretan sakura + Skyline R34 biru.
   Dipasang sebagai bg-cover bg-center scale-105.
2. Dua gradasi gelap di atasnya (kiri-ke-kanan dan bawah-ke-atas) supaya teks putih tetap terbaca.
3. 22 kelopak CSS jatuh: span bulat pink dengan posisi, delay, durasi, ukuran, dan opacity acak +
   animasi keyframes petalfall (jatuh 108vh sambil geser kiri-kanan dan muter 360 derajat, loop tak terbatas).
4. Konten menu dalam kolom max-w-7xl.

ISI KONTEN
- Bar atas: logo Gauge gradasi magenta-ungu + judul "RC DRIFT PRO // AULA SAKURA" + saldo RC$.
- Hero: badge "Grand Aula Championship", judul raksasa "SKYLINE SAKURA DRIFT"
  (baris kedua gradasi pink-orange), dan deskripsi R34 Bayside Blue.
- Step 1 mode balap: 3 kartu dari array MODE_CARDS — Tsuiso Tandem, Qualifying 3 Lap, Free Drift.
  Yang aktif menyala magenta + glow.
- Step 2 sirkuit: 3 kartu dari data circuits — nama trek + nama permukaan lantai.
- Step 3 mobil: 2 kartu dari SKYLINE_CHOICES — R34 Bayside Blue vs R32 Gunmetal + kotak warna.
- Kotak info kontrol keyboard/HP, tombol raksasa START DRIFT gradasi pink-orange,
  dan tulisan anjuran menyalakan suara.

ALUR KE GAME DI App.tsx
- State hasStarted awalnya false. Kanvas 3D jalan di belakang menu sebagai preview hidup, tapi HUD belum ditampilkan.
- Klik sirkuit/mode/mobil di menu hanya mengganti state biasa, belum reset balapan.
- Klik START: inisialisasi suara, bunyi chime, hapus hasil lama, naikkan resetTrigger
  agar mobil respawn di garis start, lalu hasStarted = true. Menu hilang, HUD muncul.
- Tombol Home di HUD kanan atas kembali ke menu tanpa reload halaman.

KALAU MAU UBAH
- Ganti gambar: timpa file jpg tersebut.
- Ganti teks/judul/warna: edit MainMenu.tsx.
- Tambah mode/mobil: tambah item di MODE_CARDS / SKYLINE_CHOICES + tipe bodinya.`,
  },
  {
    id: 'bot-ai-pro',
    tabLabel: 'Bot AI Pro',
    title: 'BOT AI PRO v2 (SMOOTH LINE DRIVER + SOFT CONTACT)',
    subtitle: 'File: src/games/sakura_rc/game/proBot.ts • Dipakai: RCDriftCanvas3D.tsx bagian 7 & 8B • Tes: scripts/sakura_probot_test.mts',
    body: `TUJUAN
Bot RC 1:10 yang luwes (tidak kaku), nurut jalur, tidak mepet pembatas, masih bisa
ditabrak/disenggol, dan tidak gampang ditebak karena tiap sesi punya kepribadian.

1. TRACK SAMPLER (precomputed, bebas lag)
- TrackSampler menyimpan posisi + tangent + normal + kelengkungan tiap titik spline
  (900 titik Aula, 1800 titik Haruna) plus spatial hash 4 m untuk proyeksi O(1).
- Bot tidak lagi memanggil puluhan curve.getPointAt()/getTangentAt() per frame
  (sumber utama GC hitch / "lag kaku" pada versi lama).

2. LANE PLAN (garis balap, bukan garis dinding)
- offset[i] = -sign(kurvatur halus) * limit  -> garis out-in-out (apex) ala drift.
- Clipping zone didekati dengan bump Gaussian (stand-off 1.6 m dari dinding) supaya
  bot tetap memburu zona skor tanpa menempel pembatas.
- 4 pass smoothing + clamp limit, dengan limit = setengah lebar track - margin mobil
  - margin dinding personality. Contoh Aula (lebar 10.4 m): limit ~2.7-3.2 m,
  sementara dinding di 5.2 m => body bot selalu > 0.6 m dari pembatas.

3. DRIVER (integrator orde-2, substepped 120 Hz)
- Jalan: feed-forward kelengkungan (c_mid*0.6 + c_far*0.4) + pure-pursuit paralel
  look-ahead (3.4 m + 0.4*v), dibatasi yaw-rate aLat/speed dan akselerasi yaw.
- Drift: sudut slip ditargetkan dari beban corner (cornerLoad), lalu diintegrasi
  spring-damper (omega ~4.5 rad/s, zeta ~0.9) => transisi manji luwes, tidak patah.
- Kecepatan: vLimit = sqrt(aLat / kurvatur) dihitung sepanjang jarak pengereman +
  jerk-limited throttle/brake (damp 6.5/s) => tidak ada on/off mendadak.
- Dinding: tekanan prediktif (proyeksi lateral + 0.42 detik) + geser halus +
  scrub kecepatan; clamp keras hanya backstop darurat.

4. KEPRIBADIAN & VARIASI (anti gampang ditebak)
- Personality di-seed per sesi: aggression, smoothness, lineGain, wanderAmp,
  feintLove, reaction, wallMargin, driftLove.
- Mood lambat (noise 1D) menggeser pace +-5%; tiap lap lineScale berubah +-7%;
  di trek lurus bot kadang memberi feint manji (envelope sinus, bukan random frame).

5. PINTAR KALAU KELUAR JALUR
- Mode state machine: start -> line -> recover -> unstick (fallback).
- recover: titik rejoin dicari di depan, look-ahead diperpanjang & sudut masuk
  dibatasi, kecepatan 0.74x (0.55x kalau off-track), slip 0.34x, lalu blend balik.
- unstick: kalau macet (<1.1 m/s selama 1.4 detik) bot mundur halus 0.85 detik
  sambil setir berlawanan, lalu maju lagi menuju garis.
- Traffic awareness: kalau pemain tepat di depan <10 m bot lift halus (tidak
  menghajar), kalau pemain menempel di belakang bot menutup garis sedikit.

6. KONTAK DUA ARAH YANG HALUS (resolveRcContact)
- 3 sphere per mobil (bumper depan, chassis, bumper belakang).
- Separasi posisi dibatasi kecepatan 1.5 m/s (maks ~2.5 cm/frame) => tidak teleport.
- Impuls = -(1+rest) * kecepatan mendekat * 0.5, dibatasi 5.2 m/s, ditambah friksi
  tangensial (0.45) => bisa disenggol/didorong, tapi tidak mental.
- Spin PIT dihitung dari offset titik tumbukan, dibatasi +-0.95 rad/s, dan bot
  memasukkannya ke slipRate (kicked) supaya body terpelintir natural lalu pulih.
- Klasifikasi kontak: rub (<2.0), bump (<4.6), clash (>=4.6) -> callout + suara.

7. CARA UJI (offline, tanpa browser)
- npx tsx scripts/sakura_probot_test.mts
- 28+ assertion: 3 lap di 60/30/20 fps, max lateral vs koridor (bukan mepet dinding),
  jerk/steer-rate/chatte, rejoin setelah dibuang keluar jalur, solver kontak
  (impuls, spin, separasi). Verifikasi manual terakhir: ALL PASS.

KALAU MAU UBAH
- Pace bot (legend/pro/chill): BOT_PACE_CONFIG di proBot.ts (dipakai juga oleh
  pilihan BOT AI di MainMenu).
- Garis balap: LanePlanOptions.lineGain / zoneGain; lebar koridor:
  personality.wallMargin (makin besar makin jauh dari pembatas).
- Kehalusan: personality.smoothness dan konstanta spring-damper slip (20.5 / 8.4).`,
  },
];

export const FULL_DESIGN_DOC_TEXT: string = DESIGN_DOC_SECTIONS.map(
  (s) => `============================================================\n${s.title}\n${s.subtitle}\n============================================================\n\n${s.body}`
).join('\n\n\n');
