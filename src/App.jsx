import { useEffect, useRef, useState } from 'react'
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import * as Tone from 'tone'

// ---------- pure helpers (operate on plain arrays / canvas ctx) ----------
const TIPS = [8, 12, 16, 20]
const MCPS = [5, 9, 13, 17]
const HAND_COLOR = ['#4ce0d2', '#ff3d7f']

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }

function extendedCount(lm) {
  const wrist = lm[0]
  let n = 0
  for (let i = 0; i < TIPS.length; i++) {
    if (dist(wrist, lm[TIPS[i]]) > dist(wrist, lm[MCPS[i]]) * 1.15) n++
  }
  if (dist(wrist, lm[4]) > dist(wrist, lm[2]) * 1.15) n++
  return n
}

function classifyGesture(lm) {
  const n = extendedCount(lm)
  if (n >= 4) return 'OPEN_PALM'
  if (n <= 1) return 'FIST'
  return 'NEUTRAL'
}

function toDisplay(pt, w, h) { return { x: (1 - pt.x) * w, y: pt.y * h } }

function palmCenter(lm, w, h) {
  const idx = [0, 5, 9, 13, 17]
  let x = 0, y = 0
  idx.forEach((i) => { x += lm[i].x; y += lm[i].y })
  x /= idx.length; y /= idx.length
  return toDisplay({ x, y }, w, h)
}

function spawnTrail(particles, pt, color) {
  particles.push({
    x: pt.x + (Math.random() - 0.5) * 4, y: pt.y + (Math.random() - 0.5) * 4,
    vx: (Math.random() - 0.5) * 0.6, vy: -Math.random() * 0.8,
    life: 1, decay: 0.02 + Math.random() * 0.015,
    size: 2 + Math.random() * 2.5, color,
  })
}

function spawnBurst(particles, center, color) {
  for (let i = 0; i < 46; i++) {
    const a = Math.random() * Math.PI * 2
    const speed = 2 + Math.random() * 5
    particles.push({
      x: center.x, y: center.y,
      vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
      life: 1, decay: 0.012 + Math.random() * 0.01,
      size: 2.5 + Math.random() * 3, color,
    })
  }
}

function applyAttraction(particles, center, strength) {
  particles.forEach((p) => {
    const dx = center.x - p.x, dy = center.y - p.y
    const d = Math.hypot(dx, dy) || 1
    if (d < 320) { p.vx += (dx / d) * strength; p.vy += (dy / d) * strength }
  })
}

function updateParticles(particles) {
  particles.forEach((p) => { p.x += p.vx; p.y += p.vy; p.vy += 0.02; p.life -= p.decay })
  return particles.filter((p) => p.life > 0)
}

function drawParticles(ctx, particles) {
  particles.forEach((p) => {
    ctx.globalAlpha = Math.max(p.life, 0)
    ctx.fillStyle = p.color
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
    ctx.fill()
  })
  ctx.globalAlpha = 1
}

