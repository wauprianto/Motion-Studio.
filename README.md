# Motion Studio — Hand Tracking Instrument

Animasi yang mengikuti gerakan tangan/jari, menggabungkan 4 konsep dalam satu
pipeline hand-tracking: trail partikel, gambar di udara (air drawing), efek
gestur, dan suara yang dikendalikan posisi tangan.

Dibangun dengan React + Vite. Hand tracking pakai MediaPipe HandLandmarker
(`@mediapipe/tasks-vision`, jalan di browser lewat WASM), audio pakai Tone.js.

## Menjalankan secara lokal

```bash
npm install
npm run dev
```

Buka URL yang muncul (biasanya `http://localhost:5173`). Camera API butuh
konteks aman (HTTPS atau localhost) — `npm run dev` sudah otomatis localhost,
jadi izin kamera akan berjalan normal.

## Build untuk produksi

```bash
npm run build
```

Hasilnya ada di folder `dist/`.

## Deploy ke Vercel

1. Push project ini ke GitHub, lalu import di dashboard Vercel — Vercel akan
   otomatis mendeteksi ini sebagai project Vite (build command `npm run build`,
   output folder `dist`).
2. Atau lewat CLI:
   ```bash
   npm i -g vercel
   vercel
   ```
3. Setelah live, browser akan minta izin kamera saat pertama diakses — aman
   karena Vercel selalu serve lewat HTTPS.

## Kontrol

- **Cubit** (jempol + telunjuk) → menggambar di udara
- **Telapak terbuka** → ledakan partikel
- **Kepalan tangan** → tarik partikel ke tengah
- **Posisi tangan** (saat layer SUARA aktif) → mengontrol nada & filter suara
- Panel bawah kanan: on/off tiap layer (JEJAK, GAMBAR UDARA, EFEK GESTUR, SUARA)
  + tombol BERSIHKAN untuk menghapus gambar

## Kalibrasi

Dua konstanta di `src/App.jsx` mungkin perlu disesuaikan tergantung jarak
tangan ke kamera:

- `pinchDist < 0.55` — ambang sensitivitas cubit
- `* 1.15` di `extendedCount` — ambang jari dianggap "terentang"

Kalau HandLandmarker gagal load di device tertentu, coba ganti
`delegate: 'GPU'` menjadi `delegate: 'CPU'` di `initHandLandmarker()`.
