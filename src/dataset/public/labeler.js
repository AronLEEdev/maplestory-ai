// YOLO label editor. Reuses the rect-with-handles + zoom/pan model from
// the calibrator canvas, scoped per-frame. Boxes carry a class id; class
// names come from the server (CLASS_NAMES in src/dataset/yolo-format.ts).

const HANDLE_HIT_PX = 8

const state = {
  classes: ['player', 'mob'],
  classColors: ['#5af', '#7c5'], // 0=player blue, 1=mob green
  frames: [], // [{name, labelCount, imageUrl}]
  currentName: null,
  currentClassId: 1,
  // labeled rects in IMAGE-pixel coords
  rects: [], // {classId, x, y, w, h}
  selectedIdx: -1,
  // image
  img: null,
  imgW: 0,
  imgH: 0,
  pixelCanvas: null,
  pixelCtx: null,
  // viewport
  zoom: 1,
  panX: 0,
  panY: 0,
  // input modifier
  spaceHeld: false,
  // dirty flag — true if rects changed since last save / load
  dirty: false,
}

const cv = document.getElementById('cv')
const ctx = cv.getContext('2d')
const list = document.getElementById('frame-list')
const stats = document.getElementById('frame-stats')
const frameNameEl = document.getElementById('frame-name')
const dimInfoEl = document.getElementById('dim-info')
const statusEl = document.getElementById('status')
const clsSelect = document.getElementById('cls-select')
const btnPrev = document.getElementById('btn-prev')
const btnNext = document.getElementById('btn-next')
const btnNextUnlabeled = document.getElementById('btn-next-unlabeled')
const btnSave = document.getElementById('btn-save')
const btnEmpty = document.getElementById('btn-empty')
const btnDelete = document.getElementById('btn-delete')
const btnZoomIn = document.getElementById('btn-zoom-in')
const btnZoomOut = document.getElementById('btn-zoom-out')
const btnZoomFit = document.getElementById('btn-zoom-fit')
const btnZoom1 = document.getElementById('btn-zoom-1')

// ── Bootstrap ────────────────────────────────────────────────────────────
init()

async function init() {
  resizeCanvas()
  window.addEventListener('resize', () => {
    resizeCanvas()
    redraw()
  })
  await refreshFrameList()
  // Auto-load the first unlabeled frame, or the first frame if all are labeled.
  const firstUnlabeled = state.frames.find((f) => f.labelCount < 0)
  if (firstUnlabeled) await loadFrame(firstUnlabeled.name)
  else if (state.frames.length) await loadFrame(state.frames[0].name)
}

function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap')
  cv.width = wrap.clientWidth
  cv.height = wrap.clientHeight
}

async function refreshFrameList() {
  const resp = await fetch('/api/frames')
  const data = await resp.json()
  state.classes = data.classes ?? state.classes
  state.frames = data.frames ?? []
  // Repopulate class dropdown.
  clsSelect.innerHTML = state.classes
    .map(
      (n, i) => `<option value="${i}" ${i === state.currentClassId ? 'selected' : ''}>${n}</option>`,
    )
    .join('')
  renderFrameList()
}

function renderFrameList() {
  const total = state.frames.length
  const labeled = state.frames.filter((f) => f.labelCount > 0).length
  const empty = state.frames.filter((f) => f.labelCount === 0).length
  const unlabeled = state.frames.filter((f) => f.labelCount < 0).length
  stats.textContent = `${total} frames · labeled ${labeled} · hard-neg ${empty} · unlabeled ${unlabeled}`
  list.innerHTML = state.frames
    .map((f) => {
      const cls = []
      if (f.name === state.currentName) cls.push('active')
      if (f.labelCount > 0) cls.push('labeled')
      if (f.labelCount === 0) cls.push('empty-neg')
      const countLabel =
        f.labelCount < 0 ? '—' : f.labelCount === 0 ? 'empty' : `${f.labelCount}`
      return `<li class="${cls.join(' ')}" data-name="${f.name}">
        <span>${f.name}</span><span class="count">${countLabel}</span>
      </li>`
    })
    .join('')
  for (const li of list.querySelectorAll('li')) {
    li.addEventListener('click', () => {
      maybeWarnDirty(() => loadFrame(li.dataset.name))
    })
  }
}

