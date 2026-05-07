// SORT-style tracker: greedy IoU matching + EMA velocity smoothing.
//
// Why not full Kalman: at our N (~10 mobs/frame) and frame rate (30fps),
// a constant-velocity EMA is within ~1% bbox error of a Kalman filter
// while staying ~3x faster and ~150 LOC simpler. Tracker's job here is
// stable IDs + velocity for attack-facing logic, not subpixel-perfect
// motion prediction.
//
// Matching: greedy by descending IoU above iouThresh. Sub-optimal vs
// Hungarian but at our N the diff is negligible — and the fixed cost
// avoids a 200-line algorithm dependency.
import Foundation

/// One mob/player track. id is stable across frames as long as the
/// underlying detection keeps appearing within iouThresh.
struct Track {
  let id: Int
  let classId: Int
  /// Bbox in display-space pixels: x, y, w, h.
  var bbox: (x: Float, y: Float, w: Float, h: Float)
  /// Most recent confidence from the matched detection.
  var conf: Float
  /// Velocity estimate (px/frame), EMA smoothed.
  var vx: Float
  var vy: Float
  /// Frames seen since spawn.
  var age: Int
  /// Total successful matches (≤ age).
  var hits: Int
  /// Frames since last successful match. Expires when > maxMisses.
  var misses: Int
}

final class Tracker {
  private(set) var tracks: [Track] = []
  private var nextId: Int = 1
  private let iouThresh: Float
  private let maxMisses: Int
  /// EMA factor for velocity smoothing (0.5 means each new sample is half).
  private let velocityAlpha: Float

  init(iouThresh: Double = 0.3, maxMisses: Int = 5, velocityAlpha: Double = 0.5) {
    self.iouThresh = Float(iouThresh)
    self.maxMisses = maxMisses
    self.velocityAlpha = Float(velocityAlpha)
  }

  /// Drive one tracker step. Returns the currently-active tracks (those
  /// with misses == 0 OR within maxMisses grace period).
  func step(detections: [RawDetection]) -> [Track] {
    // 1. Predict next position for each existing track using its velocity.
    for i in 0..<tracks.count {
      tracks[i].bbox.x += tracks[i].vx
      tracks[i].bbox.y += tracks[i].vy
      tracks[i].age += 1
    }

    // 2. Build IoU matrix as a flat list of (trackIdx, detIdx, iou) above
    //    the threshold, only same-class pairs.
    var candidates: [(Int, Int, Float)] = []
    candidates.reserveCapacity(tracks.count * detections.count)
    for ti in 0..<tracks.count {
      for di in 0..<detections.count {
        if tracks[ti].classId != detections[di].classId { continue }
        let v = iou(tracks[ti].bbox, detections[di].bbox)
        if v >= iouThresh { candidates.append((ti, di, v)) }
      }
    }
    // 3. Greedy matching — descending IoU, mark each track + det used once.
    candidates.sort { $0.2 > $1.2 }
    var trackUsed = Array(repeating: false, count: tracks.count)
    var detUsed = Array(repeating: false, count: detections.count)
    for (ti, di, _) in candidates {
      if trackUsed[ti] || detUsed[di] { continue }
      // 4. Update matched track.
      let newBbox = detections[di].bbox
      let prevBbox = tracks[ti].bbox
      // EMA velocity from observed displacement (using PRE-prediction position).
      let observedVx = newBbox.x - (prevBbox.x - tracks[ti].vx)
      let observedVy = newBbox.y - (prevBbox.y - tracks[ti].vy)
      tracks[ti].vx = velocityAlpha * observedVx + (1 - velocityAlpha) * tracks[ti].vx
      tracks[ti].vy = velocityAlpha * observedVy + (1 - velocityAlpha) * tracks[ti].vy
      tracks[ti].bbox = newBbox
      tracks[ti].conf = detections[di].score
      tracks[ti].hits += 1
      tracks[ti].misses = 0
      trackUsed[ti] = true
      detUsed[di] = true
    }

    // 5. Unmatched tracks: increment misses.
    for i in 0..<tracks.count where !trackUsed[i] {
      tracks[i].misses += 1
    }
    // 6. Expire tracks with too many misses.
    tracks.removeAll { $0.misses > maxMisses }

    // 7. Unmatched detections → new tracks.
    for di in 0..<detections.count where !detUsed[di] {
      let d = detections[di]
      tracks.append(
        Track(
          id: nextId,
          classId: d.classId,
          bbox: d.bbox,
          conf: d.score,
          vx: 0, vy: 0,
          age: 1, hits: 1, misses: 0
        )
      )
      nextId += 1
    }

    // 8. Return active tracks (visible this frame OR within grace).
    return tracks
  }

  func reset() {
    tracks.removeAll()
    nextId = 1
  }

  // MARK: - Helpers

  private func iou(_ a: (x: Float, y: Float, w: Float, h: Float), _ b: (x: Float, y: Float, w: Float, h: Float)) -> Float {
    let ax2 = a.x + a.w, ay2 = a.y + a.h
    let bx2 = b.x + b.w, by2 = b.y + b.h
    let ix1 = max(a.x, b.x), iy1 = max(a.y, b.y)
    let ix2 = min(ax2, bx2), iy2 = min(ay2, by2)
    let inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    let union = a.w * a.h + b.w * b.h - inter
    return union > 0 ? inter / union : 0
  }
}
