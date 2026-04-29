// Calibration wizard — pure browser-side logic.
// Posts coordinates back to the fastify server on Save.

const STEPS = [
  { id: 'window', label: '1. Game window', mode: 'rect' },
  { id: 'hp', label: '2. HP region', mode: 'rect' },
  { id: 'mp', label: '3. MP region', mode: 'rect' },
  { id: 'minimap', label: '4. Minimap', mode: 'rect' },
  { id: 'minimap-points', label: '5. Player + bounds + waypoints', mode: 'points' },
  { id: 'mobs', label: '6. Mob & player crops', mode: 'multi-rect' },
]

const state = {
  stepIdx: 0,
  windowTitle: 'MapleStory Worlds',
  // step outputs
  gameWindow: null,
  regions: { hp: null, mp: null, minimap: null },
  playerDotAt: null,
  playerDotRgb: null,
  bounds: null,
  waypointXs: [],
  mobCrops: [],
  playerCrop: null,
  // canvas/viewport state
  img: null,
  zoom: 1, // canvas-pixels per image-pixel
  panX: 0, // image-pixel offset of viewport's top-left
  panY: 0,
  // colors for the cursor-pixel readout
  cursorImgX: 0,
  cursorImgY: 0,
  cursorRgb: null, // [r,g,b]
  // hidden canvas for fast pixel reads
  pixelCanvas: null,
  pixelCtx: null,
  // points-mode state
  pointPhase: 0, // 0=player, 1=boundsTL, 2=boundsBR, 3+=waypoints
  // input modifiers
  spaceHeld: false,
  handTool: false,
}

const HANDLE_HIT_PX = 8 // hit radius for resize handles (canvas pixels)

const cv = document.getElementById('cv')
const ctx = cv.getContext('2d')
const instrText = document.getElementById('instr-text')
const instrHint = document.getElementById('instr-hint')
const stepIndicator = document.getElementById('step-indicator')
const stateList = document.getElementById('state-list')
const cursorInfo = document.getElementById('cursor-info')
const btnBack = document.getElementById('btn-back')
const btnNext = document.getElementById('btn-next')
const btnClear = document.getElementById('btn-clear')
const btnSave = document.getElementById('btn-save')
const btnCancel = document.getElementById('btn-cancel')
const btnZoomIn = document.getElementById('btn-zoom-in')
const btnZoomOut = document.getElementById('btn-zoom-out')
const btnZoomFit = document.getElementById('btn-zoom-fit')
const btnZoom1 = document.getElementById('btn-zoom-1')
const btnHand = document.getElementById('btn-hand')

// ── Bootstrap: load the screenshot + any existing calibration ────────────
const img = new Image()
img.onload = async () => {
  state.img = img
  resizeCanvas()
  state.pixelCanvas = document.createElement('canvas')
  state.pixelCanvas.width = img.width
  state.pixelCanvas.height = img.height
  state.pixelCtx = state.pixelCanvas.getContext('2d', { willReadFrequently: true })
  state.pixelCtx.drawImage(img, 0, 0)
  fitToWindow()
  await hydrateFromExisting()
  redraw()
  updateUI()
}
img.src = '/screenshot.png'

