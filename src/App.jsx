import { useState, useRef, useCallback } from 'react'

// ── Constants ──────────────────────────────────────────────────────────────────

const QUALITY_PRESETS = [
  { label: 'Ultra',  bitDepth: 16, sampleRate: 44100, channels: 2, desc: 'CD Quality' },
  { label: 'High',   bitDepth: 16, sampleRate: 22050, channels: 2, desc: 'FM Radio'  },
  { label: 'Medium', bitDepth: 8,  sampleRate: 22050, channels: 1, desc: 'Balanced'  },
  { label: 'Low',    bitDepth: 8,  sampleRate: 11025, channels: 1, desc: 'Speech'    },
  { label: 'Micro',  bitDepth: 8,  sampleRate: 8000,  channels: 1, desc: 'Minimal'   },
]

// ── WAV helpers ────────────────────────────────────────────────────────────────

function writeWavHeader(dataLength, numChannels, sampleRate, bitDepth) {
  const byteRate   = (sampleRate * numChannels * bitDepth) / 8
  const blockAlign = (numChannels * bitDepth) / 8
  const buf  = new ArrayBuffer(44)
  const view = new DataView(buf)
  const str  = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF');  view.setUint32(4,  36 + dataLength, true)
  str(8, 'WAVE');  str(12, 'fmt ')
  view.setUint32(16, 16,          true)
  view.setUint16(20, 1,           true) // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate,  true)
  view.setUint32(28, byteRate,    true)
  view.setUint16(32, blockAlign,  true)
  view.setUint16(34, bitDepth,    true)
  str(36, 'data'); view.setUint32(40, dataLength, true)
  return buf
}

async function compressWav(arrayBuffer, preset) {
  const { bitDepth, sampleRate, channels } = preset

  // 1. Decode original audio
  const tmpCtx  = new AudioContext()
  const decoded = await tmpCtx.decodeAudioData(arrayBuffer.slice(0))
  tmpCtx.close()

  // 2. Resample to target sample rate via OfflineAudioContext
  const targetLength = Math.ceil(decoded.duration * sampleRate)
  const offCtx = new OfflineAudioContext(channels, targetLength, sampleRate)
  const src    = offCtx.createBufferSource()
  src.buffer   = decoded
  src.connect(offCtx.destination)
  src.start(0)
  const rendered = await offCtx.startRendering()

  // 3. Pre-fetch channel data (mirror ch0 into ch1 if source is mono)
  const chData = Array.from({ length: channels }, (_, c) =>
    rendered.getChannelData(Math.min(c, rendered.numberOfChannels - 1))
  )

  // 4. Encode to PCM WAV
  const numSamples = rendered.length
  const dataLength = numSamples * channels * (bitDepth / 8)
  const output     = new Uint8Array(44 + dataLength)
  output.set(new Uint8Array(writeWavHeader(dataLength, channels, sampleRate, bitDepth)), 0)

  let off = 44
  for (let i = 0; i < numSamples; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, chData[c][i]))
      if (bitDepth === 16) {
        const v = Math.round(s * 32767)
        output[off++] = v & 0xff
        output[off++] = (v >> 8) & 0xff
      } else {
        output[off++] = Math.round((s + 1) * 127.5) // 8-bit WAV is unsigned
      }
    }
  }
  return output.buffer
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// Append <a> to body → click → remove → revoke after delay (works in all browsers)
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 3000)
}