export default function App() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const drawLayerRef = useRef(document.createElement('canvas'))

  const handLandmarkerRef = useRef(null)
  const audioRef = useRef(null)
  const particlesRef = useRef([])
  const lastPenPtRef = useRef([null, null])
  const lastGestureRef = useRef(['NONE', 'NONE'])
  const gestureCooldownRef = useRef([0, 0])
  const runningRef = useRef(false)
  const rafIdRef = useRef(null)
  const layersRef = useRef(null)

  const [layers, setLayers] = useState({ trail: true, draw: true, gesture: true, sound: false })
  const [phase, setPhase] = useState('idle') // idle | loading | running
  const [errorMsg, setErrorMsg] = useState('')
  const [handsCount, setHandsCount] = useState(0)
  const [gestureText, setGestureText] = useState('—')

  useEffect(() => { layersRef.current = layers }, [layers])

  // side effects when layers are toggled off mid-session
  useEffect(() => {
    if (!layers.sound && audioRef.current) audioRef.current.mute()
  }, [layers.sound])
  useEffect(() => {
    if (!layers.draw) lastPenPtRef.current = [null, null]
  }, [layers.draw])

  useEffect(() => {
    return () => {
      runningRef.current = false
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current)
      const stream = videoRef.current?.srcObject
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function toggleLayer(key) {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function clearDrawing() {
    const dl = drawLayerRef.current
    dl.getContext('2d').clearRect(0, 0, dl.width, dl.height)
  }

  function initAudio() {
    if (audioRef.current) return
    const osc = new Tone.Oscillator(440, 'sine').start()
    const filter = new Tone.Filter(800, 'lowpass')
    const gain = new Tone.Gain(0).toDestination()
    osc.connect(filter); filter.connect(gain)
    audioRef.current = {
      osc, filter, gain,
      setTarget(freq, cutoff, level) {
        osc.frequency.rampTo(freq, 0.06)
        filter.frequency.rampTo(cutoff, 0.06)
        gain.gain.rampTo(level, 0.08)
      },
      mute() { gain.gain.rampTo(0, 0.15) },
    }
  }

  async function initHandLandmarker() {
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
    )
    handLandmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numHands: 2,
    })
  }

  function loop() {
    if (!runningRef.current) return
    const canvas = canvasRef.current
    const video = videoRef.current
    const ctx = canvas.getContext('2d')
    const w = canvas.width, h = canvas.height
    const now = performance.now()
    const L = layersRef.current

    ctx.save()
    ctx.translate(w, 0); ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0, w, h)
    ctx.restore()

    const result = handLandmarkerRef.current.detectForVideo(video, now)
    const hands = result.landmarks || []
    setHandsCount(hands.length)

    let anySound = false
    let gestureLabel = '—'

    hands.forEach((lm, i) => {
      const color = HAND_COLOR[i % 2]
      const indexTip = toDisplay(lm[8], w, h)
      const thumbTip = toDisplay(lm[4], w, h)
      const wristD = dist(lm[0], lm[9]) || 0.001
      const pinchDist = dist(lm[4], lm[8]) / wristD
      const gesture = classifyGesture(lm)
      gestureLabel = gesture.replace('_', ' ')

      if (L.trail) spawnTrail(particlesRef.current, indexTip, color)

      if (L.draw) {
        const pinching = pinchDist < 0.55
        if (pinching) {
          const midpt = { x: (indexTip.x + thumbTip.x) / 2, y: (indexTip.y + thumbTip.y) / 2 }
          const dctx = drawLayerRef.current.getContext('2d')
          if (lastPenPtRef.current[i]) {
            dctx.strokeStyle = color
            dctx.lineWidth = 3
            dctx.lineCap = 'round'
            dctx.shadowColor = color
            dctx.shadowBlur = 6
            dctx.beginPath()
            dctx.moveTo(lastPenPtRef.current[i].x, lastPenPtRef.current[i].y)
            dctx.lineTo(midpt.x, midpt.y)
            dctx.stroke()
          }
          lastPenPtRef.current[i] = midpt
        } else {
          lastPenPtRef.current[i] = null
        }
      }

      if (L.gesture) {
        const center = palmCenter(lm, w, h)
        if (gesture !== lastGestureRef.current[i] && now > gestureCooldownRef.current[i]) {
          if (gesture === 'OPEN_PALM') { spawnBurst(particlesRef.current, center, '#f2c14e'); gestureCooldownRef.current[i] = now + 450 }
          if (gesture === 'FIST') gestureCooldownRef.current[i] = now + 200
        }
        if (gesture === 'FIST') applyAttraction(particlesRef.current, center, 0.55)
        lastGestureRef.current[i] = gesture
      }

      if (L.sound && i === 0 && audioRef.current) {
        anySound = true
        const freq = 220 + (1 - lm[8].y) * 660
        const cutoff = 300 + lm[8].x * 3800
        const openness = extendedCount(lm) / 5
        audioRef.current.setTarget(freq, cutoff, 0.05 + openness * 0.18)
        ctx.beginPath()
        ctx.strokeStyle = color
        ctx.globalAlpha = 0.5
        ctx.lineWidth = 1.5
        ctx.arc(indexTip.x, indexTip.y, 14 + openness * 22, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = 1
      }
    })

    setGestureText(gestureLabel)
    if (L.sound && !anySound && audioRef.current) audioRef.current.mute()

    ctx.drawImage(drawLayerRef.current, 0, 0)
    particlesRef.current = updateParticles(particlesRef.current)
    drawParticles(ctx, particlesRef.current)

    rafIdRef.current = requestAnimationFrame(loop)
  }

  async function startCamera() {
    setPhase('loading')
    setErrorMsg('')
    try {
      await Tone.start()
      await initHandLandmarker()
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      })
      const video = videoRef.current
      video.srcObject = stream
      await new Promise((resolve) => {
        video.onloadedmetadata = () => { video.play(); resolve() }
      })

      const canvas = canvasRef.current
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      drawLayerRef.current.width = video.videoWidth
      drawLayerRef.current.height = video.videoHeight

      runningRef.current = true
      setPhase('running')
      if (layersRef.current.sound) initAudio()
      rafIdRef.current = requestAnimationFrame(loop)
    } catch (e) {
      console.error(e)
      setErrorMsg('Gagal mengakses kamera/model. Pastikan dijalankan lewat HTTPS atau localhost, dan izinkan akses kamera.')
      setPhase('idle')
    }
  }

  const isRunning = phase === 'running'

  return (
    <>
      <div className="stage">
        <video ref={videoRef} autoPlay playsInline muted />
        <canvas ref={canvasRef} className="stage-canvas" />
      </div>

      <div className="hud">
        <div className="brand mono">MOTION <span>STUDIO</span></div>
        <div className="status mono">
          <span><span className={`dot ${isRunning ? 'live' : ''}`} />TRACKER</span>
          <span>TANGAN: <b>{handsCount}</b></span>
          <span>GESTUR: <b>{gestureText}</b></span>
        </div>
      </div>

      {isRunning && (
        <div className="rail">
          {[
            ['trail', 'JEJAK'],
            ['draw', 'GAMBAR UDARA'],
            ['gesture', 'EFEK GESTUR'],
            ['sound', 'SUARA'],
          ].map(([key, label]) => (
            <div
              key={key}
              className={`switch ${layers[key] ? 'on' : ''}`}
              onClick={() => toggleLayer(key)}
            >
              <div className="track"><div className="knob" /></div>
              <div className="label">{label}</div>
            </div>
          ))}
          <button className="action mono" onClick={clearDrawing}>BERSIHKAN</button>
        </div>
      )}

      {!isRunning && (
        <div className="overlay">
          <div className="panel">
            <div className="scan" />
            <div className="eyebrow">HAND MOTION INSTRUMENT</div>
            <h1>Gerakkan tangan, gerakkan cahaya</h1>
            <p>
              Empat lapisan digabung jadi satu: jejak partikel, gambar di udara, efek gestur,
              dan suara yang dikendalikan tangan — semua dari satu kamera.
            </p>
            <div className="legend mono">
              <div><b>Cubit</b> (jempol + telunjuk) — menggambar</div>
              <div><b>Telapak terbuka</b> — ledakan partikel</div>
              <div><b>Kepalan tangan</b> — tarik partikel</div>
              <div><b>Posisi tangan</b> — nada &amp; warna suara</div>
            </div>
            <button className="start-btn" onClick={startCamera} disabled={phase === 'loading'}>
              {phase === 'loading' ? 'MEMUAT MODEL…' : 'MULAI KAMERA'}
            </button>
            {errorMsg && <div className="err mono">{errorMsg}</div>}
          </div>
        </div>
      )}
    </>
  )
}