// Pull last-saved SaveBody from the server and prefill state. Lets the user
// edit a single step instead of redoing every step on recalibrate.
async function hydrateFromExisting() {
  try {
    const resp = await fetch('/existing')
    if (!resp.ok) return
    const data = await resp.json()
    if (!data.ok || !data.body) return
    const b = data.body
    state.windowTitle = b.windowTitle ?? state.windowTitle
    state.gameWindow = b.gameWindow ?? null
    state.regions = {
      hp: b.regions?.hp ?? null,
      mp: b.regions?.mp ?? null,
      minimap: b.regions?.minimap ?? null,
    }
    state.playerDotAt = b.playerDotAt ?? null
    if (b.playerDotAt && state.pixelCtx) {
      const ix = Math.max(0, Math.min(state.img.width - 1, Math.round(b.playerDotAt.x)))
      const iy = Math.max(0, Math.min(state.img.height - 1, Math.round(b.playerDotAt.y)))
      const d = state.pixelCtx.getImageData(ix, iy, 1, 1).data
      state.playerDotRgb = [d[0], d[1], d[2]]
    }
    state.bounds = b.bounds ?? null
    state.waypointXs = Array.isArray(b.waypointXs) ? [...b.waypointXs] : []
    state.mobCrops = Array.isArray(b.mobCrops) ? b.mobCrops.map((m) => ({ ...m })) : []
    if (b.playerCrop) {
      // Carry the player crop in mobCrops with the reserved name `_player`
      // so the existing UI controls (rename / unmark / remove) work uniformly.
      state.mobCrops.push({ name: '_player', rect: b.playerCrop })
    }
    // Move past the points step if all sub-points already captured.
    state.pointPhase =
      state.playerDotAt && state.bounds?.bottomRight ? 3 + state.waypointXs.length : 0
    if (data.resolution) {
      const [rw, rh] = data.resolution
      if (rw !== state.img.width || rh !== state.img.height) {
        const banner = document.getElementById('instr-hint')
        if (banner) {
          banner.innerHTML =
            `<span style="color:#fa5">⚠ existing calibration is from ${rw}×${rh}; current screenshot is ${state.img.width}×${state.img.height}. Rectangles may be off.</span>`
        }
      }
    }
  } catch {
    /* fall through to fresh wizard */
  }
}

window.addEventListener('resize', () => {
  resizeCanvas()
  redraw()
})

// Click any step pill to jump to that step. Lets the user edit one piece of
// the calibration without re-walking the whole wizard.
stepIndicator.addEventListener('click', (e) => {
  const t = e.target.closest('[data-step-idx]')
  if (!t) return
  const idx = Number(t.dataset.stepIdx)
  if (Number.isFinite(idx) && idx >= 0 && idx < STEPS.length) {
    state.stepIdx = idx
    if (STEPS[idx].id === 'minimap-points') {
      // Resume points sub-wizard at the next missing piece.
      state.pointPhase = !state.playerDotAt
        ? 0
        : !state.bounds?.topLeft
          ? 1
          : !state.bounds?.bottomRight
            ? 2
            : 3 + state.waypointXs.length
    }
    redraw()
    updateUI()
  }
})

function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap')
  // canvas fills its container; use clientWidth/Height in CSS pixels.
  cv.width = wrap.clientWidth
  cv.height = wrap.clientHeight
}

function fitToWindow() {
  if (!state.img) return
  const sx = cv.width / state.img.width
  const sy = cv.height / state.img.height
  state.zoom = Math.min(sx, sy)
  state.panX = 0
  state.panY = 0
}

// ── Coordinate transforms ────────────────────────────────────────────────
// canvas px → image px
function canvasToImage(cx, cy) {
  return {
    x: state.panX + cx / state.zoom,
    y: state.panY + cy / state.zoom,
  }
}
// image px → canvas px
function imageToCanvas(ix, iy) {
  return {
    x: (ix - state.panX) * state.zoom,
    y: (iy - state.panY) * state.zoom,
  }
}