async function downloadAsZip(items) {
  // JSZip is loaded via <script> tag in index.html
  const JSZip = window.JSZip
  if (!JSZip) throw new Error('JSZip not loaded')
  const zip = new JSZip()
  for (const item of items) {
    const filename = item.name.replace(/\.wav$/i, '_compressed.wav')
    const ab = await item.compressedBlob.arrayBuffer()
    zip.file(filename, ab)
  }
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 1 },
  })
  triggerDownload(blob, 'compressed_wavs.zip')
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function App() {
  const [files,      setFiles]      = useState([])
  const [preset,     setPreset]     = useState(1)
  const [processing, setProcessing] = useState(false)
  const [dragging,   setDragging]   = useState(false)
  const [zipping,    setZipping]    = useState(false)
  const inputRef = useRef()

  // ── File management ──────────────────────────────────────────────────────────

  const addFiles = useCallback((newFiles) => {
    const wavFiles = Array.from(newFiles).filter(f => f.name.toLowerCase().endsWith('.wav'))
    if (!wavFiles.length) return
    setFiles(prev => [
      ...prev,
      ...wavFiles.map(f => ({
        file: f,
        name: f.name,
        originalSize: f.size,
        status: 'ready',
        compressedBlob: null,
        compressedSize: null,
      })),
    ])
  }, [])

  const handleDrop = (e) => {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  const removeFile = (i) => setFiles(prev => prev.filter((_, idx) => idx !== i))

  // ── Compression ──────────────────────────────────────────────────────────────

  const compressAll = async () => {
    setProcessing(true)
    const p       = QUALITY_PRESETS[preset]
    const updated = files.map(f => ({ ...f }))

    for (let i = 0; i < updated.length; i++) {
      if (updated[i].status === 'done') continue
      updated[i].status = 'processing'
      setFiles([...updated])
      try {
        const ab         = await updated[i].file.arrayBuffer()
        const compressed = await compressWav(ab, p)
        const blob       = new Blob([compressed], { type: 'audio/wav' })
        updated[i] = { ...updated[i], status: 'done', compressedBlob: blob, compressedSize: blob.size }
      } catch (err) {
        console.error(err)
        updated[i] = { ...updated[i], status: 'error' }
      }
      setFiles([...updated])
    }
    setProcessing(false)
  }

  // ── Downloads ────────────────────────────────────────────────────────────────

  const downloadFile = (item) =>
    triggerDownload(item.compressedBlob, item.name.replace(/\.wav$/i, '_compressed.wav'))

  const downloadAll = async () => {
    const done = files.filter(f => f.status === 'done')
    if (!done.length) return
    setZipping(true)
    try { await downloadAsZip(done) } catch (e) { console.error(e) }
    setZipping(false)
  }

  // ── Derived ──────────────────────────────────────────────────────────────────

  const doneCount = files.filter(f => f.status === 'done').length
  const p = QUALITY_PRESETS[preset]
  const estReduction = Math.max(0, Math.round((1 - (p.sampleRate * p.channels * p.bitDepth) / (44100 * 2 * 16)) * 100))

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="app">
      <div className="container">

        {/* ── Header ── */}
        <div className="header">
          <div className="header-badge">Audio Tool v2.0</div>
          <h1>WAV<br /><span>COMPRESSOR</span></h1>
          <p>Reduce file size · Resample · Downmix channels</p>
        </div>

        {/* ── Quality Presets ── */}
        <div className="presets">
          <div className="section-label">Quality Preset</div>
          <div className="preset-grid">
            {QUALITY_PRESETS.map((pr, i) => (
              <button
                key={i}
                className={`preset-btn ${preset === i ? 'active' : ''}`}
                onClick={() => setPreset(i)}
              >
                <div className="preset-name">{pr.label}</div>
                <div className="preset-desc">{pr.desc}</div>
              </button>
            ))}
          </div>
          <div className="preset-info">
            <span>SR: {p.sampleRate.toLocaleString()} Hz</span>
            <span>DEPTH: {p.bitDepth}-bit</span>
            <span>CH: {p.channels === 1 ? 'Mono' : 'Stereo'}</span>
            <span className="est">Est. ~{estReduction}% smaller vs CD</span>
          </div>
        </div>

        {/* ── Drop Zone ── */}
        <div
          className={`dropzone ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".wav"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => addFiles(e.target.files)}
          />
          <div className="dropzone-icon">⬆</div>
          <div className="dropzone-main">
            Drop <span>.wav</span> files here or click to browse
          </div>
          <div className="dropzone-sub">Multiple files supported · 100% local</div>
        </div>

        {/* ── File Queue ── */}
        {files.length > 0 && (
          <div className="queue">
            <div className="section-label">
              Queue — {files.length} file{files.length !== 1 ? 's' : ''}
            </div>
            <div className="file-list">
              {files.map((item, i) => {
                const ratio  = item.compressedSize
                  ? ((1 - item.compressedSize / item.originalSize) * 100).toFixed(1)
                  : null
                const bigger = ratio !== null && parseFloat(ratio) < 0
                return (
                  <div key={i} className="file-row">
                    <div className={`status-dot ${item.status}`} />
                    <div className="file-info">
                      <div className="file-name">{item.name}</div>
                      <div className="file-meta">
                        {formatBytes(item.originalSize)}
                        {item.compressedSize && (
                          <>
                            <span className="arrow">→</span>
                            <span className={`size-after ${bigger ? 'bigger' : ''}`}>
                              {formatBytes(item.compressedSize)}
                            </span>
                            <span className={`ratio ${bigger ? 'bigger' : ''}`}>
                              {bigger ? `↑${Math.abs(ratio)}%` : `↓${ratio}%`}
                            </span>
                            {bigger && <span className="hint">try a lower preset</span>}
                          </>
                        )}
                        {item.status === 'error' && (
                          <span className="err">Failed — unsupported file?</span>
                        )}
                      </div>
                    </div>
                    {item.status === 'done' && (
                      <button className="btn-save" onClick={() => downloadFile(item)}>
                        ↓ SAVE
                      </button>
                    )}
                    <button className="btn-remove" onClick={() => removeFile(i)}>✕</button>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Action Buttons ── */}
        {files.length > 0 && (
          <div className="actions">
            <button className="btn-compress" onClick={compressAll} disabled={processing}>
              {processing ? '▶ Processing…' : '▶ Compress All'}
            </button>
            {doneCount > 1 && (
              <button className="btn-zip" onClick={downloadAll} disabled={zipping}>
                {zipping ? '⏳ Zipping…' : `↓ ZIP (${doneCount})`}
              </button>
            )}
            <button className="btn-clear" onClick={() => setFiles([])}>Clear</button>
          </div>
        )}

        {/* ── Footer ── */}
        <div className="footer">
          All processing is local — nothing leaves your browser. WAV output is uncompressed
          PCM at a lower sample rate / bit depth. Files that were already low-quality may
          not shrink with higher presets.
        </div>

      </div>
    </div>
  )
}