async function loadFrame(name) {
  state.currentName = name
  state.rects = []
  state.selectedIdx = -1
  state.dirty = false
  frameNameEl.textContent = name
  frameNameEl.className = ''
  setStatus('loading…')
  // Load image.
  const img = await loadImage(`/api/frame/${encodeURIComponent(name)}`)
  state.img = img
  state.imgW = img.width
  state.imgH = img.height
  state.pixelCanvas = document.createElement('canvas')
  state.pixelCanvas.width = img.width
  state.pixelCanvas.height = img.height
  state.pixelCtx = state.pixelCanvas.getContext('2d', { willReadFrequently: true })
  state.pixelCtx.drawImage(img, 0, 0)
  dimInfoEl.textContent = `${img.width} × ${img.height}`
  fitToWindow()
  // Load existing labels.
  const resp = await fetch(`/api/labels/${encodeURIComponent(name)}`)
  if (resp.ok) {
    const text = await resp.text()
    state.rects = parseYoloText(text, img.width, img.height)
  }
  renderFrameList()
  redraw()
  setStatus(`loaded — ${state.rects.length} box${state.rects.length === 1 ? '' : 'es'}`)
}

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = rej
    img.src = url
  })
}

function parseYoloText(text, imgW, imgH) {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.split('#')[0].trim()
    if (!t) continue
    const [c, cx, cy, w, h] = t.split(/\s+/).map(Number)
    out.push({
      classId: c,
      x: cx * imgW - (w * imgW) / 2,
      y: cy * imgH - (h * imgH) / 2,
      w: w * imgW,
      h: h * imgH,
    })
  }
  return out
}

function serializeYolo() {
  return state.rects
    .map((r) => {
      const cx = (r.x + r.w / 2) / state.imgW
      const cy = (r.y + r.h / 2) / state.imgH
      return `${r.classId} ${clamp01(cx).toFixed(6)} ${clamp01(cy).toFixed(6)} ${clamp01(r.w / state.imgW).toFixed(6)} ${clamp01(r.h / state.imgH).toFixed(6)}`
    })
    .join('\n')
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n))
}

// ── Coordinate transforms ────────────────────────────────────────────────
function canvasToImage(cx, cy) {
  return { x: state.panX + cx / state.zoom, y: state.panY + cy / state.zoom }
}
function imageToCanvas(ix, iy) {
  return { x: (ix - state.panX) * state.zoom, y: (iy - state.panY) * state.zoom }
}
function canvasCoords(e) {
  const r = cv.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function fitToWindow() {
  if (!state.img) return
  const sx = cv.width / state.imgW
  const sy = cv.height / state.imgH
  state.zoom = Math.min(sx, sy)
  state.panX = 0
  state.panY = 0
}
function setZoom(z) {
  state.zoom = Math.max(0.05, Math.min(40, z))
}

// ── Render ───────────────────────────────────────────────────────────────
function redraw() {
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, cv.width, cv.height)
  if (!state.img) return
  ctx.imageSmoothingEnabled = state.zoom < 2
  const dstW = state.imgW * state.zoom
  const dstH = state.imgH * state.zoom
  const dstX = -state.panX * state.zoom
  const dstY = -state.panY * state.zoom
  ctx.drawImage(state.img, dstX, dstY, dstW, dstH)

  state.rects.forEach((r, i) => drawRect(r, i === state.selectedIdx))

  if (drag && drag.mode === 'new') {
    const a = imageToCanvas(drag.startImg.x, drag.startImg.y)
    const b = imageToCanvas(drag.currImg.x, drag.currImg.y)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.setLineDash([4, 4])
    ctx.strokeRect(
      Math.min(a.x, b.x),
      Math.min(a.y, b.y),
      Math.abs(b.x - a.x),
      Math.abs(b.y - a.y),
    )
    ctx.setLineDash([])
  }
}

function drawRect(rect, selected) {
  const a = imageToCanvas(rect.x, rect.y)
  const b = imageToCanvas(rect.x + rect.w, rect.y + rect.h)
  const color = state.classColors[rect.classId] ?? '#fff'
  ctx.strokeStyle = color
  ctx.lineWidth = selected ? 3 : 2
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
  // Class label
  const name = state.classes[rect.classId] ?? `?${rect.classId}`
  ctx.fillStyle = color
  ctx.font = '12px ui-monospace'
  ctx.fillText(name, a.x + 4, a.y - 4)
  if (selected) {
    drawHandles(a, b)
  }
}