function canvasCoords(e) {
  const r = cv.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

// ── Render ───────────────────────────────────────────────────────────────
function redraw() {
  if (!state.img) return
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, cv.width, cv.height)
  // Use imageSmoothingEnabled = false for crisp pixel inspection at high zoom.
  ctx.imageSmoothingEnabled = state.zoom < 2
  // Source rect within image; destination rect within canvas.
  // Compute the visible portion of the image in canvas-space and draw with
  // an explicit src/dst rect so panning works at the canvas boundaries.
  const dstW = state.img.width * state.zoom
  const dstH = state.img.height * state.zoom
  const dstX = -state.panX * state.zoom
  const dstY = -state.panY * state.zoom
  ctx.drawImage(state.img, dstX, dstY, dstW, dstH)

  // Overlays
  drawRect(state.gameWindow, '#5af', '1 win')
  drawRect(state.regions.hp, '#f57', '2 hp')
  drawRect(state.regions.mp, '#5cf', '3 mp')
  drawRect(state.regions.minimap, '#fa5', '4 mini')
  for (const m of state.mobCrops) {
    drawRect(m.rect, m.name === '_player' ? '#fa3' : '#7c5', m.name)
  }
  if (state.playerCrop) drawRect(state.playerCrop, '#fa3', 'player')

  if (state.playerDotAt) drawDot(state.playerDotAt.x, state.playerDotAt.y, '#fa5', 'dot')
  if (state.bounds && state.regions.minimap) {
    const mm = state.regions.minimap
    if (state.bounds.topLeft) {
      drawDot(mm.x + state.bounds.topLeft.x, mm.y + state.bounds.topLeft.y, '#5af', 'TL')
    }
    if (state.bounds.bottomRight) {
      drawDot(
        mm.x + state.bounds.bottomRight.x,
        mm.y + state.bounds.bottomRight.y,
        '#5af',
        'BR',
      )
      drawRect(
        {
          x: mm.x + state.bounds.topLeft.x,
          y: mm.y + state.bounds.topLeft.y,
          w: state.bounds.bottomRight.x - state.bounds.topLeft.x,
          h: state.bounds.bottomRight.y - state.bounds.topLeft.y,
        },
        '#5af80',
        'bounds',
      )
    }
  }
  if (state.regions.minimap) {
    const mm = state.regions.minimap
    state.waypointXs.forEach((wx, i) => {
      drawDot(mm.x + wx, mm.y + (state.bounds?.topLeft?.y ?? 0), '#7c5', `w${i + 1}`)
    })
  }

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

  // Draw resize handles for the current step's editable rect.
  const editable = currentEditableRect()
  if (editable.rect) drawHandles(editable.rect)
}

function drawHandles(rect) {
  const a = imageToCanvas(rect.x, rect.y)
  const b = imageToCanvas(rect.x + rect.w, rect.y + rect.h)
  const cxs = [a.x, (a.x + b.x) / 2, b.x]
  const cys = [a.y, (a.y + b.y) / 2, b.y]
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#000'
  ctx.lineWidth = 1
  for (const hx of cxs) {
    for (const hy of cys) {
      if (hx === cxs[1] && hy === cys[1]) continue // skip center
      ctx.fillRect(hx - 4, hy - 4, 8, 8)
      ctx.strokeRect(hx - 4, hy - 4, 8, 8)
    }
  }
}

function drawRect(rect, color, label) {
  if (!rect) return
  const a = imageToCanvas(rect.x, rect.y)
  const b = imageToCanvas(rect.x + rect.w, rect.y + rect.h)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
  ctx.fillStyle = color
  ctx.font = '12px ui-monospace'
  ctx.fillText(label, a.x + 4, a.y - 2)
}

function drawDot(ix, iy, color, label) {
  const p = imageToCanvas(ix, iy)
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(p.x, p.y, 5, 0, Math.PI * 2)
  ctx.fill()
  ctx.font = '11px ui-monospace'
  ctx.fillText(label, p.x + 8, p.y + 4)
}

// ── Mouse: drag-rect, points, panning, wheel-zoom ────────────────────────
// drag: { mode: 'new'|'move'|'resize', handle?, startImg, currImg, origRect?, target? }
// pan: { startCv, startPanX, startPanY }
let drag = null
let pan = null

// Explicit pan triggers — always pan, override any rect editing.
function panForced(e) {
  return e.button === 1 || e.button === 2 || e.shiftKey || state.spaceHeld
}
// Soft pan trigger — pan only when click misses a resize handle / rect interior.
function panSoft() {
  return state.handTool
}

// Returns the editable rect for the current step (last mob crop in multi-rect),
// as a live view: `get rect()` always reads the current value, so mouseup
// reads the rect after resize, not the snapshot from mousedown.
function currentEditableRect() {
  const step = STEPS[state.stepIdx]
  if (step.mode === 'rect') {
    if (step.id === 'window') {
      return {
        get rect() {
          return state.gameWindow
        },
        set: (r) => (state.gameWindow = r),
      }
    }
    return {
      get rect() {
        return state.regions[step.id]
      },
      set: (r) => (state.regions[step.id] = r),
    }
  }
  if (step.mode === 'multi-rect') {
    const last = state.mobCrops[state.mobCrops.length - 1]
    if (!last) return { rect: null, set: null }
    return {
      get rect() {
        return last.rect
      },
      set: (r) => (last.rect = r),
    }
  }
  return { rect: null, set: null }
}

