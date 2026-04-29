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
  gameWindow: null, // Rect
  regions: { hp: null, mp: null, minimap: null },
  playerDotAt: null, // {x,y}
  playerDotRgb: null, // [r,g,b]
  bounds: null, // {topLeft, bottomRight} minimap-LOCAL
  waypointXs: [], // minimap-LOCAL x values
  mobCrops: [], // [{name, rect}]
  playerCrop: null,
  // canvas state
  img: null,
  imgScale: 1,
  pointPhase: 0, // 0=player, 1=boundsTL, 2=boundsBR, 3+=waypoints
}

const cv = document.getElementById('cv')
const ctx = cv.getContext('2d')
const instrText = document.getElementById('instr-text')
const instrHint = document.getElementById('instr-hint')
const stepIndicator = document.getElementById('step-indicator')
const stateList = document.getElementById('state-list')
const btnBack = document.getElementById('btn-back')
const btnNext = document.getElementById('btn-next')
const btnClear = document.getElementById('btn-clear')
const btnSave = document.getElementById('btn-save')
const btnCancel = document.getElementById('btn-cancel')

// ── Bootstrap: load the screenshot ───────────────────────────────────────
const img = new Image()
img.onload = () => {
  state.img = img
  // Fit-to-window: scale image so it fits within ~80% viewport, but never
  // up-scale beyond 1:1.
  const maxW = window.innerWidth - 360
  const maxH = window.innerHeight - 280
  const fitScale = Math.min(maxW / img.width, maxH / img.height, 1)
  state.imgScale = fitScale
  cv.width = img.width * fitScale
  cv.height = img.height * fitScale
  redraw()
  updateUI()
}
img.src = '/screenshot.png'

// ── Mouse handling ───────────────────────────────────────────────────────
let drag = null // {startX, startY, currX, currY}
cv.addEventListener('mousedown', (e) => {
  const step = STEPS[state.stepIdx]
  if (step.mode === 'rect' || step.mode === 'multi-rect') {
    const { x, y } = canvasCoords(e)
    drag = { startX: x, startY: y, currX: x, currY: y }
  }
})
cv.addEventListener('mousemove', (e) => {
  if (!drag) return
  const { x, y } = canvasCoords(e)
  drag.currX = x
  drag.currY = y
  redraw()
})
cv.addEventListener('mouseup', () => {
  if (!drag) return
  const rect = dragToImageRect(drag)
  drag = null
  if (rect.w < 4 || rect.h < 4) {
    redraw()
    return
  }
  const step = STEPS[state.stepIdx]
  if (step.mode === 'rect') {
    setStepRect(step.id, rect)
  } else if (step.mode === 'multi-rect') {
    addMultiRect(rect)
  }
  redraw()
  updateUI()
})

// Single click for points-mode (Step 5).
cv.addEventListener('click', async (e) => {
  const step = STEPS[state.stepIdx]
  if (step.mode !== 'points') return
  const { x, y } = canvasCoords(e)
  const ix = Math.round(x / state.imgScale)
  const iy = Math.round(y / state.imgScale)
  await registerPoint(ix, iy)
  redraw()
  updateUI()
})

function canvasCoords(e) {
  const r = cv.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top }
}

function dragToImageRect(d) {
  const sx = Math.min(d.startX, d.currX)
  const sy = Math.min(d.startY, d.currY)
  const ex = Math.max(d.startX, d.currX)
  const ey = Math.max(d.startY, d.currY)
  return {
    x: Math.round(sx / state.imgScale),
    y: Math.round(sy / state.imgScale),
    w: Math.round((ex - sx) / state.imgScale),
    h: Math.round((ey - sy) / state.imgScale),
  }
}

// ── Step helpers ─────────────────────────────────────────────────────────
function setStepRect(id, rect) {
  if (id === 'window') state.gameWindow = rect
  else if (id === 'hp') state.regions.hp = rect
  else if (id === 'mp') state.regions.mp = rect
  else if (id === 'minimap') state.regions.minimap = rect
}

function addMultiRect(rect) {
  // Step 6 — sprites. Default each to mob, but treat the FIRST rect with a
  // specific name 'player' as the player crop. For simplicity we let the
  // user click "set as player" via the state list. By default everything is
  // a mob.
  const idx = state.mobCrops.length
  state.mobCrops.push({ name: `mob${idx + 1}`, rect })
}