function drawHandles(a, b) {
  const cxs = [a.x, (a.x + b.x) / 2, b.x]
  const cys = [a.y, (a.y + b.y) / 2, b.y]
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#000'
  ctx.lineWidth = 1
  for (const hx of cxs) {
    for (const hy of cys) {
      if (hx === cxs[1] && hy === cys[1]) continue
      ctx.fillRect(hx - 4, hy - 4, 8, 8)
      ctx.strokeRect(hx - 4, hy - 4, 8, 8)
    }
  }
}

// ── Hit-test + drag/pan ──────────────────────────────────────────────────
let drag = null
let pan = null

function hitTestRect(ip, rect) {
  if (!rect) return null
  const r = HANDLE_HIT_PX / state.zoom
  const x1 = rect.x,
    y1 = rect.y,
    x2 = rect.x + rect.w,
    y2 = rect.y + rect.h
  const onL = Math.abs(ip.x - x1) <= r
  const onR = Math.abs(ip.x - x2) <= r
  const onT = Math.abs(ip.y - y1) <= r
  const onB = Math.abs(ip.y - y2) <= r
  const inX = ip.x >= x1 - r && ip.x <= x2 + r
  const inY = ip.y >= y1 - r && ip.y <= y2 + r
  if (onL && onT && inX && inY) return { mode: 'resize', handle: 'tl' }
  if (onR && onT && inX && inY) return { mode: 'resize', handle: 'tr' }
  if (onL && onB && inX && inY) return { mode: 'resize', handle: 'bl' }
  if (onR && onB && inX && inY) return { mode: 'resize', handle: 'br' }
  if (onT && inX) return { mode: 'resize', handle: 't' }
  if (onB && inX) return { mode: 'resize', handle: 'b' }
  if (onL && inY) return { mode: 'resize', handle: 'l' }
  if (onR && inY) return { mode: 'resize', handle: 'r' }
  if (ip.x >= x1 && ip.x <= x2 && ip.y >= y1 && ip.y <= y2) return { mode: 'move' }
  return null
}

function applyHandleDelta(orig, handle, dx, dy) {
  let { x, y, w, h } = orig
  if (handle.includes('l')) {
    x += dx
    w -= dx
  }
  if (handle.includes('r')) {
    w += dx
  }
  if (handle.includes('t')) {
    y += dy
    h -= dy
  }
  if (handle.includes('b')) {
    h += dy
  }
  return { x, y, w, h }
}

cv.addEventListener('mousedown', (e) => {
  const c = canvasCoords(e)
  const ip = canvasToImage(c.x, c.y)
  // pan triggers
  if (e.button === 1 || e.button === 2 || e.shiftKey || state.spaceHeld) {
    e.preventDefault()
    pan = { startCv: c, startPanX: state.panX, startPanY: state.panY }
    cv.style.cursor = 'grabbing'
    return
  }
  if (e.button !== 0 || !state.img) return

  // Hit test the SELECTED rect first (its handles need priority over
  // overlapping rects underneath).
  if (state.selectedIdx >= 0) {
    const sel = state.rects[state.selectedIdx]
    const hit = hitTestRect(ip, sel)
    if (hit) {
      drag = {
        mode: hit.mode,
        handle: hit.handle,
        startImg: ip,
        currImg: ip,
        origRect: { ...sel },
        targetIdx: state.selectedIdx,
      }
      return
    }
  }
  // Then check other rects (top of z-order = highest index = drawn last).
  for (let i = state.rects.length - 1; i >= 0; i--) {
    if (i === state.selectedIdx) continue
    const r = state.rects[i]
    const hit = hitTestRect(ip, r)
    if (hit && hit.mode === 'move') {
      state.selectedIdx = i
      drag = {
        mode: 'move',
        startImg: ip,
        currImg: ip,
        origRect: { ...r },
        targetIdx: i,
      }
      redraw()
      return
    }
  }
  // Empty area: deselect + start a fresh box.
  state.selectedIdx = -1
  drag = { mode: 'new', startImg: ip, currImg: ip }
  redraw()
})