// Hit-test image-point against rect; returns mode + handle string.
// Handles in canvas-pixel space so they stay grabbable regardless of zoom.
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

const HANDLE_CURSORS = {
  tl: 'nwse-resize',
  br: 'nwse-resize',
  tr: 'nesw-resize',
  bl: 'nesw-resize',
  t: 'ns-resize',
  b: 'ns-resize',
  l: 'ew-resize',
  r: 'ew-resize',
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
  // Allow flipping (negative w/h) — normalized on commit.
  return { x, y, w, h }
}

cv.addEventListener('mousedown', (e) => {
  // Forced pan (explicit modifier) always wins — even over resize handles.
  if (panForced(e)) {
    e.preventDefault()
    pan = {
      startCv: canvasCoords(e),
      startPanX: state.panX,
      startPanY: state.panY,
    }
    cv.style.cursor = 'grabbing'
    return
  }
  if (e.button !== 0) return
  const step = STEPS[state.stepIdx]
  const c = canvasCoords(e)
  const ip = canvasToImage(c.x, c.y)
  if (step.mode === 'rect' || step.mode === 'multi-rect') {
    const editable = currentEditableRect()
    const hit = hitTestRect(ip, editable.rect)
    // Prefer resize/move when click hits a handle or rect interior — even if
    // hand tool is on. The user grabbed a clearly-interactive affordance.
    if (hit && editable.set) {
      drag = {
        mode: hit.mode,
        handle: hit.handle,
        startImg: ip,
        currImg: ip,
        origRect: { ...editable.rect },
        target: editable,
      }
      return
    }
  }
  // Empty canvas + hand tool → pan.
  if (panSoft()) {
    e.preventDefault()
    pan = {
      startCv: canvasCoords(e),
      startPanX: state.panX,
      startPanY: state.panY,
    }
    cv.style.cursor = 'grabbing'
    return
  }
  // Otherwise: start a fresh rect draw (only valid in rect/multi-rect steps).
  if (step.mode === 'rect' || step.mode === 'multi-rect') {
    drag = { mode: 'new', startImg: ip, currImg: ip }
  }
})

// Mousemove is on `window` (not `cv`) so a drag that leaves the canvas — e.g.
// resizing the right edge of a rect when zoomed in — keeps tracking. Without
// this, the cursor crosses the canvas boundary and mousemove stops firing,
// pinning the resize at the viewport edge.
window.addEventListener('mousemove', (e) => {
  const c = canvasCoords(e)
  const ip = canvasToImage(c.x, c.y)
  // Only refresh the cursor pixel readout when the pointer is over the canvas
  // itself, or while a drag/pan is active (so the readout follows the gesture).
  const overCanvas = e.target === cv
  if (overCanvas || pan || drag) {
    state.cursorImgX = Math.round(ip.x)
    state.cursorImgY = Math.round(ip.y)
    if (state.pixelCtx) {
      const ix = Math.max(0, Math.min(state.img.width - 1, state.cursorImgX))
      const iy = Math.max(0, Math.min(state.img.height - 1, state.cursorImgY))
      try {
        const d = state.pixelCtx.getImageData(ix, iy, 1, 1).data
        state.cursorRgb = [d[0], d[1], d[2]]
      } catch {
        state.cursorRgb = null
      }
    }
  }
  if (pan) {
    const dx = c.x - pan.startCv.x
    const dy = c.y - pan.startCv.y
    state.panX = pan.startPanX - dx / state.zoom
    state.panY = pan.startPanY - dy / state.zoom
  } else if (drag) {
    drag.currImg = ip
    if (drag.mode === 'move' && drag.target) {
      const dx = ip.x - drag.startImg.x
      const dy = ip.y - drag.startImg.y
      drag.target.set({
        x: drag.origRect.x + dx,
        y: drag.origRect.y + dy,
        w: drag.origRect.w,
        h: drag.origRect.h,
      })
    } else if (drag.mode === 'resize' && drag.target) {
      const dx = ip.x - drag.startImg.x
      const dy = ip.y - drag.startImg.y
      drag.target.set(applyHandleDelta(drag.origRect, drag.handle, dx, dy))
    }
  } else if (overCanvas) {
    // Hover cursor feedback. Resize/move handles win over hand-tool grab so
    // the cursor advertises the resize affordance the click will actually do.
    const editable = currentEditableRect()
    const hit = hitTestRect(ip, editable.rect)
    if (hit) {
      cv.style.cursor = hit.mode === 'move' ? 'move' : HANDLE_CURSORS[hit.handle]
    } else if (e.shiftKey || state.spaceHeld || state.handTool) {
      cv.style.cursor = 'grab'
    } else {
      cv.style.cursor = 'crosshair'
    }
  }
  if (pan || drag) redraw()
  if (overCanvas || pan || drag) updateCursorReadout()
})