async function registerPoint(ix, iy) {
  const minimap = state.regions.minimap
  if (!minimap) {
    alert('Step 5 needs the minimap region first. Go back to Step 4.')
    return
  }
  // Local coords inside the minimap region.
  const lx = ix - minimap.x
  const ly = iy - minimap.y
  if (state.pointPhase === 0) {
    // Player dot click — sample color from the server.
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

// ── Render ───────────────────────────────────────────────────────────────
function redraw() {
  if (!state.img) return
  ctx.clearRect(0, 0, cv.width, cv.height)
  ctx.drawImage(state.img, 0, 0, cv.width, cv.height)

  // Draw all known rectangles.
  drawRect(state.gameWindow, '#5af', '1 win')
  drawRect(state.regions.hp, '#f57', '2 hp')
  drawRect(state.regions.mp, '#5cf', '3 mp')
  drawRect(state.regions.minimap, '#fa5', '4 mini')

  // Multi-rects (mobs / player).
  for (const m of state.mobCrops) {
    drawRect(m.rect, m.name === '_player' ? '#fa3' : '#7c5', m.name)
  }
  if (state.playerCrop) drawRect(state.playerCrop, '#fa3', 'player')

  // Step 5 — points.
  if (state.playerDotAt) {
    drawDot(state.playerDotAt.x, state.playerDotAt.y, '#fa5', 'dot')
  }
  if (state.bounds && state.regions.minimap) {
    const mm = state.regions.minimap
    if (state.bounds.topLeft) {
      drawDot(mm.x + state.bounds.topLeft.x, mm.y + state.bounds.topLeft.y, '#5af', 'TL')
    }
    if (state.bounds.bottomRight) {
      drawDot(mm.x + state.bounds.bottomRight.x, mm.y + state.bounds.bottomRight.y, '#5af', 'BR')
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

  // Live drag rect.
  if (drag) {
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.setLineDash([4, 4])
    ctx.strokeRect(
      Math.min(drag.startX, drag.currX),
      Math.min(drag.startY, drag.currY),
      Math.abs(drag.currX - drag.startX),
      Math.abs(drag.currY - drag.startY),
    )
    ctx.setLineDash([])
  }
}

function drawRect(rect, color, label) {
  if (!rect) return
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.strokeRect(
    rect.x * state.imgScale,
    rect.y * state.imgScale,
    rect.w * state.imgScale,
    rect.h * state.imgScale,
  )
  ctx.fillStyle = color
  ctx.font = '12px ui-monospace'
  ctx.fillText(label, rect.x * state.imgScale + 4, rect.y * state.imgScale - 2)
}

function drawDot(ix, iy, color, label) {
  const cx = ix * state.imgScale
  const cy = iy * state.imgScale
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(cx, cy, 5, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = color
  ctx.font = '11px ui-monospace'
  ctx.fillText(label, cx + 8, cy + 4)
}

// ── UI updates ───────────────────────────────────────────────────────────
function updateUI() {
  const step = STEPS[state.stepIdx]
  // step indicator
  stepIndicator.innerHTML = STEPS.map((s, i) => {
    const cls = i < state.stepIdx ? 'done' : i === state.stepIdx ? 'active' : ''
    return `<span class="step ${cls}">${s.label}</span>`
  }).join('')

  // instructions
  if (step.id === 'window') {
    instrText.textContent = 'Drag a rectangle around the entire Maplestory game window.'
    instrHint.textContent = 'Tells the bot the screen area to focus on. Re-run if you move the window.'
  } else if (step.id === 'hp') {
    instrText.textContent = 'Drag tightly around the HP bar (the colored fill area, not the text label).'
    instrHint.textContent = 'Used to detect HP %. Tighter = better signal.'
  } else if (step.id === 'mp') {
    instrText.textContent = 'Drag tightly around the MP bar.'
    instrHint.textContent = 'Same idea — bar only, no text.'
  } else if (step.id === 'minimap') {
    instrText.textContent = 'Drag a rectangle around the entire minimap.'
    instrHint.textContent = 'Click should encompass the playable map area shown in the minimap.'
  } else if (step.id === 'minimap-points') {
    if (state.pointPhase === 0) {
      instrText.textContent = 'Click the player dot on the minimap.'
      instrHint.textContent = 'The bright dot that represents your character. Color is sampled live.'
    } else if (state.pointPhase === 1) {
      instrText.textContent = 'Click the TOP-LEFT corner of the patrol area on the minimap.'
      instrHint.textContent = 'Where the platform you grind on starts.'
    } else if (state.pointPhase === 2) {
      instrText.textContent = 'Click the BOTTOM-RIGHT corner of the patrol area on the minimap.'
      instrHint.textContent = 'Closes the bounding box.'
    } else {
      instrText.textContent = `Click waypoint ${state.waypointXs.length + 1} (or press Next when done — need at least 2).`
      instrHint.textContent = 'Each click adds a x-coordinate the bot will walk to.'
    }
  } else if (step.id === 'mobs') {
    instrText.textContent = 'Drag rectangles around mob sprites (and optionally one over your character).'
    instrHint.textContent = 'Tight crops. Click "set as player" in the panel to mark a sprite as your character.'
  }

  // state panel
  stateList.innerHTML = renderStateList()

  // buttons
  btnBack.disabled = state.stepIdx === 0
  btnSave.disabled = !canSave()
}

function renderStateList() {
  const fmt = (r) => (r ? `[${r.x}, ${r.y}, ${r.w}x${r.h}]` : '<span class="empty">unset</span>')
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
  // Mark this crop as the player template, others as mobs.
  if (state.mobCrops[i].name === '_player') {
    state.mobCrops[i].name = `mob${i + 1}`
  } else {
    // unmark any existing player
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

btnSave.addEventListener('click', async () => {
  // Find the player crop, if any was marked.
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
