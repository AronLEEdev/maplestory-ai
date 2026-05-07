// CoreML inference wrapper. Loads a .mlpackage, runs predictions on
// the Neural Engine via MLComputeUnits.all. Exposes the model's
// declared input/output schema so task 5 (preprocess) and task 6
// (postprocess) can match shapes precisely.
//
// We use raw MLModel rather than Vision Framework so we can hand the
// model a pre-letterboxed CVPixelBuffer or float-CHW MLMultiArray
// directly — Vision's auto-preprocess insists on its own scale modes
// which don't match Ultralytics' letterbox.
import Foundation
import CoreML
import CoreVideo

enum InferenceError: Error, CustomStringConvertible {
  case loadFailed(String)
  case missingInput(String)
  case missingOutput(String)
  case predictFailed(String)
  var description: String {
    switch self {
    case .loadFailed(let r): return "model load failed: \(r)"
    case .missingInput(let n): return "model has no input named '\(n)'"
    case .missingOutput(let n): return "model has no output named '\(n)'"
    case .predictFailed(let r): return "predict failed: \(r)"
    }
  }
}

/// Minimal description of the model's I/O shape; logged on load so we
/// can spot mismatches between trained model and sidecar code.
struct ModelSchema {
  let inputName: String
  let inputShape: [Int]
  let inputType: String
  let outputName: String
  let outputShape: [Int]
  let outputType: String
}

final class Inference {
  let model: MLModel
  let schema: ModelSchema

  init(modelPath: String) throws {
    let inputUrl = URL(fileURLWithPath: modelPath)
    // .mlpackage / .mlmodel must be compiled to .mlmodelc before MLModel
    // can load it. Compile on first run, cache the compiled artifact next
    // to the source so subsequent runs skip the ~1-2s compile step.
    let compiledUrl = try Inference.ensureCompiled(inputUrl)
    let config = MLModelConfiguration()
    // .all = let CoreML pick CPU/GPU/Neural Engine per layer. On M4 with
    // a YOLOv8n .mlpackage exported by Ultralytics, the conv stack lands
    // on the NE; fallback layers (some reshape/concat ops) stay on GPU.
    config.computeUnits = .all
    let m: MLModel
    do {
      m = try MLModel(contentsOf: compiledUrl, configuration: config)
    } catch {
      throw InferenceError.loadFailed("\(error)")
    }
    self.model = m
    self.schema = Inference.extractSchema(m)
    FileHandle.standardError.write(
      "inference: loaded \(compiledUrl.lastPathComponent)\n".data(using: .utf8)!
    )
  }

  /// If `url` already points at a .mlmodelc, return as-is. Otherwise
  /// compile (.mlpackage / .mlmodel → .mlmodelc) and cache the result
  /// adjacent to the source.
  private static func ensureCompiled(_ url: URL) throws -> URL {
    if url.pathExtension == "mlmodelc" { return url }
    // Cache path: data/models/henesys.mlpackage → data/models/henesys.mlmodelc
    let cacheUrl = url
      .deletingPathExtension()
      .appendingPathExtension("mlmodelc")
    let fm = FileManager.default
    if fm.fileExists(atPath: cacheUrl.path) {
      // Recompile if source is newer than cache.
      if let srcMTime = try? fm.attributesOfItem(atPath: url.path)[.modificationDate] as? Date,
         let cacheMTime = try? fm.attributesOfItem(atPath: cacheUrl.path)[.modificationDate] as? Date,
         srcMTime <= cacheMTime {
        return cacheUrl
      }
      // Stale: remove + recompile.
      try? fm.removeItem(at: cacheUrl)
    }
    FileHandle.standardError.write(
      "inference: compiling \(url.lastPathComponent) → \(cacheUrl.lastPathComponent)…\n".data(using: .utf8)!
    )
    let compiled: URL
    do {
      compiled = try MLModel.compileModel(at: url)
    } catch {
      throw InferenceError.loadFailed("compile failed: \(error)")
    }
    do {
      try fm.moveItem(at: compiled, to: cacheUrl)
    } catch {
      // Compile output ends up in NSTemporaryDirectory; if move fails fall
      // through and use it directly.
      return compiled
    }
    return cacheUrl
  }

  /// Run prediction. Caller is responsible for feeding the right input
  /// type (CVPixelBuffer or MLMultiArray) under the input feature name
  /// reported in `schema.inputName`.
  func predict(_ input: MLFeatureProvider) throws -> MLFeatureProvider {
    do {
      return try model.prediction(from: input)
    } catch {
      throw InferenceError.predictFailed("\(error)")
    }
  }

  // MARK: - Internals

  private static func extractSchema(_ m: MLModel) -> ModelSchema {
    let inDesc = m.modelDescription.inputDescriptionsByName.first
    let outDesc = m.modelDescription.outputDescriptionsByName.first
    return ModelSchema(
      inputName: inDesc?.key ?? "<unknown>",
      inputShape: featureShape(inDesc?.value),
      inputType: featureType(inDesc?.value),
      outputName: outDesc?.key ?? "<unknown>",
      outputShape: featureShape(outDesc?.value),
      outputType: featureType(outDesc?.value)
    )
  }

  private static func featureShape(_ d: MLFeatureDescription?) -> [Int] {
    guard let d = d else { return [] }
    if let img = d.imageConstraint {
      return [Int(truncatingIfNeeded: img.pixelsWide), Int(truncatingIfNeeded: img.pixelsHigh)]
    }
    if let arr = d.multiArrayConstraint {
      return arr.shape.map { $0.intValue }
    }
    return []
  }

  private static func featureType(_ d: MLFeatureDescription?) -> String {
    guard let d = d else { return "?" }
    switch d.type {
    case .image: return "image"
    case .multiArray: return "multiArray"
    case .double: return "double"
    case .int64: return "int64"
    case .string: return "string"
    case .dictionary: return "dictionary"
    case .sequence: return "sequence"
    case .invalid: return "invalid"
    case .state: return "state"
    @unknown default: return "unknown(\(d.type.rawValue))"
    }
  }
}