window.addEventListener('mouseup', () => {
  if (pan) {
    pan = null
    cv.style.cursor = state.spaceHeld || state.handTool ? 'grab' : 'crosshair'
    return
  }
  if (!drag) return
  if (drag.mode === 'new') {
    const sx = Math.min(drag.startImg.x, drag.currImg.x)
    const sy = Math.min(drag.startImg.y, drag.currImg.y)
    const ex = Math.max(drag.startImg.x, drag.currImg.x)
    const ey = Math.max(drag.startImg.y, drag.currImg.y)
    const rect = {
      x: Math.round(sx),
      y: Math.round(sy),
      w: Math.round(ex - sx),
      h: Math.round(ey - sy),
    }
    drag = null
    if (rect.w < 4 || rect.h < 4) {
      redraw()
      return
    }
    const step = STEPS[state.stepIdx]
    if (step.mode === 'rect') setStepRect(step.id, rect)
    else if (step.mode === 'multi-rect') addMultiRect(rect)
  } else if (drag.target) {
    // Normalize after move/resize: flip negative w/h, round to integers.
    const r = { ...drag.target.rect }
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
    drag.target.set(r)
    drag = null
  }
  redraw()
  updateUI()
})

// Suppress browser context menu on right-click drag.
cv.addEventListener('contextmenu', (e) => e.preventDefault())

cv.addEventListener('click', async (e) => {
  if (pan || drag || e.shiftKey || state.spaceHeld || state.handTool) return
  const step = STEPS[state.stepIdx]
  if (step.mode !== 'points') return
  const c = canvasCoords(e)
  const ip = canvasToImage(c.x, c.y)
  await registerPoint(Math.round(ip.x), Math.round(ip.y))
  redraw()
  updateUI()
})

// Mousewheel zoom — anchor at cursor.
cv.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const c = canvasCoords(e)
    const before = canvasToImage(c.x, c.y)
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2
    setZoom(state.zoom * factor)
    // re-anchor: point under cursor stays the same image pixel
    state.panX = before.x - c.x / state.zoom
    state.panY = before.y - c.y / state.zoom
    redraw()
    updateCursorReadout()
  },
  { passive: false },
)

function setZoom(z) {
  state.zoom = Math.max(0.05, Math.min(40, z))
}

// ── Step helpers ─────────────────────────────────────────────────────────
function setStepRect(id, rect) {
  if (id === 'window') state.gameWindow = rect
  else if (id === 'hp') state.regions.hp = rect
  else if (id === 'mp') state.regions.mp = rect
  else if (id === 'minimap') state.regions.minimap = rect
}

function addMultiRect(rect) {
  const idx = state.mobCrops.length
  state.mobCrops.push({ name: `mob${idx + 1}`, rect })
}