window.addEventListener('mousemove', (e) => {
  if (!pan && !drag) return
  const c = canvasCoords(e)
  const ip = canvasToImage(c.x, c.y)
  if (pan) {
    const dx = c.x - pan.startCv.x
    const dy = c.y - pan.startCv.y
    state.panX = pan.startPanX - dx / state.zoom
    state.panY = pan.startPanY - dy / state.zoom
  } else if (drag) {
    drag.currImg = ip
    if (drag.mode === 'move') {
      const dx = ip.x - drag.startImg.x
      const dy = ip.y - drag.startImg.y
      const r = state.rects[drag.targetIdx]
      r.x = drag.origRect.x + dx
      r.y = drag.origRect.y + dy
    } else if (drag.mode === 'resize') {
      const dx = ip.x - drag.startImg.x
      const dy = ip.y - drag.startImg.y
      const next = applyHandleDelta(drag.origRect, drag.handle, dx, dy)
      const r = state.rects[drag.targetIdx]
      r.x = next.x
      r.y = next.y
      r.w = next.w
      r.h = next.h
    }
  }
  redraw()
})

window.addEventListener('mouseup', () => {
  if (pan) {
    pan = null
    cv.style.cursor = state.spaceHeld ? 'grab' : 'crosshair'
    return
  }
  if (!drag) return
  if (drag.mode === 'new') {
    const sx = Math.min(drag.startImg.x, drag.currImg.x)
    const sy = Math.min(drag.startImg.y, drag.currImg.y)
    const ex = Math.max(drag.startImg.x, drag.currImg.x)
    const ey = Math.max(drag.startImg.y, drag.currImg.y)
    const w = ex - sx
    const h = ey - sy
    drag = null
    if (w < 4 || h < 4) {
      redraw()
      return
    }
    state.rects.push({ classId: state.currentClassId, x: sx, y: sy, w, h })
    state.selectedIdx = state.rects.length - 1
    state.dirty = true
    markDirty()
  } else {
    const r = state.rects[drag.targetIdx]
    if (r.w < 0) {
      r.x += r.w
      r.w = -r.w
    }
    if (r.h < 0) {
      r.y += r.h
      r.h = -r.h
    }
    r.x = Math.round(r.x)
    r.y = Math.round(r.y)
    r.w = Math.round(r.w)
    r.h = Math.round(r.h)
    drag = null
    state.dirty = true
    markDirty()
  }
  redraw()
})

cv.addEventListener('contextmenu', (e) => e.preventDefault())

cv.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    if (!state.img) return
    const c = canvasCoords(e)
    const before = canvasToImage(c.x, c.y)
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2
    setZoom(state.zoom * factor)
    state.panX = before.x - c.x / state.zoom
    state.panY = before.y - c.y / state.zoom
    redraw()
  },
  { passive: false },
)

// ── Keyboard ─────────────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return
  if (e.code === 'Space') {
    if (!state.spaceHeld) {
      state.spaceHeld = true
      cv.style.cursor = 'grab'
    }
    e.preventDefault()
    return
  }
  if (e.key === '+' || e.key === '=') {
    setZoom(state.zoom * 1.5)
    redraw()
  } else if (e.key === '-' || e.key === '_') {
    setZoom(state.zoom / 1.5)
    redraw()
  } else if (e.key === '0') {
    fitToWindow()
    redraw()
  } else if (e.key === '1') {
    setZoom(1)
    redraw()
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (state.selectedIdx >= 0) {
      state.rects.splice(state.selectedIdx, 1)
      state.selectedIdx = -1
      state.dirty = true
      markDirty()
      redraw()
    }
  } else if (/^[0-9]$/.test(e.key)) {
    const id = Number(e.key)
    if (id < state.classes.length && state.selectedIdx >= 0) {
      state.rects[state.selectedIdx].classId = id
      state.dirty = true
      markDirty()
      redraw()
    } else if (id < state.classes.length) {
      state.currentClassId = id
      clsSelect.value = String(id)
    }
  } else if (e.key === 's') {
    saveCurrent()
  } else if (e.key === 'e') {
    saveExplicitEmpty()
  } else if (e.key === 'd') {
    deleteCurrent()
  } else if (e.key === 'n') {
    nextUnlabeled()
  } else if (e.key === 'ArrowLeft') {
    prevFrame()
  } else if (e.key === 'ArrowRight') {
    nextFrame()
  }
})
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    state.spaceHeld = false
    cv.style.cursor = 'crosshair'
  }
})