async function registerPoint(ix, iy) {
  const minimap = state.regions.minimap
  if (!minimap) {
    alert('Step 5 needs the minimap region first. Go back to Step 4.')
    return
  }
  const lx = ix - minimap.x
  const ly = iy - minimap.y
  if (state.pointPhase === 0) {
    state.playerDotAt = { x: ix, y: iy }
    try {
      const resp = await fetch('/sample-color', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: ix, y: iy }),
      })
      const data = await resp.json()
      state.playerDotRgb = data.rgb
    } catch (err) {
      alert('Failed to sample color: ' + err.message)
    }
    state.pointPhase = 1
  } else if (state.pointPhase === 1) {
    state.bounds = { topLeft: { x: lx, y: ly }, bottomRight: null }
    state.pointPhase = 2
  } else if (state.pointPhase === 2) {
    state.bounds.bottomRight = { x: lx, y: ly }
    state.pointPhase = 3
  } else {
    state.waypointXs.push(lx)
    state.pointPhase++
  }
}

// Returns true when the step has captured data — used to show "done" pill
// even after re-hydration where stepIdx is 0 but earlier steps already have data.
function stepHasData(stepId) {
  if (stepId === 'window') return !!state.gameWindow
  if (stepId === 'hp' || stepId === 'mp' || stepId === 'minimap') return !!state.regions[stepId]
  if (stepId === 'minimap-points')
    return (
      !!state.playerDotAt &&
      !!state.bounds?.bottomRight &&
      state.waypointXs.length >= 2
    )
  if (stepId === 'mobs') return state.mobCrops.length > 0
  return false
}

// ── UI updates ───────────────────────────────────────────────────────────
function updateUI() {
  const step = STEPS[state.stepIdx]
  stepIndicator.innerHTML = STEPS.map((s, i) => {
    const has = stepHasData(s.id)
    const cls = i === state.stepIdx ? 'active' : has ? 'done' : ''
    return `<span class="step ${cls}" data-step-idx="${i}" role="button">${s.label}${has && i !== state.stepIdx ? ' ✓' : ''}</span>`
  }).join('')

  if (step.id === 'window') {
    instrText.textContent = 'Drag a rectangle around the entire Maplestory game window.'
    instrHint.textContent =
      'Tip: scroll the mouse wheel to zoom. Shift-drag (or middle/right-drag) to pan.'
  } else if (step.id === 'hp') {
    instrText.textContent =
      'Drag tightly around the HP bar (the colored fill area, not the text label).'
    instrHint.textContent = 'Zoom in (mousewheel) for accurate cropping. Shift-drag pans.'
  } else if (step.id === 'mp') {
    instrText.textContent = 'Drag tightly around the MP bar.'
    instrHint.textContent = 'Same idea — bar only, no text. Zoom in for accuracy.'
  } else if (step.id === 'minimap') {
    instrText.textContent = 'Drag a rectangle around the entire minimap.'
    instrHint.textContent = 'Should encompass the playable map area shown in the minimap.'
  } else if (step.id === 'minimap-points') {
    if (state.pointPhase === 0) {
      instrText.textContent = 'Click the player dot on the minimap.'
      instrHint.textContent = 'Zoom in first if the dot is small. Color sampled live.'
    } else if (state.pointPhase === 1) {
      instrText.textContent = 'Click the TOP-LEFT corner of the patrol area on the minimap.'
      instrHint.textContent = 'Where the platform you grind on starts.'
    } else if (state.pointPhase === 2) {
      instrText.textContent =
        'Click the BOTTOM-RIGHT corner of the patrol area on the minimap.'
      instrHint.textContent = 'Closes the bounding box.'
    } else {
      instrText.textContent = `Click waypoint ${state.waypointXs.length + 1} (or press Next when done — need at least 2).`
      instrHint.textContent = 'Each click adds an x-coordinate the bot will walk to.'
    }
  } else if (step.id === 'mobs') {
    instrText.textContent =
      'Drag rectangles around mob sprites (and optionally one over your character).'
    instrHint.textContent =
      'Zoom in for tight crops. Click "set as player" in the panel to mark a sprite as your character.'
  }

  stateList.innerHTML = renderStateList()
  btnBack.disabled = state.stepIdx === 0
  btnSave.disabled = !canSave()
  updateCursorReadout()
}

function updateCursorReadout() {
  if (!cursorInfo) return
  const rgb = state.cursorRgb
  const swatch = rgb
    ? `<span class="swatch" style="background: rgb(${rgb.join(',')})"></span>`
    : ''
  const rgbText = rgb ? `rgb(${rgb.join(', ')})` : '—'
  cursorInfo.innerHTML =
    `<b>cursor:</b> (${state.cursorImgX}, ${state.cursorImgY})<br>` +
    `<b>color:</b> ${swatch}${rgbText}<br>` +
    `<b>zoom:</b> ${state.zoom.toFixed(2)}x · pan (${Math.round(state.panX)}, ${Math.round(state.panY)})`
}

function renderStateList() {
  const fmt = (r) =>
    r ? `[${r.x}, ${r.y}, ${r.w}x${r.h}]` : '<span class="empty">unset</span>'
  let s = ''
  s += rowHTML('1 window', fmt(state.gameWindow))
  s += rowHTML('2 hp', fmt(state.regions.hp))
  s += rowHTML('3 mp', fmt(state.regions.mp))
  s += rowHTML('4 minimap', fmt(state.regions.minimap))
  if (state.playerDotRgb)
    s += rowHTML('player dot', `rgb(${state.playerDotRgb.join(', ')})`)
  if (state.bounds && state.bounds.bottomRight) {
    const tl = state.bounds.topLeft
    const br = state.bounds.bottomRight
    s += rowHTML('bounds', `[${tl.x},${tl.y}] → [${br.x},${br.y}]`)
  }
  if (state.waypointXs.length)
    s += rowHTML(`waypoints (${state.waypointXs.length})`, state.waypointXs.join(', '))

  s += '<hr style="border-color:#333;margin:8px 0">'
  state.mobCrops.forEach((m, i) => {
    s += `<div class="state-row"><span class="key">${m.name}</span> ${fmt(m.rect)} <button onclick="window.__setName(${i})" style="font-size:11px;padding:2px 6px">rename</button> <button onclick="window.__setPlayer(${i})" style="font-size:11px;padding:2px 6px">${m.name === '_player' ? 'unmark' : 'set as player'}</button> <button onclick="window.__remove(${i})" style="font-size:11px;padding:2px 6px">×</button></div>`
  })
  return s
}

function rowHTML(key, val) {
  return `<div class="state-row"><span class="key">${key}</span>: ${val}</div>`
}

window.__setName = (i) => {
  const newName = prompt('Sprite name (e.g. green_mushroom):', state.mobCrops[i].name)
  if (newName) {
    state.mobCrops[i].name = newName
    redraw()
    updateUI()
  }
}
window.__setPlayer = (i) => {
  if (state.mobCrops[i].name === '_player') {
    state.mobCrops[i].name = `mob${i + 1}`
  } else {
    state.mobCrops.forEach((m) => {
      if (m.name === '_player') m.name = `mob_${state.mobCrops.indexOf(m) + 1}`
    })
    state.mobCrops[i].name = '_player'
  }
  redraw()
  updateUI()
}
window.__remove = (i) => {
  state.mobCrops.splice(i, 1)
  redraw()
  updateUI()
}

function canSave() {
  if (
    !state.regions.hp ||
    !state.regions.mp ||
    !state.regions.minimap ||
    !state.playerDotAt ||
    !state.bounds ||
    !state.bounds.bottomRight ||
    state.waypointXs.length < 2 ||
    state.mobCrops.length === 0
  ) {
    return false
  }
  return true
}

// ── Buttons ──────────────────────────────────────────────────────────────
btnBack.addEventListener('click', () => {
  if (state.stepIdx > 0) state.stepIdx--
  if (STEPS[state.stepIdx].id === 'minimap-points') state.pointPhase = 0
  redraw()
  updateUI()
})
btnNext.addEventListener('click', () => {
  if (state.stepIdx < STEPS.length - 1) state.stepIdx++
  redraw()
  updateUI()
})
btnClear.addEventListener('click', () => {
  const step = STEPS[state.stepIdx]
  if (step.mode === 'rect') {
    if (step.id === 'window') state.gameWindow = null
    else state.regions[step.id] = null
  } else if (step.mode === 'multi-rect') {
    state.mobCrops.pop()
  } else if (step.mode === 'points') {
    if (state.pointPhase >= 3 && state.waypointXs.length) {
      state.waypointXs.pop()
      state.pointPhase--
    } else if (state.pointPhase === 2) {
      state.bounds.topLeft = null
      state.pointPhase = 1
    } else if (state.pointPhase === 1) {
      state.playerDotAt = null
      state.playerDotRgb = null
      state.pointPhase = 0
    }
  }
  redraw()
  updateUI()
})