clsSelect.addEventListener('change', () => {
  state.currentClassId = Number(clsSelect.value)
  if (state.selectedIdx >= 0) {
    state.rects[state.selectedIdx].classId = state.currentClassId
    state.dirty = true
    markDirty()
    redraw()
  }
})

btnZoomIn.addEventListener('click', () => {
  setZoom(state.zoom * 1.5)
  redraw()
})
btnZoomOut.addEventListener('click', () => {
  setZoom(state.zoom / 1.5)
  redraw()
})
btnZoomFit.addEventListener('click', () => {
  fitToWindow()
  redraw()
})
btnZoom1.addEventListener('click', () => {
  const cx = cv.width / 2
  const cy = cv.height / 2
  const before = canvasToImage(cx, cy)
  setZoom(1)
  state.panX = before.x - cx / state.zoom
  state.panY = before.y - cy / state.zoom
  redraw()
})

btnSave.addEventListener('click', saveCurrent)
btnEmpty.addEventListener('click', saveExplicitEmpty)
btnDelete.addEventListener('click', deleteCurrent)
btnPrev.addEventListener('click', prevFrame)
btnNext.addEventListener('click', nextFrame)
btnNextUnlabeled.addEventListener('click', nextUnlabeled)

async function saveCurrent() {
  if (!state.currentName) return
  const text = serializeYolo()
  setStatus('saving…')
  const resp = await fetch(`/api/labels/${encodeURIComponent(state.currentName)}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: text,
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    setStatus(`save failed: ${err.error ?? resp.statusText}`, true)
    return
  }
  state.dirty = false
  // Update local frame list count without a round-trip.
  const f = state.frames.find((x) => x.name === state.currentName)
  if (f) f.labelCount = state.rects.length === 0 ? 0 : state.rects.length
  renderFrameList()
  setStatus(`saved ${state.rects.length} box${state.rects.length === 1 ? '' : 'es'}`)
}

async function saveExplicitEmpty() {
  state.rects = []
  state.selectedIdx = -1
  state.dirty = true
  redraw()
  await saveCurrent()
}

async function deleteCurrent() {
  if (!state.currentName) return
  if (!confirm(`Delete frame ${state.currentName}? This removes the PNG and any label.`)) return
  const resp = await fetch(`/api/frame/${encodeURIComponent(state.currentName)}`, {
    method: 'DELETE',
  })
  if (!resp.ok) {
    setStatus('delete failed', true)
    return
  }
  // Drop from local list, advance to next.
  const idx = state.frames.findIndex((f) => f.name === state.currentName)
  state.frames.splice(idx, 1)
  if (state.frames.length === 0) {
    state.currentName = null
    state.img = null
    state.rects = []
    state.dirty = false
    redraw()
    renderFrameList()
    return
  }
  const next = state.frames[Math.min(idx, state.frames.length - 1)]
  await loadFrame(next.name)
}

function currentIdx() {
  return state.frames.findIndex((f) => f.name === state.currentName)
}

function maybeWarnDirty(go) {
  if (state.dirty && !confirm('Unsaved labels — discard?')) return
  go()
}

async function prevFrame() {
  const i = currentIdx()
  if (i > 0) maybeWarnDirty(() => loadFrame(state.frames[i - 1].name))
}
async function nextFrame() {
  const i = currentIdx()
  if (i >= 0 && i < state.frames.length - 1) {
    maybeWarnDirty(() => loadFrame(state.frames[i + 1].name))
  }
}
async function nextUnlabeled() {
  const i = currentIdx()
  const start = i + 1
  for (let k = 0; k < state.frames.length; k++) {
    const idx = (start + k) % state.frames.length
    if (state.frames[idx].labelCount < 0) {
      maybeWarnDirty(() => loadFrame(state.frames[idx].name))
      return
    }
  }
  setStatus('no unlabeled frames left')
}

function markDirty() {
  frameNameEl.className = 'dim'
  frameNameEl.textContent = `${state.currentName} *`
}
function setStatus(msg, isError) {
  statusEl.textContent = msg
  statusEl.style.color = isError ? '#f77' : '#888'
}