btnZoomIn?.addEventListener('click', () => {
  setZoom(state.zoom * 1.5)
  redraw()
  updateCursorReadout()
})
btnZoomOut?.addEventListener('click', () => {
  setZoom(state.zoom / 1.5)
  redraw()
  updateCursorReadout()
})
btnZoomFit?.addEventListener('click', () => {
  fitToWindow()
  redraw()
  updateCursorReadout()
})
btnZoom1?.addEventListener('click', () => {
  // 1:1 — center on current cursor
  const cx = cv.width / 2
  const cy = cv.height / 2
  const before = canvasToImage(cx, cy)
  setZoom(1)
  state.panX = before.x - cx / state.zoom
  state.panY = before.y - cy / state.zoom
  redraw()
  updateCursorReadout()
})

// Keyboard shortcuts: + / - to zoom, 0 to fit, 1 to 100%, space = hand tool.
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return
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
    updateCursorReadout()
  } else if (e.key === '-' || e.key === '_') {
    setZoom(state.zoom / 1.5)
    redraw()
    updateCursorReadout()
  } else if (e.key === '0') {
    fitToWindow()
    redraw()
    updateCursorReadout()
  } else if (e.key === '1') {
    setZoom(1)
    redraw()
    updateCursorReadout()
  }
})

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    state.spaceHeld = false
    cv.style.cursor = state.handTool ? 'grab' : 'crosshair'
  }
})

btnHand?.addEventListener('click', () => {
  state.handTool = !state.handTool
  btnHand.classList.toggle('active', state.handTool)
  cv.style.cursor = state.handTool ? 'grab' : 'crosshair'
})

btnSave.addEventListener('click', async () => {
  const playerEntry = state.mobCrops.find((m) => m.name === '_player')
  const mobs = state.mobCrops.filter((m) => m.name !== '_player')

  const body = {
    windowTitle: state.windowTitle,
    gameWindow: state.gameWindow ?? undefined,
    regions: state.regions,
    playerDotAt: state.playerDotAt,
    bounds: state.bounds,
    waypointXs: state.waypointXs,
    mobCrops: mobs,
    playerCrop: playerEntry?.rect,
  }
  btnSave.disabled = true
  btnSave.textContent = 'Saving…'
  try {
    const resp = await fetch('/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await resp.json()
    if (!data.ok) {
      alert('Save failed: ' + data.error)
      btnSave.disabled = false
      btnSave.textContent = 'Save'
      return
    }
    document.body.innerHTML = `
      <div style="padding:48px;text-align:center;font-family:sans-serif">
        <h1 style="color:#4a8">✓ Calibration saved</h1>
        <p>routine: <code>${data.routinePath}</code></p>
        <p>templates dir: <code>${data.templatesDir}</code></p>
        <p>${data.templatesWritten} template variants written.</p>
        ${data.warnings && data.warnings.length ? `<p style="color:#ffa">warnings: ${data.warnings.join('; ')}</p>` : ''}
        <p>You can close this window. The CLI will exit.</p>
      </div>`
  } catch (err) {
    alert('Save failed: ' + err.message)
    btnSave.disabled = false
    btnSave.textContent = 'Save'
  }
})

btnCancel.addEventListener('click', async () => {
  if (!confirm('Cancel calibration? Nothing will be written.')) return
  await fetch('/cancel', { method: 'POST' })
  document.body.innerHTML =
    '<div style="padding:48px;text-align:center;font-family:sans-serif"><h1>Cancelled</h1><p>You can close this window.</p></div>'
})
